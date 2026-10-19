import { NextResponse } from "next/server";
import { db } from "@/db";
import { learningWeights } from "@/db/schema";
import { sql } from "drizzle-orm";
import { learningLoop } from "@/lib/quant/learning-loop";

export const dynamic = "force-dynamic";

/** Полная очистка исследовательской истории. Фильтры и активы сохраняются. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { confirm?: boolean };
    if (body.confirm !== true) {
      return NextResponse.json(
        { success: false, error: "Требуется подтверждение: { confirm: true }" },
        { status: 400 }
      );
    }

    // Одна транзакция: раньше TRUNCATE и удаление весов шли отдельными
    // запросами, и сбой между ними оставлял журнал пустым при старых весах —
    // то есть систему, которая «помнит» статистику по данным, которых нет.
    //
    // `oi_snapshots` добавлен в список: это такой же журнал наблюдений, и его
    // сохранение после очистки давало историю, не связанную ни с одним циклом.
    //
    // ВНИМАНИЕ: операция уничтожает бумажный журнал — единственный результат
    // работы системы. Поэтому она требует { confirm: true } в теле запроса.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`TRUNCATE TABLE ai_analyses, forecasts, hypotheses, combinations, signal_features, experiment_runs, data_quality_logs, oi_snapshots, candles RESTART IDENTITY CASCADE`
      );
      await tx.delete(learningWeights);
    });
    // Кэш весов в памяти процесса сбрасывается после успешной транзакции.
    learningLoop.invalidateCache();
    await learningLoop.ensureInitialized();

    return NextResponse.json({
      success: true,
      message:
        "История очищена: прогнозы, гипотезы, комбинации, AI-разборы и журналы удалены, веса обучения сброшены к приорам 1.00. Запустите цикл (R) — лаборатория начнёт накапливать статистику заново.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Reset failed";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
