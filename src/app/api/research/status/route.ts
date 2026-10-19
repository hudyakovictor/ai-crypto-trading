import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  assets,
  hypotheses,
  forecasts,
  learningWeights,
  experimentRuns,
  dataQualityLogs,
} from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { autonomousScheduler } from "@/lib/quant/autonomous-scheduler";
import { loadActiveUniverse, type ActiveUniverse } from "@/lib/quant/universe-store";
import type { UniverseMember } from "@/lib/quant/universe";
import { getAutopilotState, CYCLE_INTERVAL_MIN } from "@/lib/quant/autopilot";
import { CATEGORY_DEFINITIONS, CATEGORY_KEYS } from "@/lib/types";
import type { PlannerDecisionRow } from "@/lib/ui-types";

export const dynamic = "force-dynamic";

/**
 * Статусный экран лаборатории.
 *
 * Что изменено и почему:
 *  - Агрегаты (число активов, активных гипотез, исходы, Brier) считаются в SQL.
 *    Раньше ради четырёх чисел поднимались ВСЕ разрешённые прогнозы и все веса,
 *    а это происходило каждые 20 секунд из каждого открытого дашборда.
 *  - `empiricalHitRate` больше не выдуман: если решённых исходов нет — null,
 *    а не «50.0». То же для Brier (раньше 0.25 означало «как монетка», хотя
 *    данных не было вообще).
 *  - Хитрейт считается по hit/(hit+miss): неоднозначные исходы — это пропуск
 *    данных, а не исход, и в знаменатель им нельзя.
 */
export async function GET() {
  try {
    const assetsList = await db
      .select()
      .from(assets)
      .orderBy(desc(assets.volume24h))
      .limit(60);
    const activeHypotheses = await db
      .select()
      .from(hypotheses)
      .where(eq(hypotheses.status, "active"))
      .orderBy(desc(hypotheses.createdAt))
      .limit(10);

    const recentForecasts = await db
      .select()
      .from(forecasts)
      .orderBy(desc(forecasts.createdAt))
      .limit(20);

    const weights = await db.select().from(learningWeights);
    const recentExperiments = await db
      .select()
      .from(experimentRuns)
      .orderBy(desc(experimentRuns.createdAt))
      .limit(5);

    const qualityLogs = await db
      .select()
      .from(dataQualityLogs)
      .orderBy(desc(dataQualityLogs.createdAt))
      .limit(5);

    // Агрегаты — одним запросом к БД, без загрузки всей истории в память.
    const [countsRows, assetsRows, activeRows, brierRows] = await Promise.all([
      db
        .select({
          hits: sql<number>`count(*) filter (where ${forecasts.outcome} = 'hit')::int`,
          misses: sql<number>`count(*) filter (where ${forecasts.outcome} = 'miss')::int`,
          ambiguous: sql<number>`count(*) filter (where ${forecasts.outcome} = 'ambiguous')::int`,
          totalResolved: sql<number>`count(*)::int`,
        })
        .from(forecasts)
        .where(eq(forecasts.status, "resolved")),
      db.select({ total: sql<number>`count(*)::int` }).from(assets),
      db.select({ total: sql<number>`count(*)::int` }).from(hypotheses).where(eq(hypotheses.status, "active")),
      db
        .select({
          avg: sql<number | null>`avg(${learningWeights.brierScore}) filter (where ${learningWeights.totalSamples} > 0)`,
        })
        .from(learningWeights),
    ]);

    const counts = countsRows[0];
    const hits = counts?.hits ?? 0;
    const misses = counts?.misses ?? 0;
    const ambiguous = counts?.ambiguous ?? 0;
    const totalResolved = counts?.totalResolved ?? 0;
    const decided = hits + misses;
    const empiricalHitRate = decided > 0 ? (hits / decided) * 100 : null;
    const avgBrierRaw = brierRows[0]?.avg;
    const avgBrier = avgBrierRaw === null || avgBrierRaw === undefined ? null : Number(avgBrierRaw);

    const lastRun = autonomousScheduler.getLastRunTime();
    const lastAttempt = autonomousScheduler.getLastAttemptTime() ?? lastRun;
    const nextRun =
      autonomousScheduler.getNextRunTime() ??
      (lastAttempt ? new Date(lastAttempt.getTime() + CYCLE_INTERVAL_MIN * 60 * 1000) : null);
    const now = Date.now();
    // null, когда процесс ещё не сделал ни одной попытки: «900» здесь было выдумкой.
    const secondsToNextRun = nextRun ? Math.max(0, Math.floor((nextRun.getTime() - now) / 1000)) : null;

    const autopilot = getAutopilotState();
    const latestRunMetrics = (recentExperiments[0]?.metricsJson ?? {}) as {
      latencyMs?: number;
      isLiveOKX?: boolean;
      listedCount?: number;
      floorCount?: number;
      planner?: PlannerDecisionRow;
    };
    const latestQuality = qualityLogs[0] ?? null;

    // Состав вселенной: UI объясняет, какие пары система выбрала сама и почему.
    // Ошибку скана не роняем — статусный экран важнее пустой строки отбора.
    // Сканировать OKX при каждом поллинге статуса нельзя: это ~33 запроса к бирже
    // на каждое обращение read-only-эндпоинта, поэтому скан здесь запрещён.
    let activeUniverse: UniverseMember[] = [];
    let universeSource: ActiveUniverse["source"] | "none" = "none";
    try {
      const loaded = await loadActiveUniverse({ allowScan: false });
      activeUniverse = loaded.universe;
      universeSource = loaded.source;
    } catch {
      activeUniverse = [];
    }

    return NextResponse.json({
      success: true,
      isLive: latestRunMetrics.isLiveOKX ?? null,
      latestLatencyMs: latestRunMetrics.latencyMs ?? latestQuality?.latencyMs ?? null,
      latestRegime: recentExperiments[0]?.regimeDetected ?? null,
      dataQuality: latestQuality?.status ?? null,
      universe: activeUniverse,
      universeSize: activeUniverse.length,
      universeSource,
      universeListedCount: latestRunMetrics.listedCount ?? null,
      universeFloorCount: latestRunMetrics.floorCount ?? null,
      // Кто решил этот цикл: после рестарта процесса берём сохранённое решение из БД
      planner: autonomousScheduler.getPlannerDecision() ?? latestRunMetrics.planner ?? null,
      autopilot: {
        enabled: autopilot.enabled,
        cyclesCompleted: autopilot.cyclesCompleted,
        cyclesFailed: autopilot.cyclesFailed,
        lastCycleAt: autopilot.lastCycleAt,
        lastError: autopilot.lastError,
      },
      scheduler: {
        lastRunTime: lastRun ? lastRun.toISOString() : null,
        nextRunTime: nextRun ? nextRun.toISOString() : null,
        secondsToNextRun,
        intervalMinutes: CYCLE_INTERVAL_MIN,
      },
      stats: {
        totalAssetsTracked: assetsRows[0]?.total ?? assetsList.length,
        activeHypothesesCount: activeRows[0]?.total ?? activeHypotheses.length,
        totalResolved,
        hits,
        misses,
        ambiguous,
        empiricalHitRate,
        averageBrierScore: avgBrier,
      },
      assets: assetsList,
      activeHypotheses,
      recentForecasts,
      learningWeights: weights,
      recentExperiments,
      qualityLogs,
      categoryDefinitions: CATEGORY_DEFINITIONS,
      categoryKeys: CATEGORY_KEYS,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to load research status";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
