import { NextResponse } from "next/server";
import { autonomousScheduler } from "@/lib/quant/autonomous-scheduler";

/** Цикл теперь включает решение модели об отборе: бюджет времени выше прежних 30 с. */
export const maxDuration = 75;

export async function POST(req: Request) {
  try {
    let isManual = true;
    try {
      const body = await req.json();
      if (body?.isManual !== undefined) {
        isManual = Boolean(body.isManual);
      }
    } catch {
      // Body may be empty
    }

    const result = await autonomousScheduler.runCycle(isManual);
    return NextResponse.json({ success: true, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error in cycle runner";
    console.error("Cycle execution failed:", err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const result = await autonomousScheduler.runCycle(false);
    return NextResponse.json({ success: true, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error in cycle runner";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
