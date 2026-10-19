import { describe, expect, it } from "vitest";
import { outcomeEvaluator, type ForecastRecord } from "@/lib/quant/outcome-evaluator";
import { BAR_MS, OUTCOME_BAR_PCT, RANGE_BAR_PCT, roundTripCostPct } from "@/lib/quant/outcome-contract";
import { candle, series } from "./helpers";

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

function forecast(overrides: Partial<ForecastRecord> = {}): ForecastRecord {
  const fixedAt = new Date(NOW - HOUR);
  return {
    id: 1,
    hypothesisId: 7,
    asset: "BTC-USDT",
    direction: "UP",
    horizonMinutes: 15,
    fixedAt,
    resolveAt: new Date(fixedAt.getTime() + BAR_MS),
    entryPrice: 100,
    expectedMinPrice: 100.35,
    expectedMaxPrice: 101.5,
    targetCondition: "close >= entry + 0.35%",
    invalidationCondition: "close <= entry - 0.7%",
    costsBps: 8,
    slippageBps: 3,
    fundingDragBps: 1,
    status: "pending",
    ...overrides,
  };
}

describe("оценщик исходов: метка против реального движения", () => {
  it("UP: ход больше издержек и бара — hit", () => {
    const r = outcomeEvaluator.evaluate(forecast(), 101, []);
    expect(r.outcome).toBe("hit");
    expect(r.errorType).toBe("none");
    expect(r.resolvedPrice).toBe(101);
    expect(r.realizedReturnNet).toBeCloseTo(1 - roundTripCostPct(), 10);
    expect(r.mfe).toBeGreaterThanOrEqual(OUTCOME_BAR_PCT);
  });

  it("UP: ход есть, но его съели издержки — miss с типом cost_drag", () => {
    const r = outcomeEvaluator.evaluate(forecast(), 100.2, []);
    expect(r.outcome).toBe("miss");
    expect(r.errorType).toBe("cost_drag");
    expect(r.realizedReturnNet).toBeLessThan(0);
  });

  it("UP: цена ушла против сигнала — miss с типом wrong_sign", () => {
    const r = outcomeEvaluator.evaluate(forecast(), 99, []);
    expect(r.outcome).toBe("miss");
    expect(r.errorType).toBe("wrong_sign");
  });

  it("UP: движение в пределах шума — miss с типом weak_signal", () => {
    const r = outcomeEvaluator.evaluate(forecast(), 99.95, []);
    expect(r.outcome).toBe("miss");
    expect(r.errorType).toBe("weak_signal");
  });

  it("UP: бар цели достигнут, но к горизонту цена развернулась — wrong_horizon", () => {
    const fixedAt = NOW - HOUR;
    const bars = [
      candle(fixedAt, 100, { high: 101, low: 99.8, open: 100, close: 100.6 }),
    ];
    const r = outcomeEvaluator.evaluate(forecast({ fixedAt: new Date(fixedAt) }), 99.5, bars);
    expect(r.mfe).toBeGreaterThanOrEqual(OUTCOME_BAR_PCT);
    expect(r.outcome).toBe("miss");
    expect(r.errorType).toBe("wrong_horizon");
    expect(r.barsUsed).toBe(1);
  });

  it("DOWN зеркален UP: падение больше издержек и бара — hit", () => {
    const r = outcomeEvaluator.evaluate(forecast({ direction: "DOWN" }), 99, []);
    expect(r.outcome).toBe("hit");
    expect(r.errorType).toBe("none");
    expect(r.realizedReturnNet).toBeCloseTo(1 - roundTripCostPct(), 10);
  });

  it("RANGE: цена осталась в полосе — hit, вышла — miss", () => {
    const inside = outcomeEvaluator.evaluate(forecast({ direction: "RANGE" }), 100.2, []);
    expect(inside.outcome).toBe("hit");

    const outside = outcomeEvaluator.evaluate(forecast({ direction: "RANGE" }), 100 + RANGE_BAR_PCT * 3, []);
    expect(outside.outcome).toBe("miss");
  });

  it("бары ПОСЛЕ горизонта не попадают в MFE (нет look-ahead)", () => {
    const fixedAt = NOW - HOUR;
    const resolveAt = fixedAt + BAR_MS;
    const bars = [
      // Вне окна: открылся до фиксации прогноза.
      candle(fixedAt - BAR_MS, 100, { high: 112, low: 99, open: 100, close: 100 }),
      // В окне: скромное движение.
      candle(fixedAt, 100.2, { high: 100.2, low: 99.9, open: 100, close: 100.2 }),
      // После горизонта: огромный пик, который обязан быть проигнорирован.
      candle(resolveAt, 110, { high: 115, low: 100, open: 100, close: 110 }),
    ];
    const r = outcomeEvaluator.evaluate(forecast({ fixedAt: new Date(fixedAt), resolveAt: new Date(resolveAt) }), 100, bars);
    expect(r.barsUsed).toBe(1);
    expect(r.mfe).toBeLessThan(1);
    expect(r.mfe).toBeCloseTo(0.2, 6);
  });

  it("незакрытый бар не участвует в экстремумах и помечается в caveat", () => {
    const fixedAt = NOW - HOUR;
    const resolveAt = NOW + 10 * 60 * 1000;
    const bars = [
      candle(fixedAt, 100.2, { high: 100.4, low: 99.9, open: 100, close: 100.2 }),
      // Открыт 5 минут назад: ещё не закрыт на момент разрешения.
      candle(NOW - 5 * 60 * 1000, 100.5, { high: 108, low: 100, open: 100.2, close: 100.5 }),
    ];
    const r = outcomeEvaluator.evaluate(
      forecast({ fixedAt: new Date(fixedAt), resolveAt: new Date(resolveAt) }),
      100.2,
      bars
    );
    expect(r.barsUsed).toBe(1);
    expect(r.caveat).toBe("unconfirmed_last_bar");
    // Пик незакрытого бара не должен был попасть в MFE.
    expect(r.mfe).toBeLessThan(1);
  });

  it("нет баров в окне — caveat no_bars_in_window, а не молчаливый промах", () => {
    const r = outcomeEvaluator.evaluate(forecast(), 100, series([100, 100, 100], { endTs: NOW - 10 * HOUR }));
    expect(r.barsUsed).toBe(0);
    expect(r.caveat).toBe("no_bars_in_window");
  });

  it("MFE и MAE неотрицательны, resolvedPrice — это цена разрешения", () => {
    const r = outcomeEvaluator.evaluate(forecast({ direction: "DOWN" }), 103, []);
    expect(r.mfe).toBeGreaterThanOrEqual(0);
    expect(r.mae).toBeGreaterThanOrEqual(0);
    expect(r.resolvedPrice).toBe(103);
  });
});
