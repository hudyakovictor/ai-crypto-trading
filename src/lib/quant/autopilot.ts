import { db } from "@/db";
import { forecasts, hypotheses } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { autonomousScheduler, type CycleResult } from "./autonomous-scheduler";
import { learningLoop } from "./learning-loop";

/**
 * СЕРВЕРНЫЙ АВТОПИЛОТ ЛАБОРАТОРИИ
 * Раз в минуту проверяет: пора ли новый цикл (каждые ~14 минут).
 * Цикл: OKX → вселенная → 15 категорий → связки → планировщик решает
 * сколько из них оформить гипотезами (ноль — корректный ответ) →
 * разрешение созревших прогнозов → ПОЛНОЕ переобучение весов
 * на всей накопленной истории. Чем дольше работает — тем точнее.
 */

interface AutopilotState {
  started: boolean;
  enabled: boolean;
  intervalSec: number;
  cyclesCompleted: number;
  retrainsCompleted: number;
  lastCycleAt: string | null;
  lastCycleSummary: string | null;
  lastError: string | null;
  /** Курсор дедупликации: прогнозы с id ≤ уже переобучены автопилотом. */
  lastRetrainedForecastId: number;
}

const g = globalThis as typeof globalThis & { __quantAutopilot?: AutopilotState };

function state(): AutopilotState {
  if (!g.__quantAutopilot) {
    g.__quantAutopilot = {
      started: false,
      enabled: true,
      intervalSec: 60,
      cyclesCompleted: 0,
      retrainsCompleted: 0,
      lastRetrainedForecastId: 0,
      lastCycleAt: null,
      lastCycleSummary: null,
      lastError: null,
    };
  }
  return g.__quantAutopilot;
}

async function tick() {
  const s = state();
  if (!s.enabled) return;

  const lastRun = autonomousScheduler.getLastRunTime();
  if (lastRun && Date.now() - lastRun.getTime() < 14 * 60 * 1000) return;

  let result: CycleResult;
  try {
    result = await autonomousScheduler.runCycle(false);
  } catch (err) {
    s.lastError = err instanceof Error ? err.message : "cycle failed";
    return;
  }

  s.cyclesCompleted++;
  s.lastCycleAt = result.timestamp;
  s.lastCycleSummary = result.summary;
  s.lastError = null;

  // Переобучение на НОВЫХ исходах после каждого цикла.
  // Две защиты от двойного счёта (важны после λ-decay и режимных апостериоров):
  //  — курсор lastRetrainedForecastId: каждый прогноз автопилот обучает один раз;
  //  — исходы последних 2 минут пропущены: их уже обучил сам цикл планировщика.
  try {
    const resolved = await db
      .select()
      .from(forecasts)
      .where(eq(forecasts.status, "resolved"))
      .orderBy(asc(forecasts.createdAt));
    const hyps = await db.select().from(hypotheses);
    const hypMap = new Map(hyps.map((h) => [h.id, h]));
    const cycleCutoff = Date.now() - 2 * 60 * 1000;
    const fresh = resolved.filter(
      (f) => f.id > s.lastRetrainedForecastId && (!f.resolvedAt || f.resolvedAt.getTime() < cycleCutoff)
    );
    const events = fresh
      .filter((f) => f.hypothesisId)
      .map((f) => {
        const h = hypMap.get(f.hypothesisId!);
        const plannerMeta = (h?.scoreComponentsJson as {
          planner?: { conviction?: number; regimeAtCreation?: string };
        } | null)?.planner;
        return {
          categories: (h?.categoriesJson as string[]) ?? [],
          outcome: (f.outcome ?? "miss") as "hit" | "miss" | "ambiguous" | "expired",
          realizedReturn: f.realizedReturnNet ?? 0,
          regime: plannerMeta?.regimeAtCreation,
          statedProb: plannerMeta?.conviction ?? (h ? 1 - (h.uncertainty ?? 0.35) : undefined),
        };
      })
      .filter((e) => e.categories.length > 0);
    if (events.length > 0) {
      await learningLoop.updateFromOutcomes(events);
      s.retrainsCompleted++;
    }
    if (resolved.length > 0) {
      s.lastRetrainedForecastId = Math.max(
        s.lastRetrainedForecastId,
        ...resolved.map((f) => f.id).filter((id) => typeof id === "number")
      );
    }
  } catch (err) {
    s.lastError = err instanceof Error ? err.message : "retrain failed";
  }
}

export function ensureAutopilot(): AutopilotState {
  const s = state();
  if (!s.started) {
    s.started = true;
    const timer = setInterval(() => void tick(), s.intervalSec * 1000);
    if (typeof timer.unref === "function") timer.unref();
    void tick();
  }
  return s;
}

export function setAutopilotEnabled(enabled: boolean): AutopilotState {
  const s = ensureAutopilot();
  s.enabled = enabled;
  return s;
}

export function getAutopilotState(): AutopilotState {
  return ensureAutopilot();
}
