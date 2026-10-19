import { autonomousScheduler, type CycleResult } from "./autonomous-scheduler";

/**
 * СЕРВЕРНЫЙ АВТОПИЛОТ ЛАБОРАТОРИИ.
 *
 * Раз в минуту проверяет: пора ли новый цикл (каждые 15 минут). Цикл: OKX →
 * вселенная → 15 категорий → связки → планировщик решает, сколько из них
 * оформить гипотезами (ноль — корректный ответ) → разрешение созревших
 * прогнозов → пересчёт весов на всей накопленной истории.
 *
 * Что изменено относительно прежней версии и почему:
 *
 *  1. Удалено «полное переобучение на всей истории» после каждого цикла.
 *     Оно передавало ВСЕ разрешённые прогнозы в инкрементальный обновлятор
 *     весов, поэтому каждый исход учитывался заново каждый цикл: за 100 циклов
 *     на 500 исходах totalSamples категории становился ~50 000 вместо 500,
 *     байесовское сглаживание теряло смысл, а веса переставали различать
 *     категории. Пересчёт весов теперь делает сам цикл — идемпотентно
 *     (learningLoop.rebuildFromHistory).
 *  2. Каденс один: 15 минут из единой константы, а не «14 минут здесь и
 *     15 минут в планировщике».
 *  3. Добавлен экспоненциальный backoff при авариях: раньше упавший цикл
 *     перезапускался каждую минуту (шторм запросов к OKX и LLM), потому что
 *     lastRunTime обновлялся только после успеха.
 *  4. Старт из `instrumentation.ts` — автопилот больше не зависит от того,
 *     открыт ли в браузере дашборд.
 */

/** Интервал между циклами, минуты. Единственный источник правды. */
export const CYCLE_INTERVAL_MIN = 15;
/** Как часто автопилот смотрит на часы, секунды. */
const TICK_SEC = 60;
/** Потолок backoff после серии аварий, минуты. */
const MAX_BACKOFF_MIN = 60;

interface AutopilotState {
  started: boolean;
  enabled: boolean;
  intervalSec: number;
  cyclesCompleted: number;
  cyclesFailed: number;
  lastCycleAt: string | null;
  lastCycleSummary: string | null;
  lastError: string | null;
}

const g = globalThis as typeof globalThis & {
  __quantAutopilot?: AutopilotState;
  __quantAutopilotTimer?: ReturnType<typeof setInterval>;
};

function state(): AutopilotState {
  if (!g.__quantAutopilot) {
    g.__quantAutopilot = {
      started: false,
      enabled: process.env.AUTOPILOT !== "0",
      intervalSec: TICK_SEC,
      cyclesCompleted: 0,
      cyclesFailed: 0,
      lastCycleAt: null,
      lastCycleSummary: null,
      lastError: null,
    };
  }
  return g.__quantAutopilot;
}

/** Сколько миллисекунд нужно подождать после последней попытки, учитывая аварии. */
function requiredGapMs(): number {
  const failures = autonomousScheduler.getConsecutiveErrors();
  if (failures <= 0) return CYCLE_INTERVAL_MIN * 60 * 1000;
  const backoffMin = Math.min(MAX_BACKOFF_MIN, CYCLE_INTERVAL_MIN * Math.pow(2, failures - 1));
  return backoffMin * 60 * 1000;
}

async function tick(): Promise<void> {
  const s = state();
  if (!s.enabled) return;

  const last = autonomousScheduler.getLastAttemptTime() ?? autonomousScheduler.getLastRunTime();
  if (last && Date.now() - last.getTime() < requiredGapMs()) return;

  let result: CycleResult;
  try {
    result = await autonomousScheduler.runCycle(false);
  } catch (err) {
    s.cyclesFailed++;
    s.lastError = err instanceof Error ? err.message : "cycle failed";
    return;
  }

  if (result.skipped) return;

  s.cyclesCompleted++;
  s.lastCycleAt = result.timestamp;
  s.lastCycleSummary = result.summary;
  s.lastError = null;
}

/** Запуск серверного расписания. Идемпотентен: повторный вызов не плодит таймеры. */
export function ensureAutopilot(): AutopilotState {
  const s = state();
  if (!s.started) {
    s.started = true;
    if (g.__quantAutopilotTimer) clearInterval(g.__quantAutopilotTimer);
    const timer = setInterval(() => void tick(), s.intervalSec * 1000);
    if (typeof timer.unref === "function") timer.unref();
    g.__quantAutopilotTimer = timer;
    void tick();
  }
  return s;
}

export function setAutopilotEnabled(enabled: boolean): AutopilotState {
  const s = ensureAutopilot();
  s.enabled = enabled;
  if (enabled) void tick();
  return s;
}

export function getAutopilotState(): AutopilotState {
  return ensureAutopilot();
}
