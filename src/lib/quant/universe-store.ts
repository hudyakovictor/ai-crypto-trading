import { db } from "@/db";
import { experimentRuns } from "@/db/schema";
import { desc } from "drizzle-orm";
import { autonomousScheduler } from "./autonomous-scheduler";
import { UNIVERSE_CONFIG, scanUniverse, type UniverseMember } from "./universe";

export interface ActiveUniverse {
  universe: UniverseMember[];
  /** Откуда взялся состав: важно для честной подписи в UI. */
  source: "memory" | "persisted" | "live-scan";
  cycleMs?: number;
}

function isUniverseArray(value: unknown): value is UniverseMember[] {
  return (
    Array.isArray(value) &&
    value.every(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as UniverseMember).symbol === "string" &&
        typeof (m as UniverseMember).score === "number"
    )
  );
}

let scanCache: { at: number; result: ActiveUniverse } | null = null;
let scanFallbacks = 0;
const SCAN_TTL_MS = 90_000;

/**
 * Актуальный состав вселенной для read-only эндпоинтов.
 *
 * Порядок: память процесса → последний записанный цикл → живой скан.
 * Живой скан это редкий путь (первый запуск после рестарта сервера), поэтому
 * он и оправдывает свою латентность, и не даёт UI показывать пустой экран.
 */
export async function loadActiveUniverse(): Promise<ActiveUniverse> {
  const inMemory = autonomousScheduler.getUniverse();
  if (inMemory.length > 0) {
    return { universe: inMemory, source: "memory" };
  }

  try {
    const rows = await db
      .select({ metricsJson: experimentRuns.metricsJson, createdAt: experimentRuns.createdAt })
      .from(experimentRuns)
      .orderBy(desc(experimentRuns.createdAt))
      .limit(5);

    for (const row of rows) {
      const metrics = (row.metricsJson ?? {}) as {
        universe?: unknown;
        cycleMs?: number;
      };
      if (isUniverseArray(metrics.universe) && metrics.universe.length > 0) {
        return {
          universe: metrics.universe,
          source: "persisted",
          cycleMs: typeof metrics.cycleMs === "number" ? metrics.cycleMs : undefined,
        };
      }
    }
  } catch {
    /* БД недоступна — уходим в живой скан */
  }

  // Живой скан недешёв, а статусный экран опрашивается каждые 20 секунд:
  // держим результат в кэше, пока планировщик не выполнит первый цикл.
  if (scanCache && Date.now() - scanCache.at < SCAN_TTL_MS) {
    return scanCache.result;
  }
  const { universe } = await scanUniverse(UNIVERSE_CONFIG, scanFallbacks++);
  const result: ActiveUniverse = { universe, source: "live-scan" };
  scanCache = { at: Date.now(), result };
  return result;
}
