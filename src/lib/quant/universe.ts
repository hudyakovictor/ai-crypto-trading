import { okxClient } from "../okx/okx-client";
import type { OKXCandle, OKXTicker } from "../types";

/**
 * Динамическая вселенная: система сама решает, какими парами заниматься.
 *
 * Идеи «никаких ограничений» в чистом виде не бывает: 1200 спот-пар OKX требуют
 * 4 запроса каждая за цикл, а 90% из них — неликвид, где сигнал неисполним.
 * Поэтому ограничения не убираются, а перенесены из хардкода в числовой отбор:
 *
 *   уровень 1 — пол исполнимости (объём, спред, реальные котировки);
 *   уровень 2 — merit-скан (где есть возможность: волатильность, RS к BTC, turnover);
 *   уровень 3 — exploration-слоты + anti-crowding, чтобы состав не застаивался.
 *
 * Каждый участник несёт численное обоснование входа — без него динамический
 * отбор превращается в чёрный ящик, чьим гипотезам нельзя верить.
 */

export interface UniverseConfig {
  /** Минимальный 24h объём в котировке (USDT-эквивалент), $ */
  minQuoteVolumeUsd: number;
  /** Максимальный спред bid/ask, bps — выше уже не «исполнимо» */
  maxSpreadBps: number;
  /** Сколько кандидатов оставляем после пола (под свечи-скан) */
  shortlistSize: number;
  /** Мерит-слотов в активной вселенной */
  coreSize: number;
  /** Exploration-слотов: разведка пограничной зоны */
  exploreSize: number;
  /** Глубина окна пограничной зоны для разведки */
  exploreBand: number;
  /** Минимум свечей, чтобы считать волатильность осмысленной */
  minCandles: number;
  /** Сколько циклов подряд актив может держаться в топе до anti-crowding штрафа */
  maxConsecutiveCycles: number;
}

export const UNIVERSE_CONFIG: UniverseConfig = {
  // Пол исполнимости подобран под номинал сделки ($5 000): $3M/24h — это ≤0.2%
  // суточного оборота, вход и выход не двигают книгу. При текущем рынке OKX
  // это ~28 пар из 443 USDT-листингов: «без ограничений» не бывает, но выбирает
  // система сама в пределах исполнимого.
  minQuoteVolumeUsd: 3_000_000,
  maxSpreadBps: 10,
  shortlistSize: 32,
  coreSize: 8,
  exploreSize: 2,
  exploreBand: 10,
  minCandles: 20,
  maxConsecutiveCycles: 3,
};

/** BTC — якорь: относительно него считается relative strength и breadth. */
export const UNIVERSE_ANCHOR = "BTC-USDT";

export type UniverseRole = "core" | "explore";

export interface UniverseMember {
  symbol: string;
  role: UniverseRole;
  score: number;
  /** Числовые слагаемые решения — идут в UI как прозрачность отбора */
  components: {
    liquidity: number;
    volatility: number;
    relativeStrength: number;
    turnover: number;
  };
  reason: string;
  lastPrice: number;
  change24h: number;
  volumeUsd: number;
  spreadBps: number;
  /** Свечи этого актива пришли живыми с OKX (иначе гипотезы по нему не строятся) */
  dataLive: boolean;
}

export interface Candidate {
  ticker: OKXTicker;
  volumeUsd: number;
  spreadBps: number;
  change24h: number;
  coarseScore: number;
}

/* --------------------------- уровень 1: пол --------------------------- */

export function quoteVolumeUsd(t: OKXTicker): number {
  // Для SPOT-пар OKX volCcy24h — объём в котировке (USDT); если пуст, считаем от базы
  if (t.volCcy24h > 0) return t.volCcy24h;
  return t.vol24h * (t.last || 0);
}

export function spreadBps(t: OKXTicker): number {
  if (t.bidPx <= 0 || t.askPx <= 0) return Number.POSITIVE_INFINITY;
  const mid = (t.bidPx + t.askPx) / 2;
  return ((t.askPx - t.bidPx) / mid) * 10000;
}

export function change24hPct(t: OKXTicker): number {
  return t.open24h > 0 ? ((t.last - t.open24h) / t.open24h) * 100 : 0;
}

/**
 * Базы, которые не являются торгуемым «активом»: стейблкоины и фиатные якоря.
 * Они проходят пол ликвидности (иногда лучше биткоина), но их «волатильность»
 * и «RS к BTC» — шум измерительной линейки, а не возможность.
 */
const NON_TRADEABLE_BASES = new Set([
  "USDC", "USDT", "DAI", "FDUSD", "TUSD", "PYUSD", "USDE", "USDS", "USDP", "BUSD",
  "USDJ", "GUSD", "LUSD", "RLUSD", "USDX", "USDD", "FRAX", "EUR", "EURI", "GBP",
  "TRY", "JPY", "AUD", "CNY", "BRL", "MXN", "RUB", "UAH",
]);

/** Только USDT-пары с реальным двухсторонним стаканом и достаточным объёмом. */
export function passesFloor(t: OKXTicker, cfg: UniverseConfig = UNIVERSE_CONFIG): boolean {
  if (!t.instId.endsWith("-USDT")) return false;
  if (NON_TRADEABLE_BASES.has(t.instId.slice(0, -5))) return false;
  if (t.last <= 0) return false;
  if (quoteVolumeUsd(t) < cfg.minQuoteVolumeUsd) return false;
  return spreadBps(t) <= cfg.maxSpreadBps;
}

/* ------------------------- уровень 2: merit-скан ------------------------- */

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Логарифмическая шкала объёма: $5M → 0, $3B → 1. */
function liquidityComponent(volumeUsd: number): number {
  const lo = Math.log10(UNIVERSE_CONFIG.minQuoteVolumeUsd);
  const hi = Math.log10(3_000_000_000);
  return clamp01((Math.log10(Math.max(1, volumeUsd)) - lo) / (hi - lo));
}

/** Реализованная волатильность по 15m закрытиям, %. */
export function realizedVolPct(candles: OKXCandle[]): number {
  if (candles.length < UNIVERSE_CONFIG.minCandles) return 0;
  const closes = candles.slice(-48).map((c) => c.close);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 5) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(varc) * 100;
}

/**
 * Предварительный ранжировщик (по одним тикерам, до запроса свечей):
 * объём + «ширина» движения + узость спреда. Нужен лишь чтобы сузить
 * ~1000 пар до shortlist, для которого уже тянем свечи.
 */
export function coarseRank(tickers: OKXTicker[], cfg: UniverseConfig = UNIVERSE_CONFIG): Candidate[] {
  const btcChange = tickers.find((t) => t.instId === UNIVERSE_ANCHOR)?.last
    ? change24hPct(tickers.find((t) => t.instId === UNIVERSE_ANCHOR)!)
    : 0;

  const out: Candidate[] = [];
  for (const t of tickers) {
    if (!passesFloor(t, cfg)) continue;
    const vol = quoteVolumeUsd(t);
    const spread = spreadBps(t);
    const chg = change24hPct(t);
    const liquidity = liquidityComponent(vol);
    // Движение относительно BTC: статичный актив скучен, слишком дёрганый — часто шум
    const rel = Math.abs(chg - btcChange);
    const motion = clamp01(rel / 8);
    const tightness = clamp01(1 - spread / cfg.maxSpreadBps);
    const coarseScore = 100 * (0.5 * liquidity + 0.34 * motion + 0.16 * tightness);
    out.push({ ticker: t, volumeUsd: vol, spreadBps: spread, change24h: chg, coarseScore });
  }

  out.sort((a, b) => b.coarseScore - a.coarseScore);
  // Якорь всегда в shortlist: по нему строится relative strength и режим рынка
  const btc = out.find((c) => c.ticker.instId === UNIVERSE_ANCHOR);
  const head = out.slice(0, cfg.shortlistSize);
  if (btc && !head.includes(btc)) head.push(btc);
  return head;
}

/** Параллельность с ограничением: публичные лимиты OKX ~20 req/2s на эндпоинт. */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface SeriesBundle {
  candles: OKXCandle[];
  isLive: boolean;
}

/** Свечи для shortlist — один запрос на актив, переиспользуются всем циклом. */
export async function fetchSeries(
  symbols: string[],
  bar = "15m",
  limit = 60
): Promise<Map<string, SeriesBundle>> {
  const entries = await mapLimited(symbols, 4, async (sym) => {
    const { candles, isLive } = await okxClient.getCandles(sym, bar, limit);
    return [sym, { candles, isLive }] as const;
  });
  return new Map(entries);
}

export interface ScoredCandidate extends Candidate {
  vol: number;
  volPercentile: number;
  rsVsBtc: number;
  turnoverPercentile: number;
  score: number;
  components: UniverseMember["components"];
  dataLive: boolean;
}

/** Полный merit-скор по shortlist: волатильность, RS к BTC, turnover, liquidity. */
export function scoreCandidates(
  candidates: Candidate[],
  series: Map<string, SeriesBundle>,
  cfg: UniverseConfig = UNIVERSE_CONFIG
): ScoredCandidate[] {
  const btc = series.get(UNIVERSE_ANCHOR);
  const btcChange =
    candidates.find((c) => c.ticker.instId === UNIVERSE_ANCHOR)?.change24h ??
    (btc && btc.candles.length > 1
      ? ((btc.candles[btc.candles.length - 1].close / btc.candles[0].close - 1) * 100)
      : 0);

  const withVol = candidates.map((c) => {
    const s = series.get(c.ticker.instId);
    const vol = s ? realizedVolPct(s.candles) : 0;
    return { ...c, vol, dataLive: Boolean(s?.isLive && s.candles.length >= cfg.minCandles) };
  });

  const vols = withVol.map((c) => c.vol).filter((v) => v > 0).sort((a, b) => a - b);
  const volumesSorted = withVol.map((c) => c.volumeUsd).sort((a, b) => a - b);

  const pct = (arr: number[], x: number) => {
    if (arr.length === 0) return 0;
    let i = 0;
    while (i < arr.length && arr[i] < x) i++;
    return i / arr.length;
  };

  return withVol
    .map((c) => {
      const volPercentile = pct(vols, c.vol);
      const turnoverPercentile = pct(volumesSorted, c.volumeUsd);
      const rsVsBtc = c.change24h - btcChange;

      const components = {
        liquidity: liquidityComponent(c.volumeUsd),
        volatility: volPercentile,
        relativeStrength: clamp01(Math.abs(rsVsBtc) / 10),
        turnover: turnoverPercentile,
      };
      const score =
        100 *
        (0.3 * components.liquidity +
          0.28 * components.volatility +
          0.22 * components.relativeStrength +
          0.2 * components.turnover);

      return { ...c, volPercentile, turnoverPercentile, rsVsBtc, score, components };
    })
    .sort((a, b) => b.score - a.score);
}

/* ---------------------- уровень 3: анти-толпа и разведка ---------------------- */

/** Счётчик подряд идущих циклов в топе. Живёт в процессе — этого достаточно
 *  для планировщика-синглтона; в БД дублируем как историю вселенной. */
const streaks = new Map<string, number>();

export function noteUniversePresence(symbols: string[]): void {
  const seen = new Set(symbols);
  for (const s of seen) streaks.set(s, (streaks.get(s) ?? 0) + 1);
  for (const [sym, n] of streaks) if (!seen.has(sym)) streaks.delete(sym);
}

function formatUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${(v / 1e3).toFixed(0)}K`;
}

function reasonFor(c: ScoredCandidate, role: UniverseRole): string {
  const isAnchor = c.ticker.instId === UNIVERSE_ANCHOR;
  const parts = [
    `объём ${formatUsd(c.volumeUsd)}`,
    `RV-перцентиль ${Math.round(c.volPercentile * 100)}`,
    // У якоря relative strength к самому себе всегда 0 — показываем его роль
    isAnchor ? "якорь вселенной" : `RS к BTC ${c.rsVsBtc >= 0 ? "+" : ""}${c.rsVsBtc.toFixed(1)}%`,
    `спред ${c.spreadBps.toFixed(1)} bps`,
  ];
  if (role === "explore") parts.push("exploration: пограничная зона, не топ-рейтинг");
  return parts.join(" · ");
}

function toMember(c: ScoredCandidate, role: UniverseRole, score: number): UniverseMember {
  return {
    symbol: c.ticker.instId,
    role,
    score,
    components: c.components,
    reason: reasonFor(c, role),
    lastPrice: c.ticker.last,
    change24h: c.change24h,
    volumeUsd: c.volumeUsd,
    spreadBps: c.spreadBps,
    dataLive: c.dataLive,
  };
}

/**
 * Финальная сборка вселенной: merit + exploration-слоты + anti-crowding.
 * cycleIndex использован вместо RNG — состав воспроизводим по истории циклов.
 */
export function selectUniverse(
  scored: ScoredCandidate[],
  cycleIndex: number,
  cfg: UniverseConfig = UNIVERSE_CONFIG
): UniverseMember[] {
  // Активы с несвежими данными не получают преимущества: они могли бы
  // «выиграть» скан на синтетике. Разметим штрафом, но оставим в пуле —
  // цикл сам отфильтрует их при построении гипотез.
  const merit = scored.map((c) => {
    let s = c.score;
    const streak = streaks.get(c.ticker.instId) ?? 0;
    if (streak >= cfg.maxConsecutiveCycles) s *= 0.85;
    if (!c.dataLive) s *= 0.7;
    return { c, effective: s };
  });
  merit.sort((a, b) => b.effective - a.effective);

  const chosen: UniverseMember[] = [];
  const taken = new Set<string>();

  for (const m of merit) {
    if (chosen.length >= cfg.coreSize) break;
    chosen.push(toMember(m.c, "core", Math.round(m.effective)));
    taken.add(m.c.ticker.instId);
  }

  // Якорь обязан быть в ядре: на него завязаны cross-asset и breadth-фичи
  if (!taken.has(UNIVERSE_ANCHOR)) {
    const anchor = merit.find((m) => m.c.ticker.instId === UNIVERSE_ANCHOR);
    if (anchor) {
      chosen[0] = toMember(anchor.c, "core", Math.round(anchor.effective));
      taken.add(UNIVERSE_ANCHOR);
    }
  }

  const band = scored
    .slice(cfg.coreSize, cfg.coreSize + cfg.exploreBand)
    .filter((c) => !taken.has(c.ticker.instId));
  if (band.length > 0) {
    // Ротация пограничной зоны: каждый цикл — новый участник, без случайности
    const pick = band[cycleIndex % band.length];
    chosen.push(toMember(pick, "explore", Math.round(pick.score)));
    taken.add(pick.ticker.instId);
    const second = band[(cycleIndex + 3) % band.length];
    if (cfg.exploreSize > 1 && second && second.ticker.instId !== pick.ticker.instId) {
      chosen.push(toMember(second, "explore", Math.round(second.score)));
    }
  }

  noteUniversePresence(chosen.map((m) => m.symbol));
  return chosen;
}

/** Полный проход: тикеры → shortlist → свечи → вселенная. */
export async function scanUniverse(cfg: UniverseConfig = UNIVERSE_CONFIG, cycleIndex = 0) {
  const { tickers, isLive, latencyMs } = await okxClient.getTickers();
  const candidates = coarseRank(tickers, cfg);
  const series = await fetchSeries(candidates.map((c) => c.ticker.instId), "15m", 60);
  const scored = scoreCandidates(candidates, series, cfg);
  const universe = selectUniverse(scored, cycleIndex, cfg);
  return { tickers, tickersLive: isLive, tickersLatencyMs: latencyMs, universe, series, scored };
}
