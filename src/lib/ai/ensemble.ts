import { callProvider } from "./provider";
import { resolveProvidersFromSettings } from "./settings";
import { extractJsonObject, type PlannerCandidate } from "../quant/planner";

/**
 * АНСАМБЛЬ АСИММЕТРИЧНЫХ СРЕЗОВ (H001, замороженный протокол P1).
 *
 * Литература по multi-agent debate однозначна: клоны с одинаковым входом —
 * усиление согласия, а не точности (herd confirmation); выигрыш дают только
 * агенты с РАЗНЫМ входом или разной ролью [K01, R04]. Поэтому здесь не
 * «три копии планировщика», а три среза контекста:
 *   — flow:    поток/стакан/деривативы/ликвидации (микроструктура);
 *   — context: межбиржевая дисперсия, межассет, ширина, стейбл-флоу, ончейн;
 *   — state:   волатильность, сессия, сентимент, аномалии, объём/ликвидность.
 * Ядро (цена + режим + физика исхода) общее — иначе срезы несопоставимы.
 *
 * Каждый агент отвечает вероятностями p по кодам кандидатов (не выбором —
 * вероятностью: нас интересует калибровка, а не ещё один дискретный голос).
 * Агрегат: среднее, взвешенное по conf, spread = max−min по ответившим.
 *
 * Fail-tolerant: общий бюджет, Promise.allSettled, при любом сбое — пустая
 * карта, планировщик работает как раньше. Ансамбль НИКОГДА не блокирует цикл.
 *
 * Arms протокола P1 ведутся журналом: A = планировщик (полный контекст),
 * B = 3× тот же контекст (herd-контроль, запускается отдельной конфигурацией,
 * не здесь), C = эти срезы. Сравнение — paired Brier после n=300 разрешённых
 * ансамблевых исходов (shadow-книга).
 */

export interface EnsembleVote {
  /** Взвешенная по conf вероятность hit кандидата, 0..1. */
  p: number;
  /** Разброс между ответившими агентами (max−min), мера разногласия. */
  spread: number;
  /** Сколько агентов проголосовали за этот код. */
  n: number;
  /** Средняя уверенность голосовавших. */
  conf: number;
}

const SLICE_DEFS = [
  {
    id: "flow",
    ru: "поток и микроструктура",
    cats: new Set([
      "order_flow",
      "order_book_microstructure",
      "derivatives_positioning",
      "liquidations",
    ]),
    instruction:
      "Ты видишь ТОЛЬКО микроструктуру: поток сделок, стакан, деривативы, ликвидации. Игнорируй сигналы других категорий — их у тебя нет. Оценивай вероятность хода за 15 минут по потоку.",
  },
  {
    id: "context",
    ru: "контекст и кросс-рынок",
    cats: new Set([
      "cross_exchange_dispersion",
      "cross_asset_relationships",
      "market_breadth_rotation",
      "stablecoin_flow_proxies",
      "on_chain_activity",
    ]),
    instruction:
      "Ты видишь ТОЛЬКО кросс-рыночный контекст: дисперсия бирж, связи активов, ширина рынка, стейблкоины, ончейн. Игнорируй микроструктуру — её у тебя нет. Оценивай, поддерживает ли контекст ход за 15 минут.",
  },
  {
    id: "state",
    ru: "состояние рынка",
    cats: new Set([
      "volatility_regime",
      "time_calendar_session",
      "sentiment_attention",
      "anomaly_novelty",
      "volume_liquidity",
    ]),
    instruction:
      "Ты видишь ТОЛЬКО состояние рынка: режим волатильности, сессию, сентимент, аномалии, объём/ликвидность. Игнорируй поток и кросс-рынок — их у тебя нет. Оценивай, достижим ли бар хода в текущем состоянии.",
  },
] as const;

const ENSEMBLE_DEADLINE_MS = 15000;
const ENSEMBLE_MAX_TOKENS = 500;
/** Агент, ответивший менее чем по этой доле кодов, считается неполным и не агрегируется. */
const MIN_VOTE_FRACTION = 0.5;

function reasoningEffortFor(model: string): Record<string, unknown> {
  return /gpt-oss/i.test(model) ? { reasoning_effort: "low" } : {};
}

/** Рендер строки кандидата, обрезанный до категорий конкретного среза. */
function renderSliceCandidate(c: PlannerCandidate, cats: ReadonlySet<string>): string {
  const kept = c.categories.filter((k) => cats.has(k));
  const score = kept.length
    ? kept.map((k) => `${k}=${(c.breakdown[k] ?? 0).toFixed(1)}`).join(",")
    : "профильных категорий нет — голосуй нейтрально 0.5";
  const move = c.move ? `ход15м медиана ${c.move.medAbsBps}bps, бар ${35}bps достигает ${c.move.reachPct}%` : "ход неизвестен";
  return `${c.code} · ${c.asset} · ${c.direction} · ${c.regime} · ${score} · ${move}`;
}

function buildSlicePrompt(slice: (typeof SLICE_DEFS)[number], candidates: PlannerCandidate[], barBps: number): string {
  const L: string[] = [];
  L.push(`СРЕЗ: ${slice.ru}.`);
  L.push(slice.instruction);
  L.push(
    `\nФИЗИКА: hit если за 15 минут ход в сторону сигнала ≥ ${barBps} bps и итог выше издержек ~24 bps. p — вероятность hit, 0..1. conf — твоя уверенность в ответе, 0..1.`
  );
  L.push(`\nКАНДИДАТЫ (${candidates.length}) — ответить по каждому коду:`);
  L.push(candidates.map((c) => renderSliceCandidate(c, slice.cats)).join("\n"));
  L.push(`\nФОРМАТ: {"votes":[{"code":"<код>","p":0.0-1.0,"conf":0.0-1.0}]} — РОВНО один JSON без markdown.`);
  return L.join("\n");
}

function parseVotes(raw: string, validCodes: Set<string>): Map<string, { p: number; conf: number }> | null {
  const json = extractJsonObject(raw);
  if (!json || !Array.isArray(json.votes)) return null;
  const out = new Map<string, { p: number; conf: number }>();
  for (const entry of json.votes) {
    const o = (entry ?? {}) as Record<string, unknown>;
    const code = typeof o.code === "string" ? o.code.trim() : "";
    if (!validCodes.has(code)) continue;
    const p = Number(o.p);
    if (!Number.isFinite(p)) continue;
    const conf = Number.isFinite(Number(o.conf)) ? Math.max(0, Math.min(1, Number(o.conf))) : 0.5;
    out.set(code, { p: Math.max(0.01, Math.min(0.99, p)), conf });
  }
  return out.size > 0 ? out : null;
}

/**
 * Запустить ансамбль срезов. Возвращает карту code → {p, spread, n, conf}.
 * Пустая карта при любом сбое — вызывающий код обязан работать без ансамбля.
 */
export async function runEnsemble(candidates: PlannerCandidate[], barBps = 35): Promise<Map<string, EnsembleVote>> {
  const result = new Map<string, EnsembleVote>();
  if (candidates.length === 0) return result;

  const started = Date.now();
  let providers: Awaited<ReturnType<typeof resolveProvidersFromSettings>> = [];
  try {
    providers = await resolveProvidersFromSettings();
  } catch {
    return result;
  }
  if (providers.length === 0) return result;

  const validCodes = new Set(candidates.map((c) => c.code));

  const tasks = SLICE_DEFS.map(async (slice) => {
    const prompt = buildSlicePrompt(slice, candidates, barBps);
    for (const p of providers) {
      const remaining = ENSEMBLE_DEADLINE_MS - (Date.now() - started);
      if (remaining <= 1200) return null;
      try {
        const raw = await callProvider(
          {
            ...p,
            maxTokens: ENSEMBLE_MAX_TOKENS,
            minChars: 8,
            chatExtra: { ...(p.chatExtra ?? {}), ...reasoningEffortFor(p.model) },
          },
          prompt,
          Math.min(p.timeoutMs ?? 12000, remaining),
          "Ты — агент среза данных автономной квант-лаборатории. Ответ — РОВНО один JSON-объект, без markdown и пояснений."
        );
        const votes = parseVotes(raw, validCodes);
        if (votes && votes.size >= candidates.length * MIN_VOTE_FRACTION) return votes;
      } catch {
        /* пробуем следующего провайдера цепи */
      }
    }
    return null;
  });

  const settled = await Promise.allSettled(tasks);
  const voteMaps: Map<string, { p: number; conf: number }>[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value) voteMaps.push(s.value);
  }
  if (voteMaps.length === 0) return result;

  // Агрегат: среднее по conf, spread = max−min по агентам.
  for (const code of validCodes) {
    const pts: { p: number; conf: number }[] = [];
    for (const m of voteMaps) {
      const v = m.get(code);
      if (v) pts.push(v);
    }
    if (pts.length === 0) continue;
    const wSum = pts.reduce((a, x) => a + Math.max(0.05, x.conf), 0);
    const p = pts.reduce((a, x) => a + x.p * Math.max(0.05, x.conf), 0) / wSum;
    const ps = pts.map((x) => x.p);
    result.set(code, {
      p: Number(p.toFixed(4)),
      spread: Number((Math.max(...ps) - Math.min(...ps)).toFixed(4)),
      n: pts.length,
      conf: Number((pts.reduce((a, x) => a + x.conf, 0) / pts.length).toFixed(3)),
    });
  }
  return result;
}

/** Короткая строка ансамбля для промпта планировщика («ансP»). */
export function ensembleSummary(ens: Map<string, EnsembleVote> | undefined): string {
  if (!ens || ens.size === 0) return "ансамбль не запущен/не ответил";
  const ps = [...ens.values()].map((v) => v.p);
  const meanSpread = ens.size ? [...ens.values()].reduce((a, v) => a + v.spread, 0) / ens.size : 0;
  const avg = ps.reduce((a, x) => a + x, 0) / ps.length;
  return `ансамбль срезов: n=${ens.size} кодов, среднее p=${avg.toFixed(2)}, средний разброс ${meanSpread.toFixed(2)}`;
}
