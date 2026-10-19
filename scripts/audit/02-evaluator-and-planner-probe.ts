// Harness 2: дисперсия категорий, lookback как no-op, outcome-evaluator look-ahead.
import { featureEngine } from "@/lib/quant/feature-engine";
import { combinationEngine } from "@/lib/quant/combination-engine";
import { outcomeEvaluator } from "@/lib/quant/outcome-evaluator";
import { computeMoveStats, rulePick, buildShortlist, signatureOf, OUTCOME_BAR_BPS } from "@/lib/quant/planner";
import type { OKXCandle } from "@/lib/types";

function gen(n: number, p0: number, annVol: number, drift = 0, seed = 1): OKXCandle[] {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const g = () => { const u = Math.max(1e-9, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const step = 900000; const now = Math.floor(Date.now() / step) * step;
  const perBar = annVol / Math.sqrt(365 * 96);
  const out: OKXCandle[] = []; let price = p0;
  for (let i = n - 1; i >= 0; i--) {
    const open = price; const close = open * Math.exp(drift + perBar * g());
    const high = Math.max(open, close) * (1 + Math.abs(perBar * g()) * 0.6);
    const low = Math.min(open, close) * (1 - Math.abs(perBar * g()) * 0.6);
    const volume = 500 * (0.6 + rnd());
    out.push({ timestamp: now - i * step, open, high, low, close, volume, volCcy: volume * close });
    price = close;
  }
  return out;
}

// --- A. дисперсия каждой категории (есть ли в ней вообще информация) ---
const acc: Record<string, number[]> = {};
for (let k = 0; k < 300; k++) {
  const candles = gen(60, 65000, 0.4 + (k % 10) * 0.03, ((k % 5) - 2) * 0.0005, k + 11);
  const out = featureEngine.calculate15Categories({ symbol: "SOL-USDT", candles, btcCandles: candles });
  for (const [key, sig] of Object.entries(out.signals)) (acc[key] ||= []).push(sig.normalizedScore);
}
console.log("=== Дисперсия normalizedScore по 300 состояниям (без book/funding/oi) ===");
for (const [k, v] of Object.entries(acc)) {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
  console.log(`  ${k.padEnd(30)} mean=${m.toFixed(3)} sd=${sd.toFixed(4)} distinct=${new Set(v.map(x => x.toFixed(3))).size}`);
}

// --- B. lookback — no-op? ---
const candles = gen(60, 65000, 0.6, 0.0006, 42);
const fe = featureEngine.calculate15Categories({
  symbol: "BTC-USDT", candles, btcCandles: candles,
  book: { instId: "BTC-USDT", bids: [[65000, 10], [64990, 20]], asks: [[65010, 12], [65020, 18]], ts: Date.now() },
  funding: { instId: "BTC-USDT-SWAP", fundingRate: 0.0002, fundingTime: Date.now() },
  oi: { instId: "BTC-USDT-SWAP", oi: 1e5, oiCcy: 6.5e9, ts: Date.now() },
  allTickersPerformance: Array.from({ length: 150 }, (_, i) => ({ symbol: `S${i}`, change24h: (i % 7) - 3, volume: 1e6 })),
});
const combos = combinationEngine.generate100Combinations("BTC-USDT", fe.signals, fe.regime, {}, fe.dataQualityScore);
const byBehaviour = new Map<string, Set<number>>();
for (const c of combos) {
  const key = `${[...c.categories].sort().join("+")}|${c.operator}|${c.parameters.threshold}`;
  if (!byBehaviour.has(key)) byBehaviour.set(key, new Set());
  byBehaviour.get(key)!.add(c.earlyValueScore * 1000 + (c.targetDirection === "UP" ? 1 : c.targetDirection === "DOWN" ? 2 : 0));
}
const lookbacks = new Set(combos.map(c => c.parameters.lookback));
console.log(`\n=== Lookback в сетке: ${[...lookbacks].join(", ")}, но уникальных «поведений» (категории+оператор+порог) = ${byBehaviour.size} из ${combos.length} связок ===`);
let dupes = 0;
for (const [, v] of byBehaviour) if (v.size === 1) dupes++;
console.log(`Поведений, где все варианты дают идентичный EVS/направление: ${dupes}`);

const dirCount: Record<string, number> = {};
for (const c of combos) dirCount[c.targetDirection] = (dirCount[c.targetDirection] ?? 0) + 1;
const evsSorted = combos.map(c => c.earlyValueScore).sort((a, b) => b - a);
console.log("направления:", dirCount, "топ-5 EVS:", evsSorted.slice(0, 5), "мин:", evsSorted[evsSorted.length - 1]);
console.log("прошло бы RULE_MIN_EVS=58:", combos.filter(c => c.earlyValueScore >= 58).length);

// --- C. outcome evaluator: свеча ДО прогноза попадает в окно ---
const step = 900000;
const t0 = Math.floor(Date.now() / step) * step;
const mk = (i: number, o: number, h: number, l: number, c: number): OKXCandle =>
  ({ timestamp: t0 + i * step, open: o, high: h, low: l, close: c, volume: 100, volCcy: 100 * c });
// прогноз зафиксирован на t0+2 (fixedAt), resolveAt = +15min. Свеча t0+1 (ДО прогноза) имеет хай 1000.
const withPreSpike = [
  mk(-1, 100, 100.2, 99.8, 100),
  mk(0, 100, 100.1, 99.9, 100),
  mk(1, 100, 1000, 100, 100),     // <-- spike ДО фиксации прогноза
  mk(2, 100, 100.05, 99.95, 100),  // fixedAt здесь
  mk(3, 100, 100.05, 99.95, 100.05),
];
const fc = {
  id: 1, hypothesisId: 1, asset: "X-USDT", direction: "UP", horizonMinutes: 15,
  fixedAt: new Date(t0 + 2 * step), resolveAt: new Date(t0 + 3 * step),
  entryPrice: 100, expectedMinPrice: 99, expectedMaxPrice: 101,
  targetCondition: "", invalidationCondition: "",
  costsBps: 8, slippageBps: 3, fundingDragBps: 1, status: "pending",
};
const r1 = outcomeEvaluator.evaluate(fc as never, 100.05, withPreSpike);
console.log("\n=== Look-ahead: свеча со скачком ДО фиксации прогноза ===");
console.log("  mfe(%) =", r1.mfe.toFixed(3), "outcome =", r1.outcome, "(ожидали miss: цена почти не двигалась)");
const r2 = outcomeEvaluator.evaluate(fc as never, 100.05, withPreSpike.filter(c => c.timestamp >= t0 + 2 * step));
console.log("  без свечей до fixedAt: mfe =", r2.mfe.toFixed(3), "outcome =", r2.outcome);

// --- D. окно без верхней границы: свеча ПОСЛЕ resolveAt тоже учитывается ---
const withPostSpike = [
  mk(2, 100, 100.05, 99.95, 100),
  mk(3, 100, 100.05, 99.95, 100),   // resolveAt здесь
  mk(10, 100, 103, 100, 103),       // через 1.75 часа ПОСЛЕ горизонта
];
const r3 = outcomeEvaluator.evaluate(fc as never, 100, withPostSpike);
console.log("\n=== Свеча спустя 1.75ч ПОСЛЕ resolveAt попала в окно ===");
console.log("  mfe =", r3.mfe.toFixed(3), "outcome =", r3.outcome, "resolvedPrice =", r3.resolvedPrice);

// --- E. RANGE-ветка: mae всегда 0, rawReturn = 0.3 - move ---
const r4 = outcomeEvaluator.evaluate({ ...fc, direction: "RANGE" } as never, 100.1, withPreSpike);
console.log("\n=== RANGE ветка ===", { outcome: r4.outcome, mfe: r4.mfe, mae: r4.mae, net: r4.realizedReturnNet.toFixed(3) });

// --- F. move stats / rulePick / shortlist ---
const mv = computeMoveStats(candles);
console.log("\n=== computeMoveStats (BTC 15m, annVol 60%) ===", mv, "OUTCOME_BAR_BPS =", OUTCOME_BAR_BPS);
const quiet = gen(60, 65000, 0.12, 0, 7);
console.log("=== computeMoveStats (тихий, annVol 12%) ===", computeMoveStats(quiet));

// --- G. signature: одна и та же связка с разным lookback = разные подписи ---
console.log("\n=== Подписи: lookback плодит разные сигнатуры для одного поведения ===");
for (const lb of [7, 14, 21, 50]) {
  console.log(" ", signatureOf("BTC-USDT", ["price_returns", "order_flow"], "UP", { lookback: lb, threshold: 0.4 }));
}
