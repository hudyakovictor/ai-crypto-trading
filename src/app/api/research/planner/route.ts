import { NextResponse } from "next/server";
import { db } from "@/db";
import { experimentRuns } from "@/db/schema";
import { desc } from "drizzle-orm";
import { autonomousScheduler } from "@/lib/quant/autonomous-scheduler";
import { loadSelectionRecord } from "@/lib/quant/planner";
import { loadPolicy } from "@/lib/quant/policy";
import type { PlannerDecisionRow, PlannerResponse } from "@/lib/ui-types";

export const dynamic = "force-dynamic";

function decisionOf(metrics: unknown): PlannerDecisionRow | null {
  const planner = (metrics as { planner?: PlannerDecisionRow } | null)?.planner;
  return planner && Array.isArray(planner.picks) ? planner : null;
}

/**
 * Экран «кто решает». Возвращает последнее решение об отборе, историю решений по
 * циклам и раздельную статистику исходов: выбирала ли модель лучше правила.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const runs = await db
      .select({
        createdAt: experimentRuns.createdAt,
        metricsJson: experimentRuns.metricsJson,
        hypothesesCreated: experimentRuns.hypothesesCreated,
      })
      .from(experimentRuns)
      .orderBy(desc(experimentRuns.createdAt))
      .limit(14);

    const persisted = runs
      .map((r) => ({ run: r, decision: decisionOf(r.metricsJson) }))
      .filter((x) => x.decision !== null);

    const decision = autonomousScheduler.getPlannerDecision() ?? persisted[0]?.decision ?? null;

    const history = persisted.slice(0, 12).map(({ run, decision: d }) => ({
      createdAt: run.createdAt.toISOString(),
      mode: d!.mode,
      offered: d!.offered,
      picked: run.hypothesesCreated,
      summary: d!.narrative.slice(0, 160),
    }));

    // Короткая сводка по последним циклам: «модель решила сама» должно быть видно
    // как факт, а не как обещание.
    const summary = {
      cycles: history.length,
      aiCycles: history.filter((h) => h.mode === "ai").length,
      fallbackCycles: history.filter((h) => h.mode !== "ai").length,
      emptyCycles: history.filter((h) => h.picked === 0).length,
    };

    const [record, policy] = await Promise.all([loadSelectionRecord(), loadPolicy()]);

    const body: PlannerResponse = {
      success: true,
      decision,
      history,
      record,
      summary,
      policy: { authority: policy.authority, ceiling: policy.ceiling },
    };
    return NextResponse.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load planner state";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
