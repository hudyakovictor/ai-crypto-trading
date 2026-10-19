import { NextResponse } from "next/server";
import { autonomousScheduler } from "@/lib/quant/autonomous-scheduler";
import { CYCLE_INTERVAL_MIN } from "@/lib/quant/autopilot";

/** Цикл включает решение модели об отборе: бюджет времени выше прежних 30 с. */
export const maxDuration = 75;
/** Цикл ходит в БД и на OKX: статическая оценка/кэш ответа недопустимы. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Запуск исследовательского цикла.
 *
 * POST — единственная команда «выполни цикл сейчас».
 * GET больше НЕ запускает цикл: раньше это был side-effectful GET, то есть
 * любой префетчер браузера, мониторинг доступности, сканер или случайное
 * открытие ссылки выполняли полный цикл — писали в журнал прогнозов, жгли
 * лимиты OKX и вызовы LLM. GET теперь read-only и отдаёт состояние
 * планировщика.
 */
export async function POST(req: Request) {
  try {
    let isManual = true;
    try {
      const body = (await req.json()) as { isManual?: unknown };
      if (body?.isManual !== undefined) {
        isManual = Boolean(body.isManual);
      }
    } catch {
      // Тело может быть пустым — это ручной запуск по умолчанию.
    }

    const result = await autonomousScheduler.runCycle(isManual);

    // Пропущенный цикл не должен выглядеть успешным: UI иначе показывает тост
    // «Цикл завершён» для цикла, которого не было.
    if (result.skipped) {
      return NextResponse.json({ success: false, skipped: result.skipped, error: result.summary }, { status: 409 });
    }

    return NextResponse.json({ success: true, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error in cycle runner";
    console.error("[cycle] выполнение цикла упало:", err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function GET() {
  const lastRun = autonomousScheduler.getLastRunTime();
  const lastAttempt = autonomousScheduler.getLastAttemptTime();
  const nextRun = autonomousScheduler.getNextRunTime();
  return NextResponse.json({
    success: true,
    running: autonomousScheduler.isCycleRunning(),
    scheduler: {
      lastRunTime: lastRun ? lastRun.toISOString() : null,
      lastAttemptTime: lastAttempt ? lastAttempt.toISOString() : null,
      nextRunTime: nextRun ? nextRun.toISOString() : null,
      intervalMinutes: CYCLE_INTERVAL_MIN,
      consecutiveErrors: autonomousScheduler.getConsecutiveErrors(),
    },
    lastDecision: autonomousScheduler.getPlannerDecision(),
    universe: autonomousScheduler.getUniverse(),
    hint: "Цикл запускается серверным автопилотом либо командой POST /api/research/cycle.",
  });
}
