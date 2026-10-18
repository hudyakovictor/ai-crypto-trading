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
import { desc, eq } from "drizzle-orm";
import { autonomousScheduler } from "@/lib/quant/autonomous-scheduler";
import { loadActiveUniverse, type ActiveUniverse } from "@/lib/quant/universe-store";
import type { UniverseMember } from "@/lib/quant/universe";
import { getAutopilotState } from "@/lib/quant/autopilot";
import { CATEGORY_DEFINITIONS, CATEGORY_KEYS } from "@/lib/types";
import type { PlannerDecisionRow } from "@/lib/ui-types";

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

    // Compute aggregate forecast outcome statistics
    const resolvedForecasts = await db
      .select()
      .from(forecasts)
      .where(eq(forecasts.status, "resolved"));

    const hits = resolvedForecasts.filter((f) => f.outcome === "hit").length;
    const misses = resolvedForecasts.filter((f) => f.outcome === "miss").length;
    const ambiguous = resolvedForecasts.filter((f) => f.outcome === "ambiguous").length;
    const totalResolved = resolvedForecasts.length;
    const empiricalHitRate = totalResolved > 0 ? (hits / totalResolved) * 100 : 50.0;

    // Average Brier score
    const avgBrier = weights.length > 0
      ? weights.reduce((acc, w) => acc + w.brierScore, 0) / weights.length
      : 0.25;

    const lastRun = autonomousScheduler.getLastRunTime();
    const nextRun = autonomousScheduler.getNextRunTime();
    const now = Date.now();
    const secondsToNextRun = nextRun ? Math.max(0, Math.floor((nextRun.getTime() - now) / 1000)) : 900;

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
    let activeUniverse: UniverseMember[] = [];
    let universeSource: ActiveUniverse["source"] | "none" = "none";
    try {
      const loaded = await loadActiveUniverse();
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
        retrainsCompleted: autopilot.retrainsCompleted,
      },
      scheduler: {
        lastRunTime: lastRun ? lastRun.toISOString() : null,
        nextRunTime: nextRun ? nextRun.toISOString() : null,
        secondsToNextRun,
        intervalMinutes: 15,
      },
      stats: {
        totalAssetsTracked: assetsList.length,
        activeHypothesesCount: activeHypotheses.length,
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
