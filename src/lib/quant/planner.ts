import { db } from "@/db";
import { forecasts, hypotheses, learningWeights } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { CATEGORY_DEFINITIONS, type CategoryKey, type GeneratedCombination, type MarketRegime, type OKXCandle } from "../types";
import { callProvider } from "../ai/provider";
import { resolveProvidersFromSettings } from "../ai/settings";
import type {
  PlannerArmStats,
  PlannerAuthority,
  PlannerDecisionRow,
  PlannerPickRow,
  PlannerRecordRow,
} from "../ui-types";
import type { SelectionPolicyState } from "./policy";

/**
 * ПЛАНИРОВЩИК ЦИКЛА — здесь решается, сколько гипотез оформлять и какие.
 *
 * Раньше это был человеческий ползунок: «до 40 гипотез за цикл», и цикл ровно
 * набивал слоты по EVS. На бумажных деньгах такой стимул разрушителен: объём
 * ставок не награждается, а каждая шумная гипотеза портит калибровку и память.
 * Поэтому количество и состав — решение модели, а не квота.
 *
 * Что остаётся детерминированным (это физика, а не вкус):
 *   — Candidate приходит только с живых данных этого актива;
 *   — модель выбирает ИЗ предложенного списка, выдуманные коды отбрасываются;
 *   — страховочный потолок записей за цикл.
 *
 * И главное: решение модели само становится объектом эксперимента. Каждая
 * гипотеза несёт mode + conviction, исходы измеряются отдельно для «ai» и
 * «rule» — если модель выбирает хуже правила, это видно на экране.
 */

export interface PoolItem extends GeneratedCombination {
  asset: string;
  assetLive: boolean;
  assetRegime: MarketRegime;
}

export interface SignatureRecord {
  n: number;
  hits: number;
  hitRate: number;
  expectancyBps: number;
}

/**
 * Реальная физика исхода. Outcome-evaluator засчитывает hit только если за 15 минут
 * был ход в сторону сигнала ≥ OUTCOME_BAR_BPS И финальная доходность выше
 * издержек. Порог не зависит от актива — а волатильность актива зависит. Без этой
 * пары чисел решение «брать или нет» превращается в гадание: на тихом активе бар
 * недоступен (miss machine), на шумном — тривиален (hit без информации).
 */
export const OUTCOME_BAR_BPS = 35;

export interface AssetMoveStats {
  /** медиана |Δclose| за один 15-минутный интервал, bps */
  medAbsBps: number;
  /** доля интервалов, где |Δ| ≥ бара исхода, % */
  reachPct: number;
  /** сколько интервалов реально посмотрели */
  n: number;
}

/** Оценка достижимости бара по свежим свечам актива. Тихий рынок → честное «недоступно». */
export function computeMoveStats(candles: OKXCandle[]): AssetMoveStats | null {
  if (candles.length < 6) return null;
  const moves: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    if (!prev || prev <= 0) continue;
    moves.push((Math.abs(candles[i].close - prev) / prev) * 10000);
  }
  if (moves.length < 5) return null;
  const sorted = [...moves].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const over = moves.filter((m) => m >= OUTCOME_BAR_BPS).length;
  return { medAbsBps: Math.round(med), reachPct: Math.round((over / moves.length) * 100), n: moves.length };
}

export interface PlannerCandidate {
  code: string;
  asset: string;
  categories: CategoryKey[];
  catsRu: string[];
  catsShort: string[];
  operator: string;
  direction: string;
  evs: number;
  breakdown: Record<string, number>;
  sampleSize: number;
  regime: string;
  signature: string;
  prior: SignatureRecord | null;
  move: AssetMoveStats | null;
}

export interface ModelFacts {
  resolved: number;
  hitRate: number;
  brier: number;
  expectancyBps: number;
  pending: number;
}

export interface PlanInput {
  candidates: PlannerCandidate[];
  policy: SelectionPolicyState;
  facts: ModelFacts;
  weightsTop: { ru: string; w: number; wr: number; n: number }[];
  weightsLow: { ru: string; w: number; wr: number; n: number }[];
  record: PlannerRecordRow;
  universeNote: string;
  /** Общий бюджет времени на цепочку провайдеров: после него — fallback */
  deadlineMs?: number;
}

const catRu = (c: string) => CATEGORY_DEFINITIONS[c as CategoryKey]?.labelRu ?? c.replace(/_/g, " ");

/** Короткие имена категорий для промпта: 15 полных названий съедают бюджет latency. */
const CAT_SHORT_RU: Record<string, string> = {
  price_returns: "цена",
  volume_liquidity: "объём",
  volatility_regime: "волат",
  order_flow: "поток",
  order_book_microstructure: "стакан",
  derivatives_positioning: "дерив",
  liquidations: "ликвид-ции",
  cross_exchange_dispersion: "дисперсия",
  cross_asset_relationships: "межассет",
  market_breadth_rotation: "ширина",
  stablecoin_flow_proxies: "стейбл-флоу",
  on_chain_activity: "ончейн",
  sentiment_attention: "сентимент",
  time_calendar_session: "сессия",
  anomaly_novelty: "аномалия",
};

const catShort = (c: string) => CAT_SHORT_RU[c] ?? c.slice(0, 8);

export function signatureOf(
  asset: string,
  categories: readonly string[],
  direction: string,
  parameters: { lookback?: number; threshold?: number }
): string {
  const cats = [...categories].sort().join("+");
  return `${asset}|${cats}|${direction}|lb${parameters.lookback ?? 0}-th${parameters.threshold ?? 0}`;
}

/* ------------------------- история подписей (приор кандидата) ------------------------- */

type HypothesisSigRow = {
  asset: string;
  categoriesJson: unknown;
  direction: string;
  parameterSetId: string;
};

/** Подпись записанной гипотезы — тем же алгоритмом, что и у кандидата. */
export function signatureFromHypothesis(h: HypothesisSigRow): string {
  const cats = Array.isArray(h.categoriesJson) ? (h.categoriesJson as string[]) : [];
  const lb = Number(h.parameterSetId.match(/lb([\d.]+)/)?.[1] ?? "0");
  const th = Number(h.parameterSetId.match(/th([\d.]+)/)?.[1] ?? "0");
  return signatureOf(h.asset, cats, h.direction === "RANGE" ? "NEUTRAL" : h.direction, { lookback: lb, threshold: th });
}

/**
 * Чем эта связка уже заканчивала на этом активе. Ключ — актив + набор категорий +
 * направление + сетка параметров, то же самое, что записано в гипотезах.
 */
export async function loadSignatureHistory(): Promise<Map<string, SignatureRecord>> {
  const map = new Map<string, { n: number; h: number; ret: number }>();
  try {
    const fc = await db
      .select({
        hypothesisId: forecasts.hypothesisId,
        outcome: forecasts.outcome,
        ret: forecasts.realizedReturnNet,
      })
      .from(forecasts)
      .where(eq(forecasts.status, "resolved"))
      .orderBy(desc(forecasts.createdAt))
      .limit(4000);
    const hyp = await db
      .select({
        id: hypotheses.id,
        asset: hypotheses.asset,
        categoriesJson: hypotheses.categoriesJson,
        direction: hypotheses.direction,
        parameterSetId: hypotheses.parameterSetId,
      })
      .from(hypotheses)
      .orderBy(desc(hypotheses.createdAt))
      .limit(4000);

    const byId = new Map(hyp.map((h) => [h.id, h]));
    for (const f of fc) {
      if (!f.hypothesisId) continue;
      if (f.outcome !== "hit" && f.outcome !== "miss") continue;
      const h = byId.get(f.hypothesisId);
      if (!h) continue;
      const key = signatureFromHypothesis(h);
      const rec = map.get(key) ?? { n: 0, h: 0, ret: 0 };
      rec.n++;
      if (f.outcome === "hit") rec.h++;
      rec.ret += (f.ret ?? 0) * 100;
      map.set(key, rec);
    }
  } catch {
    /* история не критична: без неё кандидаты просто придут без приора */
  }
  return new Map(
    [...map.entries()].map(([k, v]) => [
      k,
      { n: v.n, hits: v.h, hitRate: v.n ? (v.h / v.n) * 100 : 0, expectancyBps: v.n ? v.ret / v.n : 0 },
    ])
  );
}

/**
 * Числа, без которых решение «сколько брать» было бы гаданием: где модель
 * сейчас по качеству и сколько прогнозов уже в работе.
 */
export async function loadModelFacts(pendingCount: number): Promise<ModelFacts> {
  let resolved = 0;
  let hits = 0;
  let ret = 0;
  let brier = 0.25;
  try {
    const fc = await db
      .select({ outcome: forecasts.outcome, ret: forecasts.realizedReturnNet })
      .from(forecasts)
      .where(eq(forecasts.status, "resolved"));
    for (const f of fc) {
      if (f.outcome !== "hit" && f.outcome !== "miss") continue;
      resolved++;
      ret += f.ret ?? 0;
      if (f.outcome === "hit") hits++;
    }
    const w = await db
      .select({ brierScore: learningWeights.brierScore })
      .from(learningWeights);
    if (w.length > 0) brier = w.reduce((a, x) => a + x.brierScore, 0) / w.length;
  } catch {
    /* пустая база — факты нулевые, модель обязана сама учесть это в решении */
  }
  return {
    resolved,
    hitRate: resolved ? (hits / resolved) * 100 : 0,
    brier,
    expectancyBps: resolved ? (ret / resolved) * 100 : 0,
    pending: pendingCount,
  };
}

/** Взвешенные категории одним взглядом: модель обязана знать, чему она доверяет. */
export async function loadWeightViews(): Promise<{
  weightsTop: { ru: string; w: number; wr: number; n: number }[];
  weightsLow: { ru: string; w: number; wr: number; n: number }[];
}> {
  try {
    const w = await db
      .select({
        categoryName: learningWeights.categoryName,
        currentWeight: learningWeights.currentWeight,
        empiricalWinrate: learningWeights.empiricalWinrate,
        totalSamples: learningWeights.totalSamples,
      })
      .from(learningWeights);
    const sorted = [...w].sort((a, b) => b.currentWeight - a.currentWeight);
    const mapW = (x: (typeof w)[number]) => ({
      ru: CATEGORY_DEFINITIONS[x.categoryName as CategoryKey]?.labelRu ?? x.categoryName,
      w: x.currentWeight,
      wr: x.empiricalWinrate,
      n: x.totalSamples,
    });
    return { weightsTop: sorted.slice(0, 5).map(mapW), weightsLow: sorted.slice(-4).map(mapW) };
  } catch {
    return { weightsTop: [], weightsLow: [] };
  }
}

/** Исходы решений по каждой политике отбора — «а кто вообще выбирает лучше». */
export async function loadSelectionRecord(): Promise<PlannerRecordRow> {
  // Запасный порядок — это тоже правило (просто без модели), поэтому его исходы
  // идут в армию «rule»: сравнение всегда «модель против детерминизма».
  const arms: Record<"ai" | "rule", { n: number; h: number; c: number; ret: number }> = {
    ai: { n: 0, h: 0, c: 0, ret: 0 },
    rule: { n: 0, h: 0, c: 0, ret: 0 },
  };
  try {
    const fc = await db
      .select({ hypothesisId: forecasts.hypothesisId, outcome: forecasts.outcome, ret: forecasts.realizedReturnNet })
      .from(forecasts)
      .where(eq(forecasts.status, "resolved"))
      .orderBy(desc(forecasts.createdAt))
      .limit(4000);
    const hyp = await db
      .select({
        id: hypotheses.id,
        uncertainty: hypotheses.uncertainty,
        scoreComponentsJson: hypotheses.scoreComponentsJson,
      })
      .from(hypotheses)
      .orderBy(desc(hypotheses.createdAt))
      .limit(4000);
    const byId = new Map(hyp.map((h) => [h.id, h]));

    for (const f of fc) {
      if (!f.hypothesisId) continue;
      if (f.outcome !== "hit" && f.outcome !== "miss") continue;
      const h = byId.get(f.hypothesisId);
      if (!h) continue;
      const planner = (h.scoreComponentsJson as { planner?: { mode?: string } } | null)?.planner;
      const a = arms[planner?.mode === "ai" ? "ai" : "rule"];
      a.n++;
      if (f.outcome === "hit") a.h++;
      a.c += 1 - (h.uncertainty ?? 0.35);
      a.ret += (f.ret ?? 0) * 100;
    }
  } catch {
    /* нет истории — значит армы пустые, UI покажет «накопить данные» */
  }
  const to = (a: { n: number; h: number; c: number; ret: number }): PlannerArmStats => ({
    n: a.n,
    hits: a.h,
    hitRate: a.n ? Number(((a.h / a.n) * 100).toFixed(1)) : 0,
    avgConviction: a.n ? Number((a.c / a.n).toFixed(3)) : 0,
    expectancyBps: a.n ? Number((a.ret / a.n).toFixed(1)) : 0,
  });
  return { ai: to(arms.ai), rule: to(arms.rule) };
}

/* ------------------------------- shortlist ------------------------------- */

/**
 * Что мы вообще предлагаем решающему: топ-N связок на живой актив, без тех,
 * что уже стоят в неразрешённом прогнозе с той же подписью.
 */
export function buildShortlist(
  pool: PoolItem[],
  opts: {
    perAsset?: number;
    total?: number;
    excludeSignatures?: Set<string>;
    history?: Map<string, SignatureRecord>;
    moveStats?: Map<string, AssetMoveStats>;
  } = {}
): PlannerCandidate[] {
  const perAsset = opts.perAsset ?? 2;
  const total = opts.total ?? 20;
  const exclude = opts.excludeSignatures ?? new Set<string>();
  const history = opts.history;
  const moveStats = opts.moveStats;

  const byAsset = new Map<string, PoolItem[]>();
  for (const item of pool) {
    if (!item.assetLive) continue;
    if (item.targetDirection === "NEUTRAL") continue; // нет тестируемого направления
    const list = byAsset.get(item.asset) ?? [];
    list.push(item);
    byAsset.set(item.asset, list);
  }

  const out: PlannerCandidate[] = [];
  const seen = new Set<string>();
  for (const [asset, list] of byAsset) {
    list.sort((a, b) => b.earlyValueScore - a.earlyValueScore);
    let taken = 0;
    for (const item of list) {
      if (taken >= perAsset) break;
      const signature = signatureOf(asset, item.categories, item.targetDirection, item.parameters);
      if (exclude.has(signature) || seen.has(signature)) continue;
      seen.add(signature);
      taken++;
      out.push({
        code: item.code,
        asset,
        categories: item.categories,
        catsRu: item.categories.map(catRu),
        catsShort: item.categories.map(catShort),
        operator: item.operator,
        direction: item.targetDirection,
        evs: item.earlyValueScore,
        breakdown: { ...item.breakdown },
        sampleSize: item.sampleSize,
        regime: item.assetRegime,
        signature,
        prior: history?.get(signature) ?? null,
        move: moveStats?.get(asset) ?? null,
      });
    }
  }

  out.sort((a, b) => b.evs - a.evs);
  return out.slice(0, total);
}

/* ------------------------------ prompt & JSON ------------------------------ */

const PLANNER_SYSTEM_PROMPT = `Ты — планировщик автономной квант-лаборатории. Ты ПРИНИМАЕШЬ решение, а не советуешь.
Ответ — РОВНО один JSON-объект, без markdown, без пояснений до и после. Пиши why и narrative по-русски.
Контекст: исполнение бумажное (paper). За количество гипотез никто не платит: шумная гипотеза дороже пустого цикла — она размывает калибровку и память лаборатории.
Ноль выбранных связок — полноценное решение, если ничего не заслуживает теста. Не набирай потолок «для статистики».
Оперируй только числами из контекста. Выбирать можно только коды из списка кандидатов.`;

/**
 * Бюджет планировщика. Замеры на enabled-цепочке: тот же список кандидатов с
 * max_tokens=2048 отвечал 57 с (таймаут), с компактным промптом и коротким
 * бюджетом — 4–20 с. Поэтому токены урезаны, а reasoning опущен до «low».
 */
const PLANNER_MAX_TOKENS = 700;
const PLANNER_DEADLINE_MS = 40000;

/** gpt-oss понимает reasoning_effort; другим провайдерам этот параметр не нужен — риск 400. */
function reasoningEffortFor(model: string): Record<string, unknown> {
  return /gpt-oss/i.test(model) ? { reasoning_effort: "low" } : {};
}

/** Аккуратно вырезаем первый сбалансированный JSON-объект: модели любят добавить прозу. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Пока у подписи меньше этого числа исходов, её история — шум, а не аргумент. */
const MIN_SIGNIFICANT_N = 5;

/**
 * Приор печатается с учётом значимости: «HR 0% при n=1» выглядит как убойный
 * аргумент, хотя это одна монетка. Модель должна видеть «незначима» и решать по
 * живым числам, а не по фантомному минусу к базе, — иначе она воздерживается из-за
 * шума, а не из-за качества связки.
 */
function renderPrior(prior: SignatureRecord | null, baseHitRate: number): string {
  if (!prior) return "истории нет";
  if (prior.n < MIN_SIGNIFICANT_N) {
    return `история ${prior.n}/${MIN_SIGNIFICANT_N} исходов — незначима, решаю живые числа`;
  }
  const delta = prior.hitRate - baseHitRate;
  return `история n=${prior.n} HR ${prior.hitRate.toFixed(0)}% (${delta >= 0 ? "+" : ""}${delta.toFixed(0)}п.п. к базе) ${
    prior.expectancyBps >= 0 ? "+" : ""
  }${prior.expectancyBps.toFixed(0)}bps`;
}

/** Одна строка кандидата — уложиться в пару десятков токенов, latency важнее красок. */
function renderCandidate(c: PlannerCandidate, f: ModelFacts): string {
  const move = c.move
    ? `ход15м медиана ${c.move.medAbsBps}bps, бара ${OUTCOME_BAR_BPS}bps достигает ${c.move.reachPct}% шагов (n=${c.move.n})`
    : "ход актива неизвестен (свечей мало)";
  return `${c.code} · ${c.asset} · EVS ${c.evs} · ${c.direction} · ${c.catsShort.join("+")} · ${c.regime} · n=${c.sampleSize} · согл${c.breakdown.crossAgreement}/20 · ${move} · ${renderPrior(c.prior, f.hitRate)}`;
}

/**
 * Собственный скорборд модели печатается с той же поправкой на объём: «ИИ
 * выбирал, hit-rate 0%» на двух исходах читается как приговор и провоцирует
 * вечное воздержание, хотя это две монетки.
 */
function renderArm(label: string, arm: PlannerArmStats): string {
  if (arm.n === 0) return `${label}: n=0 — его решения ещё не разобраны, это не аргумент`;
  const core = `hit-rate ${arm.hitRate}%, уверенность ${arm.avgConviction}, expectancy ${arm.expectancyBps} bps`;
  if (arm.n < MIN_SIGNIFICANT_N) return `${label}: n=${arm.n} (${core}) — наблюдений мало, выводов не делать`;
  return `${label}: n=${arm.n} (${core})`;
}

function renderPlanPrompt(input: PlanInput): string {
  const f = input.facts;
  const L: string[] = [];

  L.push(
    `РЕШЕНИЕ: сколько кандидатов (0..${input.policy.ceiling}) оформить как фальсифицируемые гипотезы этого цикла и какие.`,
    `Потолок ${input.policy.ceiling} — страховка от потока записей, а не план. Ориентируйся на качество, не на него.`
  );

  L.push(
    `\n## МОДЕЛЬ СЕЙЧАС
разобрано исходов: ${f.resolved}; hit-rate ${f.hitRate.toFixed(1)}% — это БАЗА лаборатории, с ней сравнивай историю каждой связки; Brier ${f.brier.toFixed(3)} (0.25=шум, ≤0.20=калибр.); expectancy ${f.expectancyBps.toFixed(1)} bps после издержек ~24 bps round-trip; в ожидании ${f.pending}.`
  );

  L.push(
    `\n## ТВОЯ ЖЕ ИСТОРИЯ РЕШЕНИЙ (ты под тестом, сравни себя с правилом)
${renderArm("ИИ выбирал", input.record.ai)}
${renderArm("Правило EVS", input.record.rule)}`
  );

  L.push(`\n## ВСЕЛЕННАЯ\n${input.universeNote}`);

  L.push(
    `\n## ВЕСА ОБУЧЕНИЯ\nсильнейшие: ${input.weightsTop.map((w) => `${w.ru} w=${w.w.toFixed(2)} (WR ${(w.wr * 100).toFixed(0)}%, n=${w.n})`).join("; ") || "нет данных"}
слабейшие: ${input.weightsLow.map((w) => `${w.ru} w=${w.w.toFixed(2)}`).join("; ") || "нет данных"}`
  );

  L.push(`\n## КАНДИДАТЫ (${input.candidates.length}) — выбирать можно только отсюда`);
  L.push(input.candidates.map((c) => renderCandidate(c, f)).join("\n"));

  L.push(
    `\n## КАК РЕШАЕТСЯ ИСХОД (физика лаборатории, одинакова для всех)
hit засчитывается только если за 15 минут цена прошла в сторону сигнала ≥ ${OUTCOME_BAR_BPS} bps И финальный ход остался больше издержек (~24 bps round-trip). Всё остальное — miss.
Отсюда два способа потратить цикл впустую: актив, который за 15 минут обычно ходит сильно меньше бара, рождает miss не потому, что сигнал плох, а потому что бар недоступен; актив, который всегда ходит сильно больше бара, рождает hit, который ничего не говорит о сигнале.
Бери только там, где бар достижим, но не тривиален, и где сигнал держится на 2+ высоковесных категориях одного направления.
Связка с историей хуже базы при n≥${MIN_SIGNIFICANT_N} — не «надо проверить ещё», а уже проверенный убыток; тем более она не берётся «ради количества».
Пометка «незначима» — это не минус кандидату и не плюс: при малой истории решают веса категорий, согласие и достижимость бара, а conviction ставь низким.`,
    `\n## ФОРМАТ ОТВЕТА
{"picks":[{"code":"<код из списка>","conviction":0.0-1.0,"why":"<до 90 знаков, по-русски, с числом из контекста>"}],"narrative":"<до 160 знаков по-русски: почему РОВНО столько, включая 0>"}`,
    "Если не берёшь ничего — picks: [] и объясни в narrative."
  );

  return L.join("\n");
}

function sanitizeWhy(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
}

function clampConviction(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.55;
  return Math.max(0.4, Math.min(0.9, n));
}

/* --------------------------- детерминированное правило --------------------------- */

/** Порог «связка вообще заслуживает теста» для безмодельного режима. */
const RULE_MIN_EVS = 58;
/** Берём только дистанцию до лидера, а не весь список подряд. */
const RULE_SPREAD = 8;
/** Без модели мы не набираем потолок: потолок — страховка, а не план. */
const RULE_MAX_TOTAL = 5;
/** Бар исхода достигается реже 3% шагов — связку нельзя ни выиграть, ни проиграть осмысленно. */
const RULE_MIN_REACH_PCT = 3;

/**
 * Правило-запас (и режим «rule» по просьбе человека). Оно воздерживается:
 * сначала отсев по качеству (абсолютный порог + дистанция до лидера), и только
 * потом ограничение по числу. Поэтому итог может быть 2 или 0 — это корректный
 * ответ, а не «недобор плана».
 */
export function rulePick(candidates: PlannerCandidate[], ceiling: number, perAsset = 2): PlannerPickRow[] {
  if (candidates.length === 0) return [];
  // Приор у связки с настоящей историей: проверенная лучше, чем «надо ещё проверить»
  const value = (c: PlannerCandidate): number => {
    const p = c.prior;
    if (!p || p.n < 5) return c.evs;
    return c.evs + (p.hitRate - 50) * 0.3 + p.expectancyBps * 0.02 - (p.expectancyBps < -5 ? 25 : 0);
  };
  const cut = Math.max(RULE_MIN_EVS, Math.max(...candidates.map((c) => c.evs)) - RULE_SPREAD);
  const limit = Math.min(ceiling, RULE_MAX_TOTAL);
  const ranked = candidates
    .filter((c) => c.evs >= cut && (!c.move || c.move.reachPct >= RULE_MIN_REACH_PCT))
    .sort((a, b) => value(b) - value(a));

  const perAssetCount = new Map<string, number>();
  const picks: PlannerPickRow[] = [];
  for (const c of ranked) {
    if (picks.length >= limit) break;
    const used = perAssetCount.get(c.asset) ?? 0;
    if (used >= perAsset) continue;
    perAssetCount.set(c.asset, used + 1);
    const conviction = clampConviction(0.45 + c.evs / 320);
    picks.push({
      code: c.code,
      asset: c.asset,
      conviction,
      why:
        c.prior && c.prior.n >= 3
          ? `правило: EVS ${c.evs}, история n=${c.prior.n} HR ${c.prior.hitRate.toFixed(0)}%`
          : `правило: EVS ${c.evs}, согласие ${c.breakdown.crossAgreement}/20, выборка ${c.sampleSize}`,
      evs: c.evs,
      direction: c.direction,
      catsRu: c.catsRu,
    });
  }
  return picks;
}

/** Почему правило взяло ровно столько — текст честно про отсев, а не про план. */
function ruleNarrative(picks: PlannerPickRow[], candidates: PlannerCandidate[]): string {
  if (candidates.length === 0) {
    return "ни одна связка не дошла до отбора: нет живых данных или нет тестируемого направления";
  }
  const top = Math.max(...candidates.map((c) => c.evs));
  const blocked = candidates.filter((c) => c.move && c.move.reachPct < RULE_MIN_REACH_PCT).length;
  if (picks.length === 0) {
    return (
      `правило воздержалось: лучший EVS ${top} из ${candidates.length} не проходит порог ${RULE_MIN_EVS}` +
      (blocked ? `, бар исхода недостижим у ${blocked}` : "")
    );
  }
  return (
    `правило взяло ${picks.length} из ${candidates.length}: лидер EVS ${top}, отсев по порогу ${RULE_MIN_EVS} ` +
    `и дистанции ${RULE_SPREAD}` +
    (blocked ? `, бар недостижим у ${blocked}` : "") +
    `, не более ${RULE_MAX_TOTAL} за цикл — количество на бумажных деньгах не цель`
  );
}

/* ---------------------------------- plan ---------------------------------- */

export async function planCycle(input: PlanInput): Promise<PlannerDecisionRow> {
  const started = Date.now();
  const authority: PlannerAuthority = input.policy.authority;
  const ceiling = input.policy.ceiling;
  const prompt = renderPlanPrompt(input);
  const byCode = new Map(input.candidates.map((c) => [c.code, c]));

  const base: PlannerDecisionRow = {
    authority,
    mode: authority === "rule" ? "rule" : "ai",
    provider: null,
    model: null,
    offered: input.candidates.length,
    ceiling,
    picks: [],
    narrative: "",
    dropped: [],
    latencyMs: 0,
    error: null,
  };

  if (authority === "rule" || input.candidates.length === 0) {
    const picks = rulePick(input.candidates, ceiling);
    return {
      ...base,
      picks,
      narrative: ruleNarrative(picks, input.candidates),
      latencyMs: Date.now() - started,
    };
  }

  const deadline = input.deadlineMs ?? PLANNER_DEADLINE_MS;
  let providers: Awaited<ReturnType<typeof resolveProvidersFromSettings>> = [];
  try {
    providers = await resolveProvidersFromSettings();
  } catch (e) {
    providers = [];
    base.error = e instanceof Error ? e.message : "настройки ИИ не прочитаны";
  }

  let raw: string | null = null;
  let usedProvider: string | null = null;
  let usedModel: string | null = null;
  const errors: string[] = base.error ? [base.error] : [];

  for (const p of providers) {
    const remaining = deadline - (Date.now() - started);
    if (remaining <= 1500) {
      errors.push("бюджет времени цикла на LLM исчерпан");
      break;
    }
    try {
      raw = await callProvider(
        {
          ...p,
          // Решение — короткий JSON. Длинный бюджет токенов здесь же и главная причина
          // таймаутов: reasoning-модель успевает сгенерировать «мысли» до того, как
          // дойдёт до ответа.
          maxTokens: PLANNER_MAX_TOKENS,
          minChars: 8,
          chatExtra: { ...(p.chatExtra ?? {}), ...reasoningEffortFor(p.model) },
        },
        prompt,
        Math.min(p.timeoutMs ?? 20000, remaining),
        PLANNER_SYSTEM_PROMPT
      );
      usedProvider = p.id;
      usedModel = p.model;
      break;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (!raw) {
    const picks = rulePick(input.candidates, ceiling);
    return {
      ...base,
      mode: "fallback",
      picks,
      narrative: `модель не ответила — решил запасной порядок. ${ruleNarrative(picks, input.candidates)}`,
      error: errors.join(" | ").slice(0, 400) || "нет ответа LLM",
      latencyMs: Date.now() - started,
    };
  }

  const json = extractJsonObject(raw);
  if (!json || !Array.isArray(json.picks)) {
    const picks = rulePick(input.candidates, ceiling);
    return {
      ...base,
      mode: "fallback",
      provider: usedProvider,
      model: usedModel,
      picks,
      narrative: `ответ модели не разобрался как JSON — решил запасной порядок. ${ruleNarrative(picks, input.candidates)}`,
      error: raw.slice(0, 240),
      latencyMs: Date.now() - started,
    };
  }

  const dropped: { code: string; reason: string }[] = [];
  const takenCodes = new Set<string>();
  const picks: PlannerPickRow[] = [];
  const list = (json.picks as unknown[]).slice(0, ceiling * 3);

  for (const entry of list) {
    const o = (entry ?? {}) as Record<string, unknown>;
    const code = typeof o.code === "string" ? o.code.trim() : "";
    const cand = byCode.get(code);
    if (!cand) {
      dropped.push({ code: code.slice(0, 40) || "—", reason: "кода нет среди предложенных кандидатов" });
      continue;
    }
    if (takenCodes.has(code)) {
      dropped.push({ code, reason: "дубль" });
      continue;
    }
    if (picks.length >= ceiling) {
      dropped.push({ code, reason: `сверх потолка ${ceiling}` });
      continue;
    }
    takenCodes.add(code);
    const why = sanitizeWhy(o.why);
    if (!why) dropped.push({ code, reason: "без обоснования — записано как есть" });
    picks.push({
      code,
      asset: cand.asset,
      conviction: clampConviction(o.conviction),
      why: why || "модель не обосновала выбор",
      evs: cand.evs,
      direction: cand.direction,
      catsRu: cand.catsRu,
    });
  }

  const narrative =
    sanitizeWhy(json.narrative) ||
    (picks.length === 0 ? "модель не нашла связок, достойных теста, — цикл без гипотез" : `выбрано ${picks.length}`);

  return {
    ...base,
    provider: usedProvider,
    model: usedModel,
    picks,
    narrative: narrative.slice(0, 300),
    dropped: dropped.slice(0, 12),
    error: errors.length ? errors.join(" | ").slice(0, 300) : null,
    latencyMs: Date.now() - started,
  };
}

/** Санити-тип для записи в БД: решение живёт в experimentRuns.metricsJson.planner. */
export function plannerForRun(decision: PlannerDecisionRow, cycleIndex: number) {
  return { ...decision, cycleIndex, createdAt: new Date().toISOString() };
}
