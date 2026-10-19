import { db } from "@/db";
import { learningWeights, experimentRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import { CATEGORY_KEYS } from "../types";

/**
 * ОБУЧАЮЩИЙ КОНТУР (H005 + честный Brier H002).
 *
 * Изменения против v1:
 *  1. ЧЕСТНЫЙ BRIER: если событие несёт statedProb (вероятность, которую
 *     планировщик реально заявил — planner conviction), Brier считается от неё.
 *     Старый код считал Brier от собственного сглаженного winrate — метрика
 *     измеряла саму себя [R05]. Fallback без statedProb помечен internal и
 *     в агрегированный «внешний» Brier не идёт.
 *  2. REGIME POSTERIORS: исходы накапливаются в regimePerformanceJson по
 *     режимам; веса категорий умножаются на фактор (wr_regime/wr_global)^0.5,
 *     clamp [0.25, 2.5]. При n_regime < 10 фактор = 1 (данных мало — не верим).
 *  3. ЗАБЫВАНИЕ λ=0.995 на батч: скользящая память против стационарного
 *     допущения (режимы крипторынка сменяются быстрее, чем накапливаются веса).
 */

/** forgetting factor per update batch (протокол P3/H005, заморожен). */
const LAMBDA_DECAY = 0.995;
/** Приоритет Beta для режимных апостериоров: α0=β0=5. */
const REGIME_PRIOR_A = 5;
const REGIME_PRIOR_B = 5;
/** Минимальное число исходов режима, чтобы его фактор применялся. */
const REGIME_MIN_N = 10;

export interface RegimePerf {
  alpha: number;
  beta: number;
  n: number;
  /** Множитель категории в этом режиме (1.0 при n < REGIME_MIN_N). */
  w: number;
}

export interface CategoryLearningStats {
  category: string;
  currentWeight: number;
  priorWeight: number;
  totalSamples: number;
  totalHits: number;
  totalMisses: number;
  empiricalWinrate: number;
  brierScore: number;
  /** Brier только по событиям с внешней statedProb (честная метрика). */
  brierExternal: number | null;
  nExternal: number;
  regimePerf: Record<string, RegimePerf>;
  lastUpdated: string;
}

export interface ResolvedEvent {
  categories: string[];
  outcome: "hit" | "miss" | "ambiguous" | "expired";
  realizedReturn: number;
  /** Режим на момент создания гипотезы (scoreComponentsJson.planner.regimeAtCreation). */
  regime?: string;
  /** Вероятность hit, заявленная системой (planner conviction). */
  statedProb?: number;
}

export class LearningLoop {
  /**
   * Ensure default weights exist in PostgreSQL for all 15 categories.
   */
  async ensureInitialized(): Promise<void> {
    for (const cat of CATEGORY_KEYS) {
      const existing = await db
        .select()
        .from(learningWeights)
        .where(eq(learningWeights.categoryName, cat))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(learningWeights).values({
          categoryName: cat,
          currentWeight: 1.0,
          priorWeight: 1.0,
          totalSamples: 0,
          totalHits: 0,
          totalMisses: 0,
          empiricalWinrate: 0.50,
          brierScore: 0.25,
          regimePerformanceJson: {},
          lastUpdated: new Date(),
        });
      }
    }
  }

  /**
   * Веса категорий для генерации комбинаций.
   * При указании режима — глобальный вес × режимный фактор (H005):
   *   factor = clamp( ((α_r+5)/(α_r+β_r+10)) / max(wr_global, 0.01) )^0.5, [0.25, 2.5]
   *   при n_r < 10 factor = 1 (недостаточно данных — глобальный вес как есть).
   */
  async getWeightsMap(regime?: string): Promise<Record<string, number>> {
    await this.ensureInitialized();
    const rows = await db.select().from(learningWeights);
    const map: Record<string, number> = {};
    for (const r of rows) {
      const base = r.currentWeight;
      if (!regime) {
        map[r.categoryName] = base;
        continue;
      }
      const perf = (r.regimePerformanceJson as Record<string, RegimePerf> | null)?.[regime];
      if (!perf || perf.n < REGIME_MIN_N) {
        map[r.categoryName] = base;
        continue;
      }
      const wrRegime = (perf.alpha + REGIME_PRIOR_A) / (perf.alpha + perf.beta + REGIME_PRIOR_A + REGIME_PRIOR_B);
      const wrGlobal = Math.max(r.empiricalWinrate || 0.01, 0.01);
      const factor = Math.max(0.25, Math.min(2.5, Math.pow(wrRegime / wrGlobal, 0.5)));
      map[r.categoryName] = Number((base * factor).toFixed(4));
    }
    return map;
  }

  /**
   * Retrieves all learning stats for the UI.
   */
  async getAllStats(): Promise<CategoryLearningStats[]> {
    await this.ensureInitialized();
    const rows = await db.select().from(learningWeights);
    return rows.map((r) => {
      const ext = (r.regimePerformanceJson as Record<string, unknown> | null)?.__brierExternal as
        | { sum: number; n: number }
        | undefined;
      const perf = (r.regimePerformanceJson as Record<string, RegimePerf> | null) ?? {};
      const regimePerf: Record<string, RegimePerf> = {};
      for (const [k, v] of Object.entries(perf)) {
        if (k.startsWith("__")) continue;
        regimePerf[k] = v;
      }
      return {
        category: r.categoryName,
        currentWeight: r.currentWeight,
        priorWeight: r.priorWeight,
        totalSamples: r.totalSamples,
        totalHits: r.totalHits,
        totalMisses: r.totalMisses,
        empiricalWinrate: r.empiricalWinrate,
        brierScore: r.brierScore,
        brierExternal: ext && ext.n > 0 ? Number((ext.sum / ext.n).toFixed(4)) : null,
        nExternal: ext?.n ?? 0,
        regimePerf,
        lastUpdated: r.lastUpdated.toISOString(),
      };
    });
  }

  /**
   * Updates category weights based on resolved outcomes.
   * Bayesian smoothing + forgetting + regime posteriors + honest Brier.
   */
  async updateFromOutcomes(
    resolvedEvents: ResolvedEvent[]
  ): Promise<{ updatedCount: number; averageBrier: number; averageBrierExternal: number | null }> {
    if (resolvedEvents.length === 0) return { updatedCount: 0, averageBrier: 0.25, averageBrierExternal: null };

    await this.ensureInitialized();
    const currentRows = await db.select().from(learningWeights);
    const statsMap = new Map(currentRows.map((r) => [r.categoryName, r]));

    let totalBrierSum = 0;
    let brierEvalCount = 0;
    let extBrierSum = 0;
    let extBrierCount = 0;

    for (const event of resolvedEvents) {
      if (event.outcome !== "hit" && event.outcome !== "miss") continue;
      const isHit = event.outcome === "hit";
      const actualTarget = isHit ? 1.0 : 0.0;

      // Честный Brier: внешняя заявленная вероятность, clamp 0.02–0.98.
      const stated =
        typeof event.statedProb === "number" && Number.isFinite(event.statedProb)
          ? Math.min(0.98, Math.max(0.02, event.statedProb))
          : null;

      for (const cat of event.categories) {
        const row = statsMap.get(cat);
        if (!row) continue;

        // Забывание λ=0.995 на батч — память конечна, режимы дрейфуют.
        row.totalSamples = Number((row.totalSamples * LAMBDA_DECAY).toFixed(3));
        row.totalHits = Number((row.totalHits * LAMBDA_DECAY).toFixed(3));
        row.totalMisses = Number((row.totalMisses * LAMBDA_DECAY).toFixed(3));

        const newHits = row.totalHits + (isHit ? 1 : 0);
        const newTotal = row.totalSamples + 1;

        // Bayesian smoothed win rate (prior alpha=5, beta=5)
        const smoothedWinRate = (newHits + 5) / (newTotal + 10);

        // Brier: внешняя statedProb, если есть; иначе fallback от smoothed (internal).
        const forecastProb = stated ?? Math.min(0.9, Math.max(0.1, smoothedWinRate));
        const sampleBrier = Math.pow(forecastProb - actualTarget, 2);
        const newBrier = (row.brierScore * row.totalSamples + sampleBrier) / newTotal;

        // Dynamic weight adjustment: base 1.0 * (winrate / 0.50)^0.75, bounded [0.25, 2.5]
        const multiplier = Math.pow(smoothedWinRate / 0.5, 0.75);
        const newWeight = Math.max(0.25, Math.min(2.5, row.priorWeight * multiplier));

        row.totalHits = newHits;
        row.totalSamples = newTotal;
        row.empiricalWinrate = smoothedWinRate;
        row.brierScore = newBrier;
        row.currentWeight = Number(newWeight.toFixed(3));

        // Регимный апостериор Beta(α0+hits, β0+misses) в regimePerformanceJson.
        const perf = ((row.regimePerformanceJson as Record<string, unknown> | null) ?? {}) as Record<
          string,
          RegimePerf | { sum: number; n: number }
        >;
        const regimeKey = event.regime ?? "UNKNOWN";
        const rp = (perf[regimeKey] as RegimePerf | undefined) ?? { alpha: 0, beta: 0, n: 0, w: 1 };
        rp.alpha += isHit ? 1 : 0;
        rp.beta += isHit ? 0 : 1;
        rp.n += 1;
        perf[regimeKey] = rp;

        // Аккумуляторы внешнего Brier (служебный ключ, UI не показывает как режим).
        const ext = (perf.__brierExternal as { sum: number; n: number } | undefined) ?? { sum: 0, n: 0 };
        if (stated !== null) {
          ext.sum += sampleBrier;
          ext.n += 1;
          perf.__brierExternal = ext;
          extBrierSum += sampleBrier;
          extBrierCount++;
        }

        row.regimePerformanceJson = perf as object;

        totalBrierSum += sampleBrier;
        brierEvalCount++;
      }
    }

    // Пересчитать w каждого режима относительно глобального winrate категории.
    for (const [, row] of statsMap) {
      const perf = (row.regimePerformanceJson as Record<string, unknown> | null) as
        | Record<string, RegimePerf | { sum: number; n: number }>
        | null;
      if (!perf) continue;
      const wrGlobal = Math.max(row.empiricalWinrate || 0.01, 0.01);
      for (const [k, v] of Object.entries(perf)) {
        if (k.startsWith("__")) continue;
        const rp = v as RegimePerf;
        if (rp.n < REGIME_MIN_N) {
          rp.w = 1;
          continue;
        }
        const wrR = (rp.alpha + REGIME_PRIOR_A) / (rp.alpha + rp.beta + REGIME_PRIOR_A + REGIME_PRIOR_B);
        rp.w = Number(Math.max(0.25, Math.min(2.5, Math.pow(wrR / wrGlobal, 0.5))).toFixed(4));
      }
      row.regimePerformanceJson = perf as object;

      // Persist updated weights back to Postgres
      await db
        .update(learningWeights)
        .set({
          totalHits: row.totalHits,
          totalMisses: row.totalMisses,
          totalSamples: row.totalSamples,
          empiricalWinrate: row.empiricalWinrate,
          brierScore: row.brierScore,
          currentWeight: row.currentWeight,
          regimePerformanceJson: row.regimePerformanceJson ?? {},
          lastUpdated: new Date(),
        })
        .where(eq(learningWeights.categoryName, row.categoryName));
    }

    const avgBrier = brierEvalCount > 0 ? totalBrierSum / brierEvalCount : 0.25;
    const avgBrierExternal = extBrierCount > 0 ? extBrierSum / extBrierCount : null;

    // Log experiment run to audit trail
    await db.insert(experimentRuns).values({
      runType: "online_learning_update",
      totalSignalsProcessed: resolvedEvents.length * 4,
      combinationsGenerated: 0,
      hypothesesCreated: 0,
      forecastsResolved: resolvedEvents.length,
      learningUpdatesCount: statsMap.size,
      regimeDetected: "ADAPTIVE",
      logSummary: `Updated Bayesian weights for ${statsMap.size} categories across ${resolvedEvents.length} resolved events (λ=${LAMBDA_DECAY}). Brier avg ${avgBrier.toFixed(4)}${avgBrierExternal !== null ? `, external ${avgBrierExternal.toFixed(4)} (n=${extBrierCount})` : ", external n/a"}.`,
      metricsJson: {
        avgBrier,
        avgBrierExternal,
        externalCount: extBrierCount,
        resolvedCount: resolvedEvents.length,
        lambda: LAMBDA_DECAY,
      },
      createdAt: new Date(),
    });

    return { updatedCount: statsMap.size, averageBrier: avgBrier, averageBrierExternal: avgBrierExternal };
  }
}

export const learningLoop = new LearningLoop();
