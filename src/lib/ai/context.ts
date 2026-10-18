import { db } from "@/db";
import {
  aiAnalyses,
  combinations as combinationsTable,
  experimentRuns,
  forecasts,
  hypotheses,
  learningWeights,
} from "@/db/schema";
import { asc, desc, eq, ne } from "drizzle-orm";
import { CATEGORY_DEFINITIONS, CATEGORY_KEYS } from "@/lib/types";
import { loadFilters, type FilterState } from "@/lib/filters";
import { loadActiveUniverse } from "@/lib/quant/universe-store";
import { loadPolicy } from "@/lib/quant/policy";
import type { PlannerDecisionRow } from "@/lib/ui-types";

/** Актив связки: до динамической вселенной все комбинации строились по BTC. */
function comboAsset(c: { parametersJson: unknown }): string {
  const p = (c.parametersJson ?? {}) as { asset?: unknown };
  return typeof p.asset === "string" && p.asset.length > 0 ? p.asset : "BTC-USDT";
}

export const NOTIONAL_PER_TRADE = 5000;
export const GOAL_USD = 15000;

export const AI_SCOPES = [
  "signal_today",
  "filter_tuner",
  "combo_audit",
  "heatmap_read",
  "ledger_postmortem",
  "weights_doctor",
  "walkforward_judge",
  "edge_critic",
  "regime_playbook",
  "risk_gate",
  "hypothesis_writer",
  "capital_planner",
  "category_pruner",
] as const;

export type AiScope = (typeof AI_SCOPES)[number];

export const SCOPE_META: Record<AiScope, { title: string; panel: string; descRu: string; ask: string }> = {
  signal_today: {
    title: "Главный сигнал сейчас",
    panel: "Обзор",
    descRu: "Один ответ на «что торговать прямо сейчас»: актив, направление, триггер, инвалидация, размер риска.",
    ask: "Назови ОДИН главный сигнал: актив, направление, связку категорий, триггер входа, условие инвалидации и размер риска. Если валидного сигнала нет — скажи НАБЛЮДАТЬ и назови блокирующий фактор.",
  },
  filter_tuner: {
    title: "Настройщик фильтров",
    panel: "Настройки",
    descRu: "Подбирает вето человека: порог EVS, минимум категорий, операторы, направления, исключения.",
    ask: "Подбери вето фильтрации сигналов: порог EVS, минимум категорий в связке, разрешённые операторы и направления, категории на исключение. Обоснуй каждое число статистикой из контекста. Количество гипотез не трогай — сколько оформлять решает планировщик цикла; ты лишь отсекаешь недопустимое. Помни: низкий порог = больше материала для обучения, высокий = чище сигналы.",
  },
  combo_audit: {
    title: "Аудит комбинаций",
    panel: "Комбинации",
    descRu: "Отсекает слабые связки цикла до траты времени: что выживет в торговле, а что артефакт режима.",
    ask: "Пройди по топ-комбинациям и дай вердикт каждой (ТОРГОВАТЬ / НАБЛЮДАТЬ / ОТКЛОНИТЬ) с одной строкой обоснования. Отметь скрытые дубли категорий. В конце — лучшая пара для усиления.",
  },
  heatmap_read: {
    title: "Чтение хитмапа",
    panel: "Хитмап",
    descRu: "Переводит матрицу 3×15 в вывод: где согласованное давление, а где категории конфликтуют.",
    ask: "Прочитай матрицу давления: у какого актива самый согласованный фронт категорий, где категории конфликтуют между собой, какие ячейки заслуживают немедленной связки.",
  },
  ledger_postmortem: {
    title: "Разбор промахов",
    panel: "Журнал",
    descRu: "Превращает каждый loss в правило: классифицирует промахи и предлагает точечные правки.",
    ask: "Разбери последние промахи построчно и сформулируй 2–3 правила с числовыми порогами, которые предотвратили бы большинство этих потерь.",
  },
  weights_doctor: {
    title: "Диагностика обучения",
    panel: "Обучение",
    descRu: "Проверяет здоровье весов и калибровки: кто заслужил доверие, кто его теряет, не переобучены ли веса.",
    ask: "Оцени здоровье модели: какие категории заслуженно получили высокий вес, какие переоценены при малой выборке, что говорит Brier о калибровке и какие категории пора приглушить.",
  },
  walkforward_judge: {
    title: "Судья честного теста",
    panel: "Тест",
    descRu: "Выносит вердикт по out-of-sample: подгонка это или настоящая устойчивость.",
    ask: "Вынеси вердикт: устойчива стратегия out-of-sample или это подгонка? Сравни окна, оцени деградацию от train к holdout, проверь превосходство над бенчмарками после издержек.",
  },
  edge_critic: {
    title: "Критик edge",
    panel: "Edge Lab",
    descRu: "Что масштабировать, что убить, какой failure mode доминирует — три действия на завтра.",
    ask: "(1) Какую методику масштабировать и почему она статистически настоящая. (2) Какую убить немедленно. (3) Доминирующий failure mode и конкретный фильтр против него с числом.",
  },
  regime_playbook: {
    title: "Плейбук режима",
    panel: "Edge Lab · режимы",
    descRu: "Что разрешено и запрещено торговать в текущем режиме рынка.",
    ask: "Определи текущий режим по конфигурации весов и режимной матрице. Выпиши: что работает здесь, что системно врёт, и правило-вето одной строкой.",
  },
  risk_gate: {
    title: "Pre-trade чек-лист",
    panel: "Edge Lab · деплой",
    descRu: "Шесть жёстких вопросов перед тем, как методика получит реальные деньги.",
    ask: "Выдай чек-лист из 6 пунктов да/нет для допуска лучшей методики к реальному капиталу: выборка, Wilson LB, expectancy net, просадка, режим, калибровка. Финальный вердикт: КАПИТАЛ ДОПУЩЕН или ТОЛЬКО PAPER.",
  },
  hypothesis_writer: {
    title: "Автор гипотезы",
    panel: "Комбинации · синтез",
    descRu: "Синтезирует следующую фальсифицируемую гипотезу из сильнейших живых категорий.",
    ask: "Сформулируй ОДНУ новую проверяемую гипотезу: связка 2–3 категорий, оператор, числовой порог, горизонт, условие входа, условие фальсификации, ожидаемый механизм.",
  },
  capital_planner: {
    title: "План до $15 000",
    panel: "Edge Lab · цель",
    descRu: "Считает реальный путь к цели: сколько сделок нужно при текущем expectancy и что ускорит.",
    ask: "Посчитай путь к цели $15 000: сколько сделок нужно при текущем expectancy, сколько это циклов по времени, какие два рычага ускорят достижение сильнее всего и какой риск-лимит на просадку установить.",
  },
  category_pruner: {
    title: "Чистка категорий",
    panel: "Edge Lab · lift",
    descRu: "Называет категории-паразиты, которые размывают сигнал, и те, что стоит усилить.",
    ask: "По lift-анализу назови категории, которые размывают сигнал и подлежат исключению, и категории, которые усиливают edge. Дай точный список на исключение.",
  },
};

/* ================= Recommended parameters ================= */

export interface RecommendedParams {
  minEvs: number;
  minCategories: number;
  maxHypothesesPerCycle: number;
  operators: string[];
  directions: string[];
  regimeLock: string;
  excludedCategories: string[];
  rationale: string[];
}

export interface Facts {
  leaders: { sig: string; n: number; hr: number; lb: number; exp: number; dir: string }[];
  lift: { cat: string; ru: string; n: number; hrW: number; hrO: number; lift: number }[];
  grid: { cut: number; n: number; hr: number; exp: number }[];
  errors: [string, number][];
  weightsTop: { ru: string; w: number; wr: number; n: number }[];
  weightsLow: { ru: string; w: number; wr: number; n: number }[];
  dirStats: { d: string; n: number; hr: number; exp: number }[];
  combos: { code: string; asset: string; evs: number; status: string; cats: string[] }[];
  universe: { symbol: string; role: string; score: number }[];
  pendingCount: number;
  expectancyBps: number;
}

export interface FullContext {
  text: string;
  recommended: RecommendedParams;
  current: FilterState;
  facts: Facts;
  stats: { resolved: number; hitRate: number; brier: number; pnl: number; goalPct: number };
}

function wilson(h: number, n: number): number {
  if (n === 0) return 0;
  const z = 1.96, p = h / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
}

const ru = (c: string) => CATEGORY_DEFINITIONS[c as keyof typeof CATEGORY_DEFINITIONS]?.labelRu ?? c;

/**
 * Собирает ЕДИНЫЙ богатый контекст (3000+ символов) + детерминированные
 * рекомендации параметров, вычисленные из реальной статистики базы.
 * LLM получает и цифры, и уже посчитанные кандидаты-настройки — её задача
 * объяснить и при необходимости оспорить, а не выдумывать числа.
 */
export async function buildContext(scope: AiScope, userNote?: string): Promise<FullContext> {
  const current = await loadFilters();

  const resolvedAll = await db
    .select()
    .from(forecasts)
    .where(eq(forecasts.status, "resolved"))
    .orderBy(asc(forecasts.createdAt));
  const pending = await db.select().from(forecasts).where(eq(forecasts.status, "pending"));
  const hypList = await db.select().from(hypotheses).orderBy(desc(hypotheses.createdAt)).limit(800);
  const hypMap = new Map(hypList.map((h) => [h.id, h]));
  const weights = await db.select().from(learningWeights);
  const combos = await db
    .select()
    .from(combinationsTable)
    .orderBy(desc(combinationsTable.earlyValueScore))
    .limit(12);
  // Вселенная отбора: ИИ обязан знать, что состав пар выбирает сам цикл,
  // иначе его выводы «почему только BTC» будут построены на несуществующем правиле.
  const universe = await loadActiveUniverse().catch(() => null);
  // Кто решает отбор и что он решил в последнем цикле — без этого аналитик
  // продолжал бы советовать «увеличить число гипотез», чего движок больше не делает.
  const policy = await loadPolicy();
  const runRow = await db
    .select({ metricsJson: experimentRuns.metricsJson })
    .from(experimentRuns)
    .orderBy(desc(experimentRuns.createdAt))
    .limit(1)
    .catch(() => [] as { metricsJson: unknown }[]);
  const lastDecision = ((runRow[0]?.metricsJson ?? {}) as { planner?: PlannerDecisionRow }).planner ?? null;
  // Болтовня (smalltalk) в исследовательскую память не попадает — только предметные разборы.
  const memory = await db
    .select()
    .from(aiAnalyses)
    .where(ne(aiAnalyses.kind, "smalltalk"))
    .orderBy(desc(aiAnalyses.createdAt))
    .limit(6);

  const decided = resolvedAll.filter((f) => f.outcome === "hit" || f.outcome === "miss");
  const hits = decided.filter((f) => f.outcome === "hit").length;
  const hitRate = decided.length ? (hits / decided.length) * 100 : 0;
  const pnl = decided.reduce((a, f) => a + ((f.realizedReturnNet ?? 0) / 100) * NOTIONAL_PER_TRADE, 0);
  const brier = weights.length ? weights.reduce((a, w) => a + w.brierScore, 0) / weights.length : 0.25;
  const expectancyBps = decided.length
    ? decided.reduce((a, f) => a + (f.realizedReturnNet ?? 0) * 100, 0) / decided.length
    : 0;

  /* ---- Лидерборд по сигнатурам категорий ---- */
  const groups = new Map<string, { n: number; h: number; ret: number; dir: string }>();
  for (const f of decided) {
    const hyp = f.hypothesisId ? hypMap.get(f.hypothesisId) : null;
    const cats = Array.isArray(hyp?.categoriesJson) ? (hyp!.categoriesJson as string[]) : [];
    const key = (cats.length ? [...cats].sort().slice(0, 3).map(ru).join(" + ") : "смешанные") + " | " + f.direction;
    if (!groups.has(key)) groups.set(key, { n: 0, h: 0, ret: 0, dir: f.direction });
    const g = groups.get(key)!;
    g.n++;
    if (f.outcome === "hit") g.h++;
    g.ret += (f.realizedReturnNet ?? 0) * 100;
  }
  const leaders = [...groups.entries()]
    .map(([sig, g]) => ({
      sig,
      n: g.n,
      hr: (g.h / g.n) * 100,
      lb: wilson(g.h, g.n),
      exp: g.ret / g.n,
      dir: g.dir,
    }))
    .sort((a, b) => b.lb * Math.min(b.n, 20) - a.lb * Math.min(a.n, 20));

  /* ---- Lift категорий ---- */
  const lift = CATEGORY_KEYS.map((cat) => {
    let wN = 0, wH = 0, oN = 0, oH = 0;
    for (const f of decided) {
      const hyp = f.hypothesisId ? hypMap.get(f.hypothesisId) : null;
      const cats = Array.isArray(hyp?.categoriesJson) ? (hyp!.categoriesJson as string[]) : [];
      if (cats.includes(cat)) {
        wN++;
        if (f.outcome === "hit") wH++;
      } else {
        oN++;
        if (f.outcome === "hit") oH++;
      }
    }
    const hrW = wN ? (wH / wN) * 100 : 0;
    const hrO = oN ? (oH / oN) * 100 : 0;
    return { cat, ru: ru(cat), n: wN, hrW, hrO, lift: wN >= 2 ? hrW - hrO : 0 };
  }).sort((a, b) => b.lift - a.lift);

  /* ---- Сетка порогов EVS ---- */
  const scoreOf = (id: number | null) => {
    const sc = (id ? hypMap.get(id)?.scoreComponentsJson : null) as { total?: number } | null;
    return typeof sc?.total === "number" ? sc.total : 0;
  };
  const grid = [30, 40, 50, 60, 65, 70, 75, 80].map((cut) => {
    const sub = decided.filter((f) => scoreOf(f.hypothesisId) >= cut);
    const h = sub.filter((f) => f.outcome === "hit").length;
    return {
      cut,
      n: sub.length,
      hr: sub.length ? (h / sub.length) * 100 : 0,
      exp: sub.length ? sub.reduce((a, f) => a + (f.realizedReturnNet ?? 0) * 100, 0) / sub.length : 0,
    };
  });

  /* ---- Ошибки ---- */
  const errMap = new Map<string, number>();
  for (const f of decided) {
    if (f.outcome !== "miss") continue;
    const t = f.errorType || "weak_signal";
    errMap.set(t, (errMap.get(t) ?? 0) + 1);
  }
  const errors = [...errMap.entries()].sort((a, b) => b[1] - a[1]);

  /* ---- Операторы и направления по доходности ---- */
  const dirStats = ["UP", "DOWN", "NEUTRAL"].map((d) => {
    const sub = decided.filter((f) => f.direction === d);
    const h = sub.filter((f) => f.outcome === "hit").length;
    return {
      d,
      n: sub.length,
      hr: sub.length ? (h / sub.length) * 100 : 0,
      exp: sub.length ? sub.reduce((a, f) => a + (f.realizedReturnNet ?? 0) * 100, 0) / sub.length : 0,
    };
  });

  const sortedW = [...weights].sort((a, b) => b.currentWeight - a.currentWeight);

  /* ================= Детерминированные рекомендации ================= */

  const viable = grid.filter((g) => g.n >= 8);
  const bestGrid = viable.length ? viable.reduce((a, b) => (b.exp > a.exp ? b : a)) : null;
  // Компромисс: не задираем порог выше 70 — важнее накопление выборки для обучения
  const recMinEvs = bestGrid ? Math.min(70, Math.max(30, bestGrid.cut - 5)) : 30;
  const negCats = lift.filter((l) => l.lift < -8 && l.n >= 3).map((l) => l.cat);
  const goodDirs = dirStats.filter((x) => x.n < 3 || x.exp > -5).map((x) => x.d);
  const recDirs = goodDirs.length ? goodDirs : ["UP", "DOWN"];
  // Количество больше не рекомендация движка: сколько оформлять связок решает
  // планировщик цикла. В этом объекте живёт только страховочный потолок.
  const recCeiling = policy.ceiling;
  const recMinCats = decided.length < 100 ? 2 : leaders.some((l) => l.n >= 8 && l.lb >= 0.55) ? 3 : 2;

  const recommended: RecommendedParams = {
    minEvs: recMinEvs,
    minCategories: recMinCats,
    maxHypothesesPerCycle: recCeiling,
    operators: ["WEIGHTED", "AND", "OR", "VETO"],
    directions: recDirs,
    regimeLock: "ANY",
    excludedCategories: negCats,
    rationale: [
      bestGrid
        ? `Порог EVS ${recMinEvs}: сетка показала максимум expectancy ${bestGrid.exp.toFixed(1)} bps при отсечке ${bestGrid.cut} (n=${bestGrid.n}); берём на 5 пунктов ниже, чтобы не потерять выборку для обучения.`
        : `Порог EVS ${recMinEvs}: исходов пока мало (${decided.length}) — задранный порог был бы отсеиванием наугад.`,
      `Минимум категорий ${recMinCats}: ${recMinCats >= 3 ? "есть подтверждённые многофакторные связки — требуем большей конфлюэнции" : "подтверждённой многофакторности пока нет — не сужаем пространство поиска"}.`,
      `Потолок ${recCeiling} записей за цикл — это страховка от потока, а не план: сколько связок оформлять решает планировщик (${policy.authority === "ai" ? "модель" : "правило"}), ${lastDecision ? `в последнем цикле он взял ${lastDecision.picks.length} из ${lastDecision.offered}` : "решения ещё нет"}. Больше гипотез ≠ лучше: исполнение бумажное, а шум бьёт по калибровке.`,
      negCats.length
        ? `Исключить ${negCats.length} категорий с отрицательным lift: ${negCats.map(ru).join(", ")}.`
        : "Категорий с устойчиво отрицательным lift пока нет — ничего не исключаем.",
    ],
  };

  /* ================= Текст контекста (3000+ символов) ================= */

  const meta = SCOPE_META[scope];
  const L: string[] = [];

  L.push(`# ЗАДАЧА АНАЛИЗА: ${meta.title} (панель «${meta.panel}»)`);
  L.push(meta.ask);
  if (userNote?.trim()) L.push(`\n## УТОЧНЕНИЕ ПОЛЬЗОВАТЕЛЯ\n${userNote.trim()}`);

  L.push(`\n## 1. МИССИЯ И КАПИТАЛ
Автономная лаборатория квант-гипотез на данных OKX. Цель: накопить +$${GOAL_USD} чистой прибыли в симуляции исполнения при ноционале $${NOTIONAL_PER_TRADE} на сигнал.
Текущий кумулятивный PnL: $${pnl.toFixed(0)} (${((pnl / GOAL_USD) * 100).toFixed(1)}% цели). Средний expectancy: ${expectancyBps.toFixed(1)} bps на сделку.
До цели осталось $${(GOAL_USD - pnl).toFixed(0)}; при текущем expectancy это ≈ ${expectancyBps > 0 ? Math.ceil((GOAL_USD - pnl) / ((expectancyBps / 10000) * NOTIONAL_PER_TRADE)) : "∞"} сделок.`);

  L.push(`\n## 2. КАЧЕСТВО МОДЕЛИ
Разрешено прогнозов: ${decided.length} (hits ${hits}, misses ${decided.length - hits}); в ожидании: ${pending.length}.
Hit rate: ${hitRate.toFixed(1)}%. Средний Brier: ${brier.toFixed(4)} (0.25 = случайность, ≤0.20 = хорошая калибровка).
Всего гипотез в базе: ${hypList.length}. Цикл строит по 100 связок на каждый актив вселенной (N×100, а не 100 на весь рынок): это ПРОСТРАНСТВО поиска, а не план — в отбор попадает короткий список кандидатов, и сколько из них оформить гипотезами решает планировщик.`);

  L.push(`\n## 2b. ВСЕЛЕННАЯ ОТБОРА (состав выбирает цикл, не человек)
${universe ? universe.universe.map((u) => `${u.symbol} [${u.role === "core" ? "ядро" : "разведка"}] отбор-скор ${u.score}`).join("; ") : "состав ещё не сформирован — первый цикл не завершён"}.
Отбор: пол исполнимости (объём ≥ $3M/24h, спред ≤ 10 bps, стейблкоины отброшены) → merit-скор (ликвидность 0.30, волатильность 0.28, |RS к BTC| 0.22, turnover 0.20) → анти-толпа и слоты разведки. BTC — якорь, он в составе всегда.`);

  L.push(
    `\n## 2c. ОТБОР ГИПОТЕЗ РЕШАЕТ МОДЕЛЬ (не ползунок)
Политика: кому принадлежит выбор — ${policy.authority === "ai" ? "моделю-планировщику" : "детерминированному EVS-правилу"}; страховочный потолок ${policy.ceiling} записей за цикл (защита от потока, а не цель).
${
      lastDecision
        ? `Последнее решение: режим «${lastDecision.mode}», предложено ${lastDecision.offered} связок, взято ${lastDecision.picks.length}, средняя уверенность ${
            lastDecision.picks.length
              ? (lastDecision.picks.reduce((a, p) => a + p.conviction, 0) / lastDecision.picks.length).toFixed(2)
              : "—"
          }. Обоснование: ${lastDecision.narrative.slice(0, 220)}`
        : "Решений планировщика в базе ещё нет — цикл их ещё не записал."
    }
Ставки делаются на бумажные деньги: количество гипотез ничего не приносит, а шумная связка размывает калибровку весов. Ноль выбранных связок — корректный результат, а не поломка. Не советуй «брать больше гипотез ради скорости накопления выборки» — этого рычага больше нет.`
  );

  L.push(`\n## 3. ТЕКУЩИЕ ФИЛЬТРЫ ОТБОРА (вето человека: что вообще допустимо)
Порог EVS: ${current.minEvs}; минимум категорий: ${current.minCategories}; страховочный потолок записей: ${policy.ceiling} (сколько из допущенного оформлять — решает планировщик).
Операторы: ${current.operators.join(", ")}. Направления: ${current.directions.join(", ")}. Режимный замок: ${current.regimeLock}.
Исключённые категории: ${current.excludedCategories.length ? current.excludedCategories.map(ru).join(", ") : "нет"}.`);

  L.push(`\n## 4. ЛИДЕРБОРД МЕТОДИК (сигнатура | n | hit-rate | Wilson LB 95% | expectancy)
${leaders.slice(0, 10).map((l, i) => `${i + 1}. ${l.sig} | n=${l.n} | HR ${l.hr.toFixed(1)}% | LB ${(l.lb * 100).toFixed(0)}% | ${l.exp.toFixed(1)} bps`).join("\n") || "пока пусто"}
Критерий валидности: n ≥ 8 И Wilson LB ≥ 55% И expectancy > 0.`);

  L.push(`\n## 5. LIFT КАТЕГОРИЙ (hit-rate С категорией минус БЕЗ неё, п.п.)
${lift.filter((l) => l.n >= 2).slice(0, 8).map((l) => `+ ${l.ru}: ${l.lift > 0 ? "+" : ""}${l.lift.toFixed(1)} (n=${l.n}, HR с ней ${l.hrW.toFixed(0)}%)`).join("\n")}
${lift.filter((l) => l.n >= 2).slice(-4).map((l) => `- ${l.ru}: ${l.lift.toFixed(1)} (n=${l.n})`).join("\n")}`);

  L.push(`\n## 6. СЕТКА ПОРОГОВ EVS (отсечка | выборка | hit-rate | expectancy)
${grid.map((g) => `EVS ≥ ${g.cut} | n=${g.n} | ${g.hr.toFixed(1)}% | ${g.exp.toFixed(1)} bps`).join("\n")}`);

  L.push(`\n## 7. ВЕСА ОБУЧЕНИЯ (байес, приор α=β=5, диапазон 0.25–2.50)
Сильнейшие: ${sortedW.slice(0, 5).map((w) => `${ru(w.categoryName)} w=${w.currentWeight.toFixed(2)} (WR ${(w.empiricalWinrate * 100).toFixed(0)}%, n=${w.totalSamples})`).join("; ")}
Слабейшие: ${sortedW.slice(-4).map((w) => `${ru(w.categoryName)} w=${w.currentWeight.toFixed(2)} (WR ${(w.empiricalWinrate * 100).toFixed(0)}%)`).join("; ")}`);

  L.push(`\n## 8. ТАКСОНОМИЯ ОШИБОК (тип | количество)
${errors.map(([t, c]) => `${t}: ${c}`).join("; ") || "промахов нет"}
Справочник: weak_signal — вход без запаса силы; cost_drag — издержки съели edge; wrong_horizon — цель бралась, затем разворот; regime_mismatch — сигнал вне своего режима; wrong_sign — противоположное движение.`);

  L.push(`\n## 9. ТОП КОМБИНАЦИЙ ПОСЛЕДНИХ ЦИКЛОВ (код | актив | EVS | статус | связка)
${combos.slice(0, 8).map((c) => `${c.code} | ${comboAsset(c)} | EVS ${Math.round(c.earlyValueScore)} | ${c.status} | ${(Array.isArray(c.categoriesJson) ? (c.categoriesJson as string[]) : []).map(ru).join(" + ")}`).join("\n") || "нет данных"}`);

  L.push(`\n## 10. НАПРАВЛЕНИЯ
${dirStats.map((x) => `${x.d}: n=${x.n}, HR ${x.hr.toFixed(1)}%, ${x.exp.toFixed(1)} bps`).join("; ")}`);

  L.push(`\n## 11. ПАМЯТЬ ЛАБОРАТОРИИ (предыдущие разборы — учитывай преемственность, не повторяй дословно)
${memory.map((m) => `[${new Date(m.createdAt).toISOString().slice(5, 16)}] ${m.title}: ${m.content.slice(0, 180).replace(/\n/g, " ")}…`).join("\n") || "память пуста — это первый анализ"}`);

  L.push(`\n## 12. ПРЕДВАРИТЕЛЬНО РАССЧИТАННЫЕ РЕКОМЕНДАЦИИ (оспорь или подтверди числами)
Порог EVS → ${recommended.minEvs}; минимум категорий → ${recommended.minCategories}; страховочный потолок записей → ${recommended.maxHypothesesPerCycle} (число гипотез — не твоя рекомендация, его выбирает планировщик); направления → ${recommended.directions.join(",")}; исключить → ${recommended.excludedCategories.map(ru).join(", ") || "ничего"}.
Обоснование движка: ${recommended.rationale.join(" ")}`);

  L.push(`\n## ФОРМАТ ОТВЕТА
Только русский. 5–8 пронумерованных пунктов, каждый — конкретное действие или вывод с числом из контекста. Вердикты капсом (ТОРГОВАТЬ / НАБЛЮДАТЬ / ОТКЛОНИТЬ / ДОПУСТИТЬ). Никакой воды, вступлений и дисклеймеров. Максимум 220 слов. Последним пунктом дай строку вида «ПАРАМЕТРЫ: EVS=<число>, категорий=<число>» с твоей итоговой рекомендацией по ВЕТУ. Количество гипотез не предлагай: его решает планировщик цикла.`);

  return {
    text: L.join("\n"),
    recommended,
    current,
    facts: {
      leaders: leaders.slice(0, 10),
      lift: lift.filter((l) => l.n >= 2),
      grid,
      errors,
      weightsTop: sortedW.slice(0, 5).map((w) => ({ ru: ru(w.categoryName), w: w.currentWeight, wr: w.empiricalWinrate * 100, n: w.totalSamples })),
      weightsLow: sortedW.slice(-4).map((w) => ({ ru: ru(w.categoryName), w: w.currentWeight, wr: w.empiricalWinrate * 100, n: w.totalSamples })),
      dirStats,
      combos: combos.slice(0, 8).map((c) => ({
        code: c.code,
        asset: comboAsset(c),
        evs: Math.round(c.earlyValueScore),
        status: c.status,
        cats: (Array.isArray(c.categoriesJson) ? (c.categoriesJson as string[]) : []).map(ru),
      })),
      universe: (universe?.universe ?? []).map((u) => ({ symbol: u.symbol, role: u.role, score: u.score })),
      pendingCount: pending.length,
      expectancyBps: Number(expectancyBps.toFixed(1)),
    },
    stats: {
      resolved: decided.length,
      hitRate: Number(hitRate.toFixed(1)),
      brier: Number(brier.toFixed(4)),
      pnl: Number(pnl.toFixed(0)),
      goalPct: Number(((pnl / GOAL_USD) * 100).toFixed(1)),
    },
  };
}
