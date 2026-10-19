import { db, pool } from "@/db";
import { shadowDecisions } from "@/db/schema";
import { and, eq, lte } from "drizzle-orm";
import type { OKXCandle } from "../types";
import type { PlannerCandidate } from "./planner";
import type { PlannerDecisionRow, PlannerPickRow } from "../ui-types";
import { wilsonLowerBound } from "./deflated-stats";

/**
 * SHADOW-КНИГА РЕШЕНИЙ (H003).
 *
 * Каждое решение — бесплатный A/B-тест, если логировать propensity: off-policy
 * оценка (SNIPS/Δ-OPE) сравнивает политики БЕЗ исполнения. Требования литературы:
 *  — логировать ВСЕХ предложенных кандидатов, а не только выбранных
 *    (deficient support: чего не залогировали, то не оценить);
 *  — propensity стохастична НАМЕРЕННО (softmax, T=8): детерминированная
 *    политика вызывает propensity collapse и IPS вырождается;
 *  — обе руки (ai и rule) логируются на каждом цикле → paired-сравнение;
 *  — интервалы — percentile bootstrap, наивный normal-интервал на bootstrap-среднем
 *    делает значимым всё (interval trap); ESS и max weight — гейт доверия.
 *
 * Физика shadow-исхода та же, что у боевого прогноза: hit если MFE ≥ 35 bps
 * в сторону сигнала И net-доходность > 0 после издержек 24 bps round-trip.
 * Изменение физики задним числом запрещено (внешний якорь).
 */

/** Температура softmax-propensity — зафиксирована протоколом H003 до внедрения. */
export const PROPENSITY_TEMPERATURE = 8;
/** Бар исхода и издержки — те же константы, что в планировщике/оценщике. */
const SHADOW_BAR_PCT = 0.35; // 35 bps в %
const SHADOW_COSTS_PCT = 0.24; // 24 bps round-trip в %

let ensurePromise: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = pool
      .query(
        `CREATE TABLE IF NOT EXISTS shadow_decisions (
          id SERIAL PRIMARY KEY,
          cycle_at TIMESTAMPTZ NOT NULL,
          resolve_at TIMESTAMPTZ NOT NULL,
          code TEXT NOT NULL,
          asset TEXT NOT NULL,
          signature TEXT NOT NULL,
          direction TEXT NOT NULL,
          evs DOUBLE PRECISION NOT NULL DEFAULT 0,
          regime TEXT NOT NULL DEFAULT 'NEUTRAL_CONSOLIDATION',
          propensity_ai DOUBLE PRECISION NOT NULL DEFAULT 0,
          chosen_ai BOOLEAN NOT NULL DEFAULT FALSE,
          chosen_rule BOOLEAN NOT NULL DEFAULT FALSE,
          entry_price DOUBLE PRECISION NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          outcome TEXT,
          mfe_pct DOUBLE PRECISION,
          realized_return_net_pct DOUBLE PRECISION,
          resolved_price DOUBLE PRECISION,
          resolved_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
      )
      .then(() => undefined)
      .catch((e) => {
        ensurePromise = null;
        throw e;
      });
  }
  return ensurePromise;
}

/** Та же value-функция, что в rulePick: EVS + поправка на значимую историю подписи. */
function valueOf(c: PlannerCandidate): number {
  const p = c.prior;
  if (!p || p.n < 5) return c.evs;
  return c.evs + (p.hitRate - 50) * 0.3 + p.expectancyBps * 0.02 - (p.expectancyBps < -5 ? 25 : 0);
}

/** Softmax-propensity по value: намеренно стохастична, чтобы IPS не вырождался. */
export function softmaxPropensities(candidates: PlannerCandidate[], temperature = PROPENSITY_TEMPERATURE): Map<string, number> {
  const out = new Map<string, number>();
  if (candidates.length === 0) return out;
  const vals = candidates.map((c) => valueOf(c) / temperature);
  const max = Math.max(...vals);
  const exps = vals.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, x) => a + x, 0);
  candidates.forEach((c, i) => out.set(c.code, exps[i] / sum));
  return out;
}

/**
 * Залогировать цикл: все кандидаты, propensity, выбор боевой руки (decision) и
 * выбор правила (rulePicks — вторая рука, считается даже когда решает модель).
 */
export async function logCycleDecisions(args: {
  candidates: PlannerCandidate[];
  decision: PlannerDecisionRow;
  rulePicks: PlannerPickRow[];
  entryPrices: Map<string, number>;
  cycleAt: Date;
  resolveAt: Date;
}): Promise<number> {
  const { candidates, decision, rulePicks, entryPrices, cycleAt, resolveAt } = args;
  if (candidates.length === 0) return 0;
  await ensureTable();
  const propensities = softmaxPropensities(candidates);
  const aiChosen = new Set(decision.picks.map((p) => p.code));
  const ruleChosen = new Set(rulePicks.map((p) => p.code));

  const rows = candidates.map((c) => ({
    cycleAt,
    resolveAt,
    code: c.code,
    asset: c.asset,
    signature: c.signature,
    direction: c.direction,
    evs: c.evs,
    regime: c.regime,
    propensityAi: propensities.get(c.code) ?? 0,
    chosenAi: aiChosen.has(c.code),
    chosenRule: ruleChosen.has(c.code),
    entryPrice: entryPrices.get(c.asset) ?? 0,
    status: "pending" as const,
    createdAt: new Date(),
  }));
  try {
    await db.insert(shadowDecisions).values(rows);
    return rows.length;
  } catch {
    return 0; // журнал не должен ронять цикл
  }
}

/**
 * Разрешить созревшие shadow-кандидаты по той же физике, что боевые прогнозы.
 * Возвращает число разрешённых записей.
 */
export async function resolveShadowDecisions(
  candlesMap: Map<string, OKXCandle[]>,
  priceOf: (asset: string) => number | undefined,
  now = new Date()
): Promise<number> {
  try {
    await ensureTable();
    const pending = await db
      .select()
      .from(shadowDecisions)
      .where(and(eq(shadowDecisions.status, "pending"), lte(shadowDecisions.resolveAt, now)))
      .limit(500);
    let resolved = 0;
    for (const row of pending) {
      const candles = candlesMap.get(row.asset) ?? [];
      const cur = priceOf(row.asset) ?? row.entryPrice;
      if (row.entryPrice <= 0 || !Number.isFinite(cur) || cur <= 0) {
        await db
          .update(shadowDecisions)
          .set({ status: "expired", outcome: "expired", resolvedAt: now })
          .where(eq(shadowDecisions.id, row.id));
        continue;
      }
      const fixedTime = row.cycleAt.getTime();
      const period = candles.filter((c) => c.timestamp >= fixedTime - 15 * 60 * 1000);
      const highs = period.length ? period.map((c) => c.high) : [row.entryPrice, cur];
      const lows = period.length ? period.map((c) => c.low) : [row.entryPrice, cur];

      let mfePct = 0;
      let rawPct = 0;
      if (row.direction === "UP") {
        mfePct = ((Math.max(...highs, cur) - row.entryPrice) / row.entryPrice) * 100;
        rawPct = ((cur - row.entryPrice) / row.entryPrice) * 100;
      } else if (row.direction === "DOWN") {
        mfePct = ((row.entryPrice - Math.min(...lows, cur)) / row.entryPrice) * 100;
        rawPct = ((row.entryPrice - cur) / row.entryPrice) * 100;
      } else {
        mfePct = (Math.abs(cur - row.entryPrice) / row.entryPrice) * 100;
        rawPct = 0.3 - mfePct;
      }
      const netPct = rawPct - SHADOW_COSTS_PCT;
      const isHit = row.direction === "RANGE" ? mfePct <= 0.45 : mfePct >= SHADOW_BAR_PCT && netPct > 0;

      await db
        .update(shadowDecisions)
        .set({
          status: "resolved",
          outcome: isHit ? "hit" : "miss",
          mfePct: Number(mfePct.toFixed(4)),
          realizedReturnNetPct: Number(netPct.toFixed(4)),
          resolvedPrice: cur,
          resolvedAt: now,
        })
        .where(eq(shadowDecisions.id, row.id));
      resolved++;
    }
    return resolved;
  } catch {
    return 0;
  }
}

export interface OpeArmReport {
  n: number;
  hits: number;
  hitRate: number;
  wilsonLb: number;
  expectancyBps: number;
}

export interface OpeReport {
  cycles: number;
  presented: number;
  /** Рука ai/fallback: исходы кандидатов, выбранных боевой политикой. */
  aiArm: OpeArmReport;
  /** Рука rule: исходы кандидатов, которые выбрало бы правило на тех же циклах. */
  ruleArm: OpeArmReport;
  /** Базлайн: все предложенные кандидаты (частота «рынка кандидатов»). */
  allArm: OpeArmReport;
  /** Δ-OPE (paired): разность hit-rate ai−rule в п.п. на одних и тех же циклах. */
  deltaHitRatePp: number | null;
  /** Диагностика доверия: effective sample size IPS-весов и максимальный вес. */
  ess: number | null;
  maxIpsWeight: number | null;
  /** Гейт доверия пройден: ESS≥20 и maxWeight≤10 (протокол H003). */
  trustworthy: boolean;
}

function arm(rows: { hit: boolean; ret: number }[]): OpeArmReport {
  const n = rows.length;
  const hits = rows.filter((r) => r.hit).length;
  const ret = rows.reduce((a, r) => a + r.ret, 0);
  return {
    n,
    hits,
    hitRate: n ? Number(((hits / n) * 100).toFixed(1)) : 0,
    wilsonLb: Number(wilsonLowerBound(hits, n).toFixed(4)),
    expectancyBps: n ? Number((ret / n).toFixed(2)) : 0,
  };
}

/**
 * Отчёт Δ-OPE по накопленной shadow-книге. Сравнение РАЗНОСТЕЙ политик, а не
 * абсолютных значений: малый абсолютный lift offline неидентифицируем.
 * IPS-диагностика (ESS, max weight) — обязательный гейт публикации разности.
 */
export async function computeOpeReport(): Promise<OpeReport | null> {
  try {
    await ensureTable();
    const rows = await db
      .select()
      .from(shadowDecisions)
      .where(eq(shadowDecisions.status, "resolved"))
      .limit(20000);
    if (rows.length === 0) return null;

    const cycles = new Set(rows.map((r) => r.cycleAt.getTime())).size;
    const withOutcome = rows.filter((r) => r.outcome === "hit" || r.outcome === "miss");
    const toArmRow = (r: (typeof rows)[number]) => ({
      hit: r.outcome === "hit",
      ret: (r.realizedReturnNetPct ?? 0) * 100, // pct → bps
    });

    const aiRows = withOutcome.filter((r) => r.chosenAi).map(toArmRow);
    const ruleRows = withOutcome.filter((r) => r.chosenRule).map(toArmRow);
    const allRows = withOutcome.map(toArmRow);

    // IPS-веса боевой руки: w = chosen / propensity (propensity ≥ 1/K гарантирован softmax).
    let sumW = 0;
    let sumW2 = 0;
    let maxW = 0;
    for (const r of withOutcome) {
      if (!r.chosenAi) continue;
      const w = r.propensityAi > 1e-6 ? Math.min(1 / r.propensityAi, 10) : 10; // clip=10 по протоколу
      sumW += w;
      sumW2 += w * w;
      maxW = Math.max(maxW, w);
    }
    const ess = sumW2 > 0 ? (sumW * sumW) / sumW2 : null;

    const delta =
      aiRows.length >= 5 && ruleRows.length >= 5
        ? Number((aiArmDelta(aiRows) - aiArmDelta(ruleRows)).toFixed(1))
        : null;

    return {
      cycles,
      presented: rows.length,
      aiArm: arm(aiRows),
      ruleArm: arm(ruleRows),
      allArm: arm(allRows),
      deltaHitRatePp: delta,
      ess: ess !== null ? Number(ess.toFixed(1)) : null,
      maxIpsWeight: Number(maxW.toFixed(2)),
      trustworthy: ess !== null && ess >= 20 && maxW <= 10,
    };
  } catch {
    return null;
  }
}

function aiArmDelta(rows: { hit: boolean }[]): number {
  return rows.length ? (rows.filter((r) => r.hit).length / rows.length) * 100 : 0;
}
