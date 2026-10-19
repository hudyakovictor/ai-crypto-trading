import { describe, expect, it } from "vitest";
import { featureEngine } from "@/lib/quant/feature-engine";
import { toMacroRegime } from "@/lib/types";
import { BAR_MS, candle, choppy, flat, series, trend } from "./helpers";

/** Полностью плоский ряд: одна и та же цена, один и тот же объём на каждом баре. */
function frozenSeries(price: number, n: number, volume: number) {
  const end = Date.now() - 60 * 60 * 1000;
  return Array.from({ length: n }, (_, i) =>
    candle(end - (n - 1 - i) * BAR_MS, price, {
      open: price,
      high: price,
      low: price,
      close: price,
      volume,
    })
  );
}

/**
 * Детектор режима. Здесь закреплены два исправления:
 *  — реализованная волатильность считается по ПОСЛЕДНИМ барам ряда, а не по
 *    первым (раньше режим определялся самыми старыми свечами из 100);
 *  — пороги годовой волатильности реалистичны для крипты (раньше почти любой
 *    рынок попадал в VOLATILE, а RANGING не возвращался никогда).
 */
describe("detectRegime", () => {
  it("короткий ряд не даёт режима: NEUTRAL_CONSOLIDATION", () => {
    expect(featureEngine.detectRegime(series(trend(100, 10, 0.01)))).toBe("NEUTRAL_CONSOLIDATION");
  });

  it("устойчивый рост — TRENDING_BULL", () => {
    const regime = featureEngine.detectRegime(series(trend(100, 60, 0.004)));
    expect(regime).toBe("TRENDING_BULL");
    expect(toMacroRegime(regime)).toBe("BULLISH");
  });

  it("устойчивое падение — TRENDING_BEAR, а не BULLISH", () => {
    const regime = featureEngine.detectRegime(series(trend(100, 60, -0.004)));
    expect(regime).toBe("TRENDING_BEAR");
    // Регрессия на главную ошибку сопоставления: медвежий тренд больше не
    // отображается в «бычий» макро-режим.
    expect(toMacroRegime(regime)).toBe("BEARISH");
  });

  it("плоский тихий рынок не называется VOLATILE", () => {
    const regime = featureEngine.detectRegime(series(flat(100, 60), { wick: 0.0001 }));
    expect(regime).not.toBe("VOLATILE");
    expect(["RANGING", "LOW_VOLATILITY_SQUEEZE", "NEUTRAL_CONSOLIDATION"]).toContain(regime);
  });

  it("широкая пила — VOLATILE", () => {
    const regime = featureEngine.detectRegime(series(choppy(100, 60, 0.03)));
    expect(regime).toBe("VOLATILE");
    expect(toMacroRegime(regime)).toBe("UNSTABLE");
  });

  it("режим определяется по ХВОСТУ ряда: старая волатильность не влияет", () => {
    // Первая половина — бешеная пила, вторая — спокойный тренд.
    const quiet = trend(100, 40, 0.003);
    const wild = choppy(quiet[0], 40, 0.05);
    const mixed = featureEngine.detectRegime(series([...wild, ...quiet]));
    expect(mixed).not.toBe("VOLATILE");

    // Зеркальный случай: сначала тихо, затем пила — режим обязан стать волатильным.
    const quiet2 = flat(100, 40, 0.0002);
    const wild2 = choppy(100, 40, 0.05);
    const mixed2 = featureEngine.detectRegime(series([...quiet2, ...wild2], { wick: 0.0001 }));
    expect(mixed2).toBe("VOLATILE");
  });

  it("тихий узкий диапазон — LOW_VOLATILITY_SQUEEZE (режим больше не мёртвый)", () => {
    expect(featureEngine.detectRegime(series(flat(100, 60), { wick: 0.0001 }))).toBe("LOW_VOLATILITY_SQUEEZE");
  });

  it("замёрзшие котировки без объёма — LIQUIDITY_CRUNCH, а не «сильный тренд»", () => {
    // Идеально плоский ряд: TR = 0, поэтому ADX вырождается (отношение
    // направленного движения к диапазону теряет смысл). Раньше такой ряд
    // давал TRENDING_BEAR — «сильный медвежий тренд» на полностью мёртвом рынке.
    const frozen = frozenSeries(100, 60, 0);
    expect(featureEngine.detectRegime(frozen)).toBe("LIQUIDITY_CRUNCH");
  });

  it("замёрзшие котировки с объёмом — NEUTRAL_CONSOLIDATION", () => {
    const frozen = frozenSeries(100, 60, 25);
    expect(featureEngine.detectRegime(frozen)).toBe("NEUTRAL_CONSOLIDATION");
  });

  it("результат всегда входит в объявленное множество режимов", () => {
    const known = [
      "TRENDING_BULL",
      "TRENDING_BEAR",
      "RANGING",
      "VOLATILE",
      "HIGH_VOLATILITY_CHOP",
      "LOW_VOLATILITY_SQUEEZE",
      "LIQUIDITY_CRUNCH",
      "NEUTRAL_CONSOLIDATION",
    ];
    for (const prices of [trend(100, 60, 0.004), trend(100, 60, -0.004), flat(100, 60), choppy(100, 60, 0.03)]) {
      expect(known).toContain(featureEngine.detectRegime(series(prices)));
    }
  });
});

describe("toMacroRegime: все режимы рынка отображаются без потери знака", () => {
  it("бычий → BULLISH, медвежий → BEARISH", () => {
    expect(toMacroRegime("TRENDING_BULL")).toBe("BULLISH");
    expect(toMacroRegime("TRENDING_BEAR")).toBe("BEARISH");
  });

  it("волатильные режимы → UNSTABLE, боковик и консолидация → NEUTRAL", () => {
    expect(toMacroRegime("VOLATILE")).toBe("UNSTABLE");
    expect(toMacroRegime("HIGH_VOLATILITY_CHOP")).toBe("UNSTABLE");
    expect(toMacroRegime("RANGING")).toBe("NEUTRAL");
    expect(toMacroRegime("NEUTRAL_CONSOLIDATION")).toBe("NEUTRAL");
    expect(toMacroRegime("LOW_VOLATILITY_SQUEEZE")).toBe("NEUTRAL");
    expect(toMacroRegime("LIQUIDITY_CRUNCH")).toBe("NEUTRAL");
  });
});
