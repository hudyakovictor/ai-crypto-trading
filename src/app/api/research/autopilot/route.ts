import { NextResponse } from "next/server";
import { getAutopilotState, setAutopilotEnabled, CYCLE_INTERVAL_MIN } from "@/lib/quant/autopilot";
import { autonomousScheduler } from "@/lib/quant/autonomous-scheduler";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = getAutopilotState();
  // Каденс считается от последней ПОПЫТКИ (успешной или нет): иначе после
  // аварии ETA показывал время от последнего успеха и врал на часы.
  const last = autonomousScheduler.getLastAttemptTime() ?? autonomousScheduler.getLastRunTime();
  const etaSec = last
    ? Math.max(0, Math.round((last.getTime() + CYCLE_INTERVAL_MIN * 60 * 1000 - Date.now()) / 1000))
    : null;
  return NextResponse.json({
    success: true,
    autopilot: {
      enabled: s.enabled,
      cyclesCompleted: s.cyclesCompleted,
      cyclesFailed: s.cyclesFailed,
      lastCycleAt: s.lastCycleAt,
      lastCycleSummary: s.lastCycleSummary,
      lastError: s.lastError,
      intervalMin: CYCLE_INTERVAL_MIN,
      nextCycleEtaSec: etaSec,
    },
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { enabled?: boolean };
  const s = setAutopilotEnabled(body.enabled !== false);
  return NextResponse.json({
    success: true,
    autopilot: {
      enabled: s.enabled,
      cyclesCompleted: s.cyclesCompleted,
      cyclesFailed: s.cyclesFailed,
      intervalMin: CYCLE_INTERVAL_MIN,
    },
    message: s.enabled
      ? `Автопилот включён: сервер сам запускает цикл каждые ${CYCLE_INTERVAL_MIN} минут; сколько гипотез оформлять, решает планировщик (ноль — полноценный ответ)`
      : "Автопилот выключен: циклы запускаются только вручную (клавиша R)",
  });
}
