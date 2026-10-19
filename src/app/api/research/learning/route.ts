import { NextResponse } from "next/server";
import { db } from "@/db";
import { learningWeights, experimentRuns, forecasts, hypotheses } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { learningLoop } from "@/lib/quant/learning-loop";
import { CATEGORY_DEFINITIONS } from "@/lib/types";

export async function GET() {
  try {
    await learningLoop.ensureInitialized();
    const weightsList = await db.select().from(learningWeights);
    const experimentHistory = await db
      .select()
      .from(experimentRuns)
      .orderBy(desc(experimentRuns.createdAt))
      .limit(15);

    const resolvedForecasts = await db
      .select()
      .from(forecasts)
      .where(eq(forecasts.status, "resolved"));
    const hypothesisRows = await db
      .select({ id: hypotheses.id, uncertainty: hypotheses.uncertainty })
      .from(hypotheses);
    const hypothesisMap = new Map(hypothesisRows.map((h) => [h.id, h]));

    // Calculate error taxonomy counts
    const errorDistribution: Record<string, number> = {
      none: 0,
      weak_signal: 0,
      wrong_sign: 0,
      wrong_horizon: 0,
      regime_mismatch: 0,
      cost_drag: 0,
      // Разрыв данных: прогноз не удалось разрешить по реальной цене (нет
      // тикера/свечей или разрешение пришло сильно позже горизонта).
      data_gap: 0,
    };

    for (const fc of resolvedForecasts) {
      const err = fc.errorType || "none";
      errorDistribution[err] = (errorDistribution[err] || 0) + 1;
    }

    // Reliability & calibration bins from the stored forecast uncertainty.
    const calibrationDefinitions = [
      { label: "0.40 - 0.50", min: 0.40, max: 0.50 },
      { label: "0.50 - 0.60", min: 0.50, max: 0.60 },
      { label: "0.60 - 0.70", min: 0.60, max: 0.70 },
      { label: "0.70 - 0.85", min: 0.70, max: 0.85 },
    ];
    const calibrationSamples = resolvedForecasts
      .filter((fc) => fc.outcome === "hit" || fc.outcome === "miss")
      .map((fc) => {
        const uncertainty = fc.hypothesisId === null
          ? 0.5
          : hypothesisMap.get(fc.hypothesisId)?.uncertainty ?? 0.5;
        return {
          predictedProb: Math.min(0.85, Math.max(0.40, 1 - uncertainty)),
          hit: fc.outcome === "hit",
        };
      });
    const calibrationBins = calibrationDefinitions.flatMap(({ label, min, max }) => {
      const samples = calibrationSamples.filter((sample) =>
        sample.predictedProb >= min && (sample.predictedProb < max || (max === 0.85 && sample.predictedProb <= max))
      );
      if (samples.length === 0) return [];
      return [{
        bin: label,
        predictedProb: samples.reduce((sum, sample) => sum + sample.predictedProb, 0) / samples.length,
        actualHitRate: samples.filter((sample) => sample.hit).length / samples.length,
        count: samples.length,
      }];
    });

    const enrichedWeights = weightsList.map((w) => ({
      ...w,
      labelRu: CATEGORY_DEFINITIONS[w.categoryName as keyof typeof CATEGORY_DEFINITIONS]?.labelRu || w.categoryName,
      labelEn: CATEGORY_DEFINITIONS[w.categoryName as keyof typeof CATEGORY_DEFINITIONS]?.labelEn || w.categoryName,
    }));

    return NextResponse.json({
      success: true,
      weights: enrichedWeights,
      experimentHistory,
      errorDistribution,
      calibrationBins,
      totalAccumulatedSamples: weightsList.reduce((acc, w) => acc + w.totalSamples, 0),
      // null, если ни одна категория ещё не видела исходов. Прежнее "0.2500"
      // показывало «калибровка как у монетки» на полностью пустой базе.
      averageBrierScore:
        weightsList.some((w) => w.totalSamples > 0)
          ? (
              weightsList.reduce((acc, w) => acc + w.brierScore, 0) /
              Math.max(1, weightsList.filter((w) => w.totalSamples > 0).length)
            ).toFixed(4)
          : null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to load learning data";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST() {
  try {
    // Пересчёт весов по ВСЕЙ накопленной истории одним идемпотентным вызовом.
    // Раньше здесь собирался массив всех разрешённых прогнозов и передавался в
    // инкрементальный обновлятор: каждый POST заново «засчитывал» одни и те же
    // исходы, раздувая totalSamples и убивая байесовское сглаживание.
    // Кроме того, пустой `outcome` приводился к "hit" (`|| "hit"`), то есть
    // brak-данные становились подтверждением гипотез.
    const result = await learningLoop.rebuildFromHistory();
    // Ручной пересчёт оставляет след в журнале прогонов: иначе действие
    // пользователя меняло веса системы бесследно.
    await learningLoop.logRebuild(result, "manual_learning_rebuild");
    const updatedWeights = await db.select().from(learningWeights);

    return NextResponse.json({
      success: true,
      message:
        result.events === 0
          ? "Обучать пока не на чем: в журнале нет разрешённых исходов (hit/miss)."
          : `Веса пересчитаны по ${result.events} исходам; затронуто категорий: ${result.categories}.`,
      retrainedCount: result.events,
      averageBrierScore: result.averageBrier,
      baseHitRate: result.baseHitRate,
      categoriesUpdated: result.categories,
      rebuiltAt: result.updatedAt,
      updatedWeights,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Learning update failed";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
