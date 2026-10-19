import { describe, expect, it } from "vitest";
import {
  BAR_MS,
  DEFAULT_COSTS_BPS,
  DEFAULT_FUNDING_DRAG_BPS,
  DEFAULT_SLIPPAGE_BPS,
  ERROR_THRESHOLDS,
  MAX_RESOLUTION_DELAY_MS,
  OUTCOME_BAR_BPS,
  OUTCOME_BAR_PCT,
  RANGE_BAR_PCT,
  roundTripCostBps,
  roundTripCostPct,
} from "@/lib/quant/outcome-contract";

describe("контракт исхода", () => {
  it("бар исхода согласован в bps и процентах", () => {
    expect(OUTCOME_BAR_BPS).toBe(35);
    expect(OUTCOME_BAR_PCT).toBeCloseTo(0.35, 12);
    expect(OUTCOME_BAR_PCT * 100).toBeCloseTo(OUTCOME_BAR_BPS, 9);
  });

  it("round-trip удваивает издержки: вход и выход", () => {
    expect(roundTripCostBps()).toBe((DEFAULT_COSTS_BPS + DEFAULT_SLIPPAGE_BPS + DEFAULT_FUNDING_DRAG_BPS) * 2);
    expect(roundTripCostBps()).toBe(24);
    expect(roundTripCostPct()).toBeCloseTo(0.24, 12);
  });

  it("издержки актива переопределяют значения по умолчанию", () => {
    expect(roundTripCostBps(2, 1, 0)).toBe(6);
    expect(roundTripCostPct(2, 1, 0)).toBeCloseTo(0.06, 12);
    // Нулевые издержки допустимы и не заменяются дефолтом.
    expect(roundTripCostBps(0, 0, 0)).toBe(0);
  });

  it("пороги таксономии ошибок выражены в долях бара", () => {
    for (const value of Object.values(ERROR_THRESHOLDS)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    // wrong_sign должен требовать большего хода против сигнала, чем wrong_horizon.
    expect(ERROR_THRESHOLDS.wrongSignPctOfBar).toBeGreaterThan(ERROR_THRESHOLDS.wrongHorizonReversalPctOfBar);
    // weak_signal — это ход меньше доли бара.
    expect(ERROR_THRESHOLDS.weakSignalPctOfBar).toBeLessThan(1);
  });

  it("бар RANGE шире бара исхода: флэт не обязан двигаться", () => {
    expect(RANGE_BAR_PCT).toBeGreaterThan(OUTCOME_BAR_PCT);
  });

  it("горизонт и допустимая задержка разрешения — 15 минут и 6 минут", () => {
    expect(BAR_MS).toBe(15 * 60 * 1000);
    expect(MAX_RESOLUTION_DELAY_MS).toBe(6 * 60 * 1000);
    // Задержка меньше бара: иначе «проверка через 15 минут» теряет смысл.
    expect(MAX_RESOLUTION_DELAY_MS).toBeLessThan(BAR_MS);
  });
});
