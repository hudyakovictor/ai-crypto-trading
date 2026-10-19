import { describe, expect, it } from "vitest";
import { featureEngine } from "@/lib/quant/feature-engine";
import { CATEGORY_KEYS } from "@/lib/types";
import type { OKXFundingRate, OKXOrderBook, NormalizedSignal } from "@/lib/types";
import { series, trend } from "./helpers";

const candles = series(trend(100, 60, 0.001));

function funding(rate: number): OKXFundingRate {
  return { instId: "BTC-USDT-SWAP", fundingRate: rate, fundingTime: Date.now() + 4 * 3600 * 1000 };
}

function signals(input: {
  funding?: OKXFundingRate;
  book?: OKXOrderBook;
}): Record<string, NormalizedSignal> {
  return featureEngine.calculate15Categories({ symbol: "BTC-USDT", candles, ...input }).signals;
}

describe("derivatives_positioning: знак скора и направление согласованы", () => {
  it("переполненный лонг (фандинг выше базы) — отрицательный скор и DOWN", () => {
    const s = signals({ funding: funding(0.0005) }).derivatives_positioning;
    expect(s.normalizedScore).toBeLessThan(0);
    expect(s.direction).toBe("DOWN");
  });

  it("переполненный шорт (фандинг ниже базы) — положительный скор и UP", () => {
    const s = signals({ funding: funding(-0.0003) }).derivatives_positioning;
    expect(s.normalizedScore).toBeGreaterThan(0);
    expect(s.direction).toBe("UP");
  });

  it("фандинг ровно на базовой ставке — ноль и NEUTRAL", () => {
    const s = signals({ funding: funding(0.0001) }).derivatives_positioning;
    // toBeCloseTo, а не toBe(0): -0 === 0 по значению, но Object.is их различает.
    expect(s.normalizedScore).toBeCloseTo(0, 12);
    expect(s.direction).toBe("NEUTRAL");
  });

  it("законный нулевой фандинг не подменяется базовой ставкой", () => {
    const zero = signals({ funding: funding(0) }).derivatives_positioning;
    const neutral = signals({ funding: funding(0.0001) }).derivatives_positioning;
    // 0 — это BELOW базы (лонги не платят), значит контртрендовый скор положительный.
    expect(zero.rawValue).toBe(0);
    expect(zero.normalizedScore).toBeGreaterThan(0);
    expect(zero.normalizedScore).not.toBeCloseTo(neutral.normalizedScore, 6);
  });

  it("для любой ставки скор и направление не противоречат друг другу", () => {
    for (const rate of [-0.002, -0.0005, -0.0001, 0, 0.0001, 0.0003, 0.001, 0.005]) {
      const s = signals({ funding: funding(rate) }).derivatives_positioning;
      const expected =
        s.normalizedScore > 0.2 ? "UP" : s.normalizedScore < -0.2 ? "DOWN" : "NEUTRAL";
      expect(s.direction).toBe(expected);
    }
  });

  it("годовая ставка в rawValue считается честно (3 раза в сутки × 365)", () => {
    const s = signals({ funding: funding(0.0001) }).derivatives_positioning;
    expect(s.rawValue).toBeCloseTo(0.0001 * 3 * 365 * 100, 9);
  });
});

describe("отсутствие данных не выдаётся за измерение", () => {
  it("нет фандинга — нулевая уверенность, полная пропущенность, NEUTRAL", () => {
    const s = signals({}).derivatives_positioning;
    expect(s.normalizedScore).toBeCloseTo(0, 12);
    expect(s.direction).toBe("NEUTRAL");
    expect(s.confidence).toBe(0);
    expect(s.missingness).toBe(1);
  });

  it("нет фандинга — базис спот/своп тоже не выдуман", () => {
    const s = signals({}).cross_exchange_dispersion;
    expect(s.normalizedScore).toBeCloseTo(0, 12);
    expect(s.confidence).toBe(0);
    expect(s.missingness).toBe(1);
    expect(s.rawValue).toBe(0);
  });

  it("нет стакана — нулевая уверенность, пропущенность 1, спред null", () => {
    const s = signals({}).order_book_microstructure;
    expect(s.confidence).toBe(0);
    expect(s.missingness).toBe(1);
    expect(s.direction).toBe("NEUTRAL");
    expect(s.metadata?.spreadBps).toBeNull();
  });

  it("есть стакан — уверенность высокая, пропущенности нет", () => {
    const book: OKXOrderBook = {
      instId: "BTC-USDT",
      bids: [
        [100, 10],
        [99.9, 20],
      ],
      asks: [[100.1, 5]],
      ts: Date.now(),
    };
    const s = signals({ book }).order_book_microstructure;
    expect(s.confidence).toBeGreaterThan(0.9);
    expect(s.missingness).toBe(0);
    expect(typeof s.metadata?.spreadBps).toBe("number");
    // Перевес бидов — положительный скор и UP.
    expect(s.normalizedScore).toBeGreaterThan(0);
    expect(s.direction).toBe("UP");
  });

  it("пустой стакан прилетает как отсутствие данных", () => {
    const book: OKXOrderBook = { instId: "BTC-USDT", bids: [], asks: [], ts: Date.now() };
    const s = signals({ book }).order_book_microstructure;
    expect(s.confidence).toBe(0);
    expect(s.missingness).toBe(1);
  });

  it("аномалия считается только по измеренным ядрам", () => {
    const withData = signals({ funding: funding(0.0006) }).anomaly_novelty;
    const without = signals({}).anomaly_novelty;
    // Меньше измеренных ядер — ниже уверенность и выше пропущенность.
    expect(without.confidence).toBeLessThan(withData.confidence);
    expect(without.missingness).toBeGreaterThan(withData.missingness);
  });
});

describe("выход движка признаков всегда полон", () => {
  it("все 15 категорий заполнены и имеют валидные границы", () => {
    const out = featureEngine.calculate15Categories({ symbol: "BTC-USDT", candles });
    expect(Object.keys(out.signals).sort()).toEqual([...CATEGORY_KEYS].sort());
    for (const key of CATEGORY_KEYS) {
      const s = out.signals[key];
      expect(s.category).toBe(key);
      expect(Number.isFinite(s.normalizedScore)).toBe(true);
      expect(s.normalizedScore).toBeGreaterThanOrEqual(-1);
      expect(s.normalizedScore).toBeLessThanOrEqual(1);
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
      expect(s.missingness).toBeGreaterThanOrEqual(0);
      expect(s.missingness).toBeLessThanOrEqual(1);
    }
    // Единая шкала качества данных: 0..10 (см. calculateDataQualityScore).
    expect(out.dataQualityScore).toBeGreaterThanOrEqual(0);
    expect(out.dataQualityScore).toBeLessThanOrEqual(10);
  });

  it("короткий ряд — честный «нет данных», а не нули с уверенностью", () => {
    const out = featureEngine.calculate15Categories({ symbol: "BTC-USDT", candles: series(trend(100, 3, 0.001)) });
    expect(out.dataQualityScore).toBeLessThanOrEqual(10);
    for (const key of CATEGORY_KEYS) {
      expect(out.signals[key].primitiveName).toBe("uninitialized");
      expect(out.signals[key].direction).toBe("NEUTRAL");
      expect(out.signals[key].missingness).toBeGreaterThan(0.5);
    }
  });
});
