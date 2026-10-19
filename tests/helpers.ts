import type { OKXCandle } from "@/lib/types";

/** Длина бара контура, мс. Совпадает с BAR_MS из outcome-contract. */
export const BAR_MS = 15 * 60 * 1000;

export interface CandleSpec {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Свеча по умолчанию: тело ±0.05% вокруг close, объём 1000. */
export function candle(timestamp: number, close: number, spec?: Partial<CandleSpec>): OKXCandle {
  const open = spec?.open ?? close;
  return {
    timestamp,
    open,
    high: spec?.high ?? Math.max(open, close) * 1.0005,
    low: spec?.low ?? Math.min(open, close) * 0.9995,
    close: spec?.close ?? close,
    volume: spec?.volume ?? 1000,
    volCcy: (spec?.volume ?? 1000) * close,
  };
}

/**
 * Ряд свечей, заканчивающийся в `endTs` (по умолчанию — час назад, чтобы бары
 * были гарантированно закрыты относительно Date.now()).
 */
export function series(
  prices: number[],
  opts: { endTs?: number; stepMs?: number; wick?: number } = {}
): OKXCandle[] {
  const step = opts.stepMs ?? BAR_MS;
  const end = opts.endTs ?? Date.now() - 60 * 60 * 1000;
  const start = end - step * (prices.length - 1);
  return prices.map((p, i) => {
    const prev = i > 0 ? prices[i - 1] : p;
    const wick = opts.wick ?? 0.0005;
    return candle(start + i * step, p, {
      open: prev,
      high: Math.max(prev, p) * (1 + wick),
      low: Math.min(prev, p) * (1 - wick),
    });
  });
}

/** Монотонный тренд: n баров с шагом stepPct (доля, например 0.003 = +0.3%). */
export function trend(from: number, n: number, stepPct: number): number[] {
  const out: number[] = [];
  let p = from;
  for (let i = 0; i < n; i++) {
    out.push(p);
    p *= 1 + stepPct;
  }
  return out;
}

/** Плоский ряд с микро-шумом: волатильность заведомо ниже порога RANGING. */
export function flat(base: number, n: number, noise = 0.0002): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(base * (1 + (i % 2 === 0 ? noise : -noise)));
  }
  return out;
}

/** Пила с крупным шагом: волатильность заведомо выше порога VOLATILE. */
export function choppy(base: number, n: number, swing = 0.03): number[] {
  const out: number[] = [];
  let up = true;
  let p = base;
  for (let i = 0; i < n; i++) {
    out.push(p);
    p *= 1 + (up ? swing : -swing);
    up = !up;
  }
  return out;
}
