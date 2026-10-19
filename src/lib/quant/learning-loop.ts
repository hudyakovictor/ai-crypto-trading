import { db, pool } from "@/db";
import { learningWeights } from "@/db/schema";
import { eq } from "drizzle-orm";
import { CATEGORY_KEYS, CategoryKey } from "../types";

export interface CategoryLearningStats {
  category: string;
  currentWeight: number;
  priorWeight: number;
  totalSamples: number;
  totalHits: number;
  totalMisses: number;
  empiricalWinrate: number;
  brierScore: number;
  lastUpdated: string;
}

export interface RebuildResult {
  /** Сколько разрешённых исходов вошло в пересчёт (hit + miss, только live-журнал). */
  events: number;
  /** Сколько категорий получили ненулевую выборку. */
  categories: number;
  /** Общий hit-rate по всем исходам — база, с которой сравнивается каждая категория. */
  baseHitRate: number;
  /** Средний Brier заявленной вероятности (1 - uncertainty) против факта. 0.25 = прогноз «монетка». */
  averageBrier: number;
  updatedAt: string;
}

/** Байесовский приор: сколько «монеток» категория получает авансом. */
const PRIOR_ALPHA = 5;
const PRIOR_BETA = 5;
const WEIGHT_MIN = 0.25;
const WEIGHT_MAX = 2.5;
const WEIGHT_EXPONENT = 0.75;

/**
 * ОБУЧЕНИЕ ВЕСОВ.
 *
 * Прежняя версия была инкрементальной: `updateFromOutcomes(events)` прибавляла
 * счётчики. Её вызывали четыре места — цикл, автопилот после каждого цикла
 * (по ВСЕЙ истории заново), POST /api/research/learning и сидинг демо-данных.
 * Инкрементальная схема при повторном прогоне одной и той же истории даёт
 * квадратичный рост счётчиков: за 100 циклов на 500 исходах totalSamples
 * каждой категории становился ~50 000 вместо 500, байесовское сглаживание
 * теряло смысл, а веса переставали различать категории.
 *
 * Теперь пересчёт абсолютный и идемпотентный: `rebuildFromHistory()` одним
 * SQL-агрегатом считает всю историю заново и перезаписывает веса. Вызвать его
 * дважды подряд — то же самое, что один раз. Попутно исправлены ещё две вещи:
 *
 *  — Brier считается от заявленной ДО исхода вероятности (1 - uncertainty из
 *    гипотезы), а не от постериора категории, который уже включал текущий
 *    исход (self-leakage: метрика оценивала сама себя и всегда была ≈0.22);
 *  — обновление идёт одной транзакцией, поэтому конкурентные вызовы не
 *    теряют счётчики (прежний read-modify-write в памяти был не атомарен).
 *
 * Не решено и осталось в аудите (F-132): исход по-прежнему зачисляется всем
 * категориям связки поровну. Для честного вклада нужен снапшот признаков в
 * самом прогнозе и оцениваемая модель, а не 15 win-rate'ов.
 */
export class LearningLoop {
  private initialized = false;

  /** Сброс кэша инициализации — нужен после truncate/delete таблицы весов. */
  invalidateCache(): void {
    this.initialized = false;
  }

  /** Строки весов для всех 15 категорий — одним батчем, с кэшем флага. */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const values = CATEGORY_KEYS.map((cat) => ({
      categoryName: cat,
      currentWeight: 1.0,
      priorWeight: 1.0,
      totalSamples: 0,
      totalHits: 0,
      totalMisses: 0,
      empiricalWinrate: 0.5,
      brierScore: 0.25,
      regimePerformanceJson: {},
      lastUpdated: new Date(),
    }));
    await db
      .insert(learningWeights)
      .values(values)
      .onConflictDoNothing({ target: learningWeights.categoryName });
    this.initialized = true;
  }

  async getWeightsMap(): Promise<Record<string, number>> {
    await this.ensureInitialized();
    const rows = await db.select().from(learningWeights);
    const map: Record<string, number> = {};
    for (const r of rows) map[r.categoryName] = r.currentWeight;
    return map;
  }

  async getAllStats(): Promise<CategoryLearningStats[]> {
    await this.ensureInitialized();
    const rows = await db.select().from(learningWeights);
    return rows.map((r) => ({
      category: r.categoryName,
      currentWeight: r.currentWeight,
      priorWeight: r.priorWeight,
      totalSamples: r.totalSamples,
      totalHits: r.totalHits,
      totalMisses: r.totalMisses,
      empiricalWinrate: r.empiricalWinrate,
      brierScore: r.brierScore,
      lastUpdated: r.lastUpdated.toISOString(),
    }));
  }

  /**
   * Полный пересчёт весов по накопленной истории. Идемпотентен: результат
   * зависит только от содержимого forecasts/hypotheses, а не от числа вызовов.
   */
  async rebuildFromHistory(): Promise<RebuildResult> {
    await this.ensureInitialized();

    const { rows } = await pool.query<{
      category: string;
      n: number;
      hits: number;
      brier: number | null;
      events_total: number;
      hits_total: number;
      brier_total: number | null;
    }>(`
      WITH expanded AS (
        SELECT
          cat.category AS category,
          f.outcome AS outcome,
          LEAST(0.95, GREATEST(0.05, 1 - COALESCE(h.uncertainty, 0.35))) AS p_hit
        FROM forecasts f
        JOIN hypotheses h ON h.id = f.hypothesis_id
        CROSS JOIN LATERAL jsonb_array_elements_text(h.categories_json) AS cat(category)
        WHERE f.status = 'resolved' AND f.outcome IN ('hit', 'miss')
      ),
      totals AS (
        SELECT
          COUNT(*)::int AS events_total,
          COUNT(*) FILTER (WHERE outcome = 'hit')::int AS hits_total,
          AVG(POW(p_hit - (CASE WHEN outcome = 'hit' THEN 1.0 ELSE 0.0 END), 2))::float AS brier_total
        FROM expanded
      )
      SELECT
        e.category,
        COUNT(*)::int AS n,
        COUNT(*) FILTER (WHERE e.outcome = 'hit')::int AS hits,
        AVG(POW(e.p_hit - (CASE WHEN e.outcome = 'hit' THEN 1.0 ELSE 0.0 END), 2))::float AS brier,
        t.events_total,
        t.hits_total,
        t.brier_total
      FROM expanded e CROSS JOIN totals t
      GROUP BY e.category, t.events_total, t.hits_total, t.brier_total
    `);

    const byCategory = new Map(rows.map((r) => [r.category, r]));
    const totals = rows[0] ?? { events_total: 0, hits_total: 0, brier_total: null };
    const events = Number(totals.events_total) || 0;
    const baseHitRate = events > 0 ? Number(totals.hits_total) / events : 0.5;
    const averageBrier = totals.brier_total === null || totals.brier_total === undefined
      ? 0.25
      : Number(totals.brier_total);

    const now = new Date();
    let touched = 0;

    await db.transaction(async (tx) => {
      for (const cat of CATEGORY_KEYS as readonly CategoryKey[]) {
        const agg = byCategory.get(cat);
        const n = agg ? Number(agg.n) : 0;
        const hits = agg ? Number(agg.hits) : 0;
        const misses = n - hits;
        const smoothed = (hits + PRIOR_ALPHA) / (n + PRIOR_ALPHA + PRIOR_BETA);
        const multiplier = Math.pow(smoothed / 0.5, WEIGHT_EXPONENT);
        const weight = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, multiplier));
        const brier = agg && agg.brier !== null && agg.brier !== undefined ? Number(agg.brier) : 0.25;
        if (n > 0) touched++;

        await tx
          .update(learningWeights)
          .set({
            totalSamples: n,
            totalHits: hits,
            totalMisses: misses,
            empiricalWinrate: smoothed,
            brierScore: brier,
            currentWeight: Number(weight.toFixed(3)),
            lastUpdated: now,
          })
          .where(eq(learningWeights.categoryName, cat));
      }
    });

    return {
      events,
      categories: touched,
      baseHitRate: Number(baseHitRate.toFixed(4)),
      averageBrier: Number(averageBrier.toFixed(4)),
      updatedAt: now.toISOString(),
    };
  }

  /**
   * Журнал пересчёта — отдельной строкой, без выдуманных чисел.
   * Прежняя версия писала `totalSignalsProcessed: events * 4` (что «4» — не
   * означало ничего) и `learningUpdatesCount: 15` независимо от результата.
   */
  async logRebuild(result: RebuildResult, runType: string): Promise<void> {
    const { experimentRuns } = await import("@/db/schema");
    await db.insert(experimentRuns).values({
      runType,
      totalSignalsProcessed: result.events,
      combinationsGenerated: 0,
      hypothesesCreated: 0,
      forecastsResolved: 0,
      learningUpdatesCount: result.categories,
      // Маркер «режима нет»: пересчёт весов не измеряет рынок. Русская подпись
      // для него добавлена в REGIME_RU, поэтому в UI не появится английский ключ.
      regimeDetected: "NO_REGIME",
      logSummary: `Пересчёт весов: исходов ${result.events}, категорий с выборкой ${result.categories}, база hit-rate ${(
        result.baseHitRate * 100
      ).toFixed(1)}%, Brier заявленной вероятности ${result.averageBrier.toFixed(4)}.`,
      metricsJson: {
        events: result.events,
        categories: result.categories,
        baseHitRate: result.baseHitRate,
        averageBrier: result.averageBrier,
        idempotent: true,
      },
      createdAt: new Date(),
    });
  }
}

export const learningLoop = new LearningLoop();

/** Экспортировано для тестов: чистая функция байесовского сглаживания веса. */
export function smoothedWeight(hits: number, n: number): number {
  const smoothed = (hits + PRIOR_ALPHA) / (n + PRIOR_ALPHA + PRIOR_BETA);
  return Number(Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, Math.pow(smoothed / 0.5, WEIGHT_EXPONENT))).toFixed(3));
}
