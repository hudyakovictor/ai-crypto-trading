import { NextResponse } from "next/server";
import { loadPolicy, savePolicy, CEILING_MIN, CEILING_MAX } from "@/lib/quant/policy";
import type { PlannerAuthority } from "@/lib/ui-types";

export const dynamic = "force-dynamic";

/** Кому принадлежит решение об отборе гипотез и страховочный потолок на цикл. */
export async function GET() {
  try {
    const policy = await loadPolicy();
    return NextResponse.json({ success: true, policy, limits: { ceilingMin: CEILING_MIN, ceilingMax: CEILING_MAX } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load selection policy";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { authority?: PlannerAuthority; ceiling?: number };
    const policy = await savePolicy(body);
    return NextResponse.json({
      success: true,
      policy,
      message:
        policy.authority === "ai"
          ? `Отбор решает модель (до ${policy.ceiling} гипотез за цикл — потолок как страховка, меньше или ноль тоже корректно)`
          : `Отбор решает детерминированное EVS-правило (до ${policy.ceiling} за цикл)`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save selection policy";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
