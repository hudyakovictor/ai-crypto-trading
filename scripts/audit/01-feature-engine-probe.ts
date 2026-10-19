// Harness 1: проверка FeatureEngine на реалистичных данных BTC 15m.
import { featureEngine } from "@/lib/quant/feature-engine";
import { combinationEngine } from "@/lib/quant/combination-engine";
import type { OKXCandle } from "@/lib/types";

function genSeries(n: number, startPrice: number, annVol: number, driftPerBar = 0, seed = 1): OKXCandle[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const gauss = () => {
    const u = Math.max(1e-9, rnd()), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const step = 15 * 60 * 1000;
  const now = Math.floor(Date.now() / step) * step;
  const perBar = annVol / Math.sqrt(365 * 96);
  const out: OKXCandle[] = [];
  let price = startPrice;
  for (let i = n - 1; i >= 0; i--) {
    const open = price;
    const r = driftPerBar + perBar * gauss();
    const close = open * Math.exp(r);
    const hi = Math.max(open, close) * (1 + Math.abs(perBar * gauss()) * 0.6);
    const lo = Math.min(open, close) * (1 - Math.abs(perBar * gauss()) * 0.6);
    const vol = 500 * (0.6 + rnd());
    out.push({ timestamp: now - i * step, open, high: hi, low: lo, close, volume: vol, volCcy: vol * close });
    price = close;
  }
  return out;
}

// 1) Распределение режимов на реалистичной волатильности (40%..90% годовых)
const regimes: Record<string, number> = {};
for (let k = 0; k < 400; k++) {
  const annVol = 0.35 + (k % 12) * 0.05; // 35%..90%
  const drift = ((k % 7) - 3) * 0.0006;
  const c = genSeries(60, 65000, annVol, drift, k + 7);
  const r = featureEngine.detectRegime(c);
  regimes[r] = (regimes[r] ?? 0) + 1;
}
console.log("=== detectRegime на 400 реалистичных сериях (annVol 35-90%) ===");
console.log(regimes);

// тихий рынок (10% годовых) — должен бы быть RANGING/LOW_VOLATILITY_SQUEEZE
const quiet: Record<string, number> = {};
for (let k = 0; k < 200; k++) {
  const c = genSeries(60, 65000, 0.08 + (k % 5) * 0.01, 0, k + 99);
  const r = featureEngine.detectRegime(c);
  quiet[r] = (quiet[r] ?? 0) + 1;
}
console.log("=== detectRegime на тихом рынке (annVol 8-12%) ===");
console.log(quiet);

// 2) Противоречие sign/direction в derivatives_positioning
console.log("\n=== derivatives_positioning: score vs direction ===");
for (const fr of [0.0001, 0.0005, 0.001, -0.0005, -0.001]) {
  const candles = genSeries(60, 65000, 0.5, 0, 5);
  const out = featureEngine.calculate15Categories({
    symbol: "ETH-USDT",
    candles,
    funding: { instId: "ETH-USDT-SWAP", fundingRate: fr, fundingTime: Date.now() },
  });
  const d = out.signals.derivatives_positioning;
  console.log(
    `funding=${fr} -> normalizedScore=${d.normalizedScore.toFixed(3)} direction=${d.direction} confidence=${d.confidence}`
  );
}

// 3) Корреляция/дублирование категорий: одна и та же серия, разные сиды
console.log("\n=== Дублирование категорий (корреляция normalizedScore между категориями) ===");
const acc: Record<string, number[]> = {};
for (let k = 0; k < 300; k++) {
  const candles = genSeries(60, 65000, 0.4 + (k % 10) * 0.03, ((k % 5) - 2) * 0.0005, k + 11);
  const out = featureEngine.calculate15Categories({ symbol: "SOL-USDT", candles });
  for (const [key, sig] of Object.entries(out.signals)) {
    (acc[key] ||= []).push(sig.normalizedScore);
  }
}
const keys = Object.keys(acc);
const corr = (a: number[], b: number[]) => {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db || 1);
};
const pairs: [string, string, number][] = [];
for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
  pairs.push([keys[i], keys[j], corr(acc[keys[i]], acc[keys[j]])]);
}
pairs.sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]));
console.log("Топ-10 пар по |корреляции| (псевдо-независимые «категории»):");
for (const [a, b, c] of pairs.slice(0, 10)) console.log(`  ${a} ~ ${b}: r=${c.toFixed(3)}`);

// 4) EVS: распределение и вклад компонент
console.log("\n=== EVS-распределение (100 связок на одном состоянии) ===");
const candles = genSeries(60, 65000, 0.55, 0.0004, 3);
const fe = featureEngine.calculate15Categories({
  symbol: "BTC-USDT",
  candles,
  book: { instId: "BTC-USDT", bids: [[65000, 10], [64990, 20]], asks: [[65010, 12], [65020, 18]], ts: Date.now() },
  funding: { instId: "BTC-USDT-SWAP", fundingRate: 0.0001, fundingTime: Date.now() },
  oi: { instId: "BTC-USDT-SWAP", oi: 100000, oiCcy: 6.5e9, ts: Date.now() },
  btcCandles: candles,
  allTickersPerformance: Array.from({ length: 150 }, (_, i) => ({ symbol: `S${i}`, change24h: (i % 7) - 3, volume: 1e6 })),
});
const combos = combinationEngine.generate100Combinations("BTC-USDT", fe.signals, fe.regime, {}, fe.dataQualityScore);
const evs = combos.map((c) => c.earlyValueScore).sort((a, b) => a - b);
console.log(`n=${combos.length} min=${evs[0]} p25=${evs[24]} median=${evs[49]} p75=${evs[74]} max=${evs[99]}`);
const dirs: Record<string, number> = {};
for (const c of combos) dirs[c.targetDirection] = (dirs[c.targetDirection] ?? 0) + 1;
console.log("направления:", dirs);
const compAvg: Record<string, number> = {};
for (const c of combos) for (const [k, v] of Object.entries(c.breakdown)) compAvg[k] = (compAvg[k] ?? 0) + (v as number) / combos.length;
console.log("средний вклад компонент EVS:", Object.fromEntries(Object.entries(compAvg).map(([k, v]) => [k, Number(v.toFixed(2))])));

// покрытие пространства категорий
const usedPairs = new Set<string>();
for (const c of combos) {
  const cs = [...c.categories].sort();
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) usedPairs.add(`${cs[i]}+${cs[j]}`);
}
console.log(`\nПокрытие пар категорий: ${usedPairs.size} из 105 возможных`);
const catUse: Record<string, number> = {};
for (const c of combos) for (const k of c.categories) catUse[k] = (catUse[k] ?? 0) + 1;
console.log("использование категорий в 100 связках:", catUse);

// 5) determinism: одинаковый вход -> одинаковый EVS?
const combos2 = combinationEngine.generate100Combinations("BTC-USDT", fe.signals, fe.regime, {}, fe.dataQualityScore);
console.log("\nДетерминизм кодов/EVS при повторном вызове:",
  combos.every((c, i) => c.code === combos2[i].code && c.earlyValueScore === combos2[i].earlyValueScore));
