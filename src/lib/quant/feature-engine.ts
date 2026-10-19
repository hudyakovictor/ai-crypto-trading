import {
  CategoryKey,
  NormalizedSignal,
  OKXCandle,
  OKXOrderBook,
  OKXFundingRate,
  OKXOpenInterest,
  MarketRegime,
  CATEGORY_KEYS,
  MacroRegime,
  toMacroRegime,
} from "../types";

export interface FeatureEngineInput {
  symbol: string;
  candles: OKXCandle[];
  candles1h?: OKXCandle[];
  candles4h?: OKXCandle[];
  book?: OKXOrderBook;
  funding?: OKXFundingRate;
  oi?: OKXOpenInterest;
  btcCandles?: OKXCandle[];
  allTickersPerformance?: { symbol: string; change24h: number; volume: number }[];
}

export interface FeatureEngineOutput {
  signals: Record<CategoryKey, NormalizedSignal>;
  regime: MarketRegime;
  macroRegime: MacroRegime;
  dataQualityScore: number;
}

/* ---------- Калибровка детектора режима ---------- */

/** Сколько баров берём для реализованной волатильности (10 × 15м = 2.5 часа). */
const VOL_WINDOW_BARS = 30;
/** Баров 15m в году и корень из этого числа для annualization. */
const BARS_PER_YEAR_15M = 365 * 24 * 4;
const BARS_PER_YEAR_15M_SQRT = Math.sqrt(BARS_PER_YEAR_15M);
/**
 * Пороги годовой волатильности. Для крипты типичные уровни: 40–120% годовых.
 * Прежние 0.08 / 0.02 делали VOLATILE почти всегда, а RANGING — никогда.
 */
const VOL_ANNUALIZED_HIGH = 1.2;
const VOL_ANNUALIZED_LOW = 0.45;
const VOL_ANNUALIZED_SQUEEZE = 0.3;
/** Порог ADX, выше которого движение считается трендом. */
const ADX_TREND_MIN = 25;
/** Порог ADX, ниже которого рынок считается пилой. */
const ADX_CHOP_MAX = 20;
/** Минимальный разрыв +DI/-DI, чтобы говорить о направленности. */
const DI_GAP_CHOP = 5;
/** Во сколько раз полоса диапазона должна быть меньше среднего бара для «сжатия». */
const SQUEEZE_BAND_ATR_RATIO = 2.5;
/** Окно ADX/ATR: 14 баров по 15 минут = 3.5 часа. */
const ADX_WINDOW = 14;
/**
 * Средний истинный диапазон ниже этой доли цены (1 bp на бар) — рынок «замёрз»:
 * ADX на таких данных не измеряет ничего, поэтому режим определяется отдельно.
 */
const FROZEN_ATR_PCT = 0.0001;
/**
 * Минимальное чистое смещение цены за окно ADX, чтобы считать движение
 * трендом (0.3% за 3.5 часа). Отсекает пилу с нулевым итогом.
 */
const TREND_MIN_DISPLACEMENT_PCT = 0.003;

/* ---------- Калибровка деривативов ---------- */

/** Базовая (нейтральная) ставка фандинга OKX: 0.01% за 8 часов. */
const FUNDING_NEUTRAL_RATE = 0.0001;
/** Множитель нормировки отклонения фандинга в [-1, 1]. */
const FUNDING_SCORE_MULT = 4000;
/** Порог нормированного скора, за которым у категории появляется направление. */
const FUNDING_DIR_THRESHOLD = 0.2;

export class FeatureEngine {
  private clip(val: number, min = -1, max = 1): number {
    if (isNaN(val)) return 0;
    return Math.max(min, Math.min(max, val));
  }

  private robustZScore(val: number, median: number, mad: number): number {
    if (mad <= 1e-6) return 0;
    const z = (0.6745 * (val - median)) / mad;
    // Tanh compression to [-1, 1]
    return Math.tanh(z / 2);
  }

  private calculateADX(candles: OKXCandle[], period = 14): { adx: number; plusDI: number; minusDI: number } {
    if (candles.length < period + 2) {
      return { adx: 0, plusDI: 50, minusDI: 50 };
    }

    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const closes = candles.map((c) => c.close);

    let plusDM = 0;
    let minusDM = 0;
    let trSum = 0;

    for (let i = 1; i < candles.length; i++) {
      const highDiff = highs[i] - highs[i - 1];
      const lowDiff = lows[i - 1] - lows[i];

      if (highDiff > 0) plusDM += highDiff;
      if (lowDiff > 0) minusDM += lowDiff;

      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trSum += tr;
    }

    const n = candles.length - 1;
    const avgTR = trSum / n;
    const avgPlusDM = plusDM / n;
    const avgMinusDM = minusDM / n;

    const plusDI = avgTR > 0 ? (100 * avgPlusDM) / avgTR : 0;
    const minusDI = avgTR > 0 ? (100 * avgMinusDM) / avgTR : 0;

    const diSum = plusDI + minusDI;
    const adx = diSum > 0 ? (100 * Math.abs(plusDI - minusDI)) / diSum : 0;

    return { adx, plusDI, minusDI };
  }

  private ema(values: number[], period: number): number[] {
    if (values.length < period) return values.map(() => 0);
    const multiplier = 2 / (period + 1);
    let emaVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const result: number[] = [];
    for (let i = 0; i < values.length; i++) {
      if (i < period) {
        result.push(0);
      } else {
        emaVal = values[i] * multiplier + emaVal * (1 - multiplier);
        result.push(emaVal);
      }
    }
    return result;
  }

  private emaSimple(values: number[], period: number): number[] {
    if (values.length < period) return [];
    const multiplier = 2 / (period + 1);
    let emaVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const result: number[] = [emaVal];
    for (let i = period; i < values.length; i++) {
      emaVal = values[i] * multiplier + emaVal * (1 - multiplier);
      result.push(emaVal);
    }
    return result;
  }

  private calculateEMAStack(candles: OKXCandle[]): { ema9: number; ema21: number; ema50: number } {
    const closes = candles.map((c) => c.close);
    const ema9 = this.emaSimple(closes, 9);
    const ema21 = this.emaSimple(closes, 21);
    const ema50 = this.emaSimple(closes, 50);
    return {
      ema9: ema9[ema9.length - 1] ?? closes[closes.length - 1],
      ema21: ema21[ema21.length - 1] ?? closes[closes.length - 1],
      ema50: ema50[ema50.length - 1] ?? closes[closes.length - 1],
    };
  }

  /**
   * Определение рыночного режима по 15-минутным свечам (массив в хронологическом
   * порядке: последний элемент — самая свежая свеча).
   *
   * Что исправлено:
   *  1. **Окно волатильности.** Реализованная вола считалась по ПЕРВЫМ 30 барам
   *     серии (`for i = 1..30` от начала массива), то есть по самым старым свечам
   *     из 100. Режим рынка определялся вчерашней волатильностью, а не текущей.
   *  2. **Пороги волатильности.** 0.08 / 0.02 в годовом выражении недостижимы для
   *     крипты: типичная 15-минутная σ ≈ 0.3% даёт ~0.18 годовых, поэтому почти
   *     любой рынок попадал в VOLATILE, а RANGING не возвращался никогда.
   *     Пороги пересчитаны на реалистичные годовые уровни (см. константы).
   *  3. **Мёртвая ветка тренда.** `if (ema9 > ema21 && ema21 > ema50) return
   *     "TRENDING_BULL"; return "TRENDING_BULL";` — обе ветки возвращали одно и то
   *     же, то есть стек EMA вообще не проверялся: трендом объявлялось любое
   *     расхождение DI. Теперь несогласованный тренд честно помечается как рваный.
   *  4. **LOW_VOLATILITY_SQUEEZE** больше не мёртвое значение перечисления:
   *     сжатие определяется по низкой воле и узкому диапазону относительно ATR.
   */
  detectRegime(candles: OKXCandle[]): MarketRegime {
    if (candles.length < 20) return "NEUTRAL_CONSOLIDATION";

    const { adx, plusDI, minusDI } = this.calculateADX(candles);
    const { ema9, ema21, ema50 } = this.calculateEMAStack(candles);
    const closes = candles.map((c) => c.close);
    const realizedVol = this.annualizedVol(closes, VOL_WINDOW_BARS);
    const atrPct = this.averageTrueRangePct(candles, ADX_WINDOW);

    // 0. «Замёрзший» рынок. ADX — это ОТНОШЕНИЕ направленного движения к
    //    истинному диапазону: когда диапазон вырождается (нет сделок, праздник,
    //    мёртвый альткоин), знаменатель стремится к нулю и ADX превращается в
    //    шум — на идеально плоском ряде он даёт 100 при +DI = 0, то есть
    //    «сильный медвежий тренд» на полном отсутствии движения. Раньше такой
    //    ряд объявлялся TRENDING_BEAR и открывал дорогу трендовым связкам.
    if (!Number.isFinite(atrPct) || atrPct < FROZEN_ATR_PCT) {
      const traded = candles.slice(-ADX_WINDOW).some((c) => c.volume > 0);
      // LIQUIDITY_CRUNCH раньше был недостижимым значением перечисления:
      // теперь он означает ровно то, что написано — движения и объёма нет.
      return traded ? "NEUTRAL_CONSOLIDATION" : "LIQUIDITY_CRUNCH";
    }

    // 1. Сила тренда: ADX(14) + стек EMA + реальное смещение цены за окно.
    if (adx > ADX_TREND_MIN) {
      const diUp = plusDI > minusDI;
      const emaUp = ema9 > ema21 && ema21 > ema50;
      const emaDown = ema9 < ema21 && ema21 < ema50;
      // Чистое смещение за окно ADX: пила с нулевым итогом трендом не является,
      // даже если DI и средние случайно выстроились в одну сторону.
      const disp = this.netDisplacement(closes, ADX_WINDOW);
      const trendConfirmed =
        Math.abs(disp) >= TREND_MIN_DISPLACEMENT_PCT && (diUp ? disp > 0 : disp < 0);

      if (trendConfirmed && diUp && emaUp) return "TRENDING_BULL";
      if (trendConfirmed && !diUp && emaDown) return "TRENDING_BEAR";
      // DI показывает направление, но структура средних или фактическое
      // смещение его не подтверждают: движение молодое или рваное. Называть
      // его трендом — значит давать трендовым связкам зелёный свет на флэте.
      // Режим в этом случае доопределяется по волатильности ниже: «chop» на
      // тихом рынке был бы такой же выдумкой, как и «тренд» на пиле.
    }

    // 2. Волатильность
    if (realizedVol > VOL_ANNUALIZED_HIGH) return "VOLATILE";

    // 3. Сжатие: вола низкая И диапазон последних баров узкий — классический
    //    предвестник импульса. Раньше режим не определялся никогда.
    if (realizedVol < VOL_ANNUALIZED_SQUEEZE && this.isRangeCompressed(candles)) {
      return "LOW_VOLATILITY_SQUEEZE";
    }

    if (realizedVol < VOL_ANNUALIZED_LOW) return "RANGING";

    // 4. Пиловка без направления
    if (adx < ADX_CHOP_MAX && Math.abs(plusDI - minusDI) < DI_GAP_CHOP) {
      return "HIGH_VOLATILITY_CHOP";
    }

    return "NEUTRAL_CONSOLIDATION";
  }

  /**
   * Годовая реализованная волатильность по последним `window` лог-доходностям
   * 15-минутных баров. Берётся ХВОСТ ряда — то, что происходит сейчас.
   */
  private annualizedVol(closes: number[], window: number): number {
    if (closes.length < 3) return 0;
    const from = Math.max(1, closes.length - window);
    const returns: number[] = [];
    for (let i = from; i < closes.length; i++) {
      const prev = closes[i - 1];
      const cur = closes[i];
      if (prev > 0 && cur > 0) returns.push(Math.log(cur / prev));
    }
    if (returns.length === 0) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    return Math.sqrt(variance) * BARS_PER_YEAR_15M_SQRT;
  }

  /**
   * Средний истинный диапазон в долях цены за последние `window` баров.
   * Мера «живости» рынка: около нуля — котировки стоят, и направленные
   * индикаторы на них не имеют смысла.
   */
  private averageTrueRangePct(candles: OKXCandle[], window: number): number {
    const tail = candles.slice(-(window + 1));
    if (tail.length < 2) return 0;
    let trSum = 0;
    for (let i = 1; i < tail.length; i++) {
      const prevClose = tail[i - 1].close;
      trSum += Math.max(
        tail[i].high - tail[i].low,
        Math.abs(tail[i].high - prevClose),
        Math.abs(tail[i].low - prevClose)
      );
    }
    const avgTr = trSum / (tail.length - 1);
    const lastClose = tail[tail.length - 1].close;
    return lastClose > 0 ? avgTr / lastClose : 0;
  }

  /** Чистое смещение цены за последние `window` баров, в долях (0.01 = 1%). */
  private netDisplacement(closes: number[], window: number): number {
    if (closes.length < window + 1) return 0;
    const from = closes[closes.length - 1 - window];
    const to = closes[closes.length - 1];
    return from > 0 ? (to - from) / from : 0;
  }

  /** Узкий ли диапазон последних баров относительно их среднего истинного диапазона. */
  private isRangeCompressed(candles: OKXCandle[], window = 10): boolean {
    const tail = candles.slice(-window);
    if (tail.length < 3) return false;
    const high = Math.max(...tail.map((c) => c.high));
    const low = Math.min(...tail.map((c) => c.low));
    const mid = (high + low) / 2;
    if (mid <= 0) return false;
    const bandWidth = (high - low) / mid;
    const atr = tail.reduce((acc, c) => acc + (c.high - c.low), 0) / tail.length / mid;
    // Полоса за 10 баров меньше 2.5 среднего бара — рынок сжат.
    return atr > 0 && bandWidth < atr * SQUEEZE_BAND_ATR_RATIO;
  }

  calculate15Categories(input: FeatureEngineInput): FeatureEngineOutput {
    const {
      symbol,
      candles,
      candles1h,
      candles4h,
      book,
      funding,
      oi,
      btcCandles,
      allTickersPerformance,
    } = input;
    void candles1h;
    void candles4h;
    const len = candles.length;
    const results: Partial<Record<CategoryKey, NormalizedSignal>> = {};

    if (len < 5) {
      // Fallback if not enough candles
      for (const cat of CATEGORY_KEYS) {
        results[cat] = {
          category: cat,
          primitiveName: "uninitialized",
          rawValue: 0,
          normalizedScore: 0,
          direction: "NEUTRAL",
          confidence: 0.1,
          missingness: 0.9,
          supportCount: len,
        };
      }
      const fallbackRegime = this.detectRegime(candles);
      return {
        signals: results as Record<CategoryKey, NormalizedSignal>,
        regime: fallbackRegime,
        macroRegime: toMacroRegime(fallbackRegime),
        dataQualityScore: Math.max(0, 10 - len * 1.5),
      };
    }

    const lastCandle = candles[len - 1];
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);
    const lastClose = lastCandle.close;

    // 1. Price & Returns (Momentum & Volatility-Adjusted Returns)
    const lookbackMom = Math.min(12, len - 1);
    const momReturn = (lastClose - closes[len - 1 - lookbackMom]) / closes[len - 1 - lookbackMom];
    const momNorm = this.clip(Math.tanh(momReturn * 30));
    results.price_returns = {
      category: "price_returns",
      primitiveName: "vol_adjusted_momentum_12",
      rawValue: momReturn * 100,
      normalizedScore: momNorm,
      direction: momNorm > 0.15 ? "UP" : momNorm < -0.15 ? "DOWN" : "NEUTRAL",
      confidence: Math.min(1, len / 50),
      missingness: 0,
      supportCount: len,
      metadata: { momReturn12: momReturn, lastClose },
    };

    // 2. Volume & Liquidity (RVOL & Turnover Surge)
    const recentVols = volumes.slice(-20);
    const medianVol = [...recentVols].sort((a, b) => a - b)[Math.floor(recentVols.length / 2)] || 1;
    const rvol = lastCandle.volume / Math.max(medianVol, 1e-4);
    const rvolNorm = this.clip((rvol - 1.0) / 2.0); // >1 RVOL is bullish volume participation
    results.volume_liquidity = {
      category: "volume_liquidity",
      primitiveName: "rvol_20_median",
      rawValue: rvol,
      normalizedScore: rvolNorm,
      direction: rvol > 1.4 ? (momNorm >= 0 ? "UP" : "DOWN") : "NEUTRAL",
      confidence: 0.85,
      missingness: 0,
      supportCount: recentVols.length,
      metadata: { rvol, currentVol: lastCandle.volume, medianVol },
    };

    // 3. Volatility & Regime
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push(Math.log(closes[i] / closes[i - 1]));
    }
    const recentReturns = returns.slice(-14);
    const meanRet = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
    const variance = recentReturns.reduce((a, b) => a + Math.pow(b - meanRet, 2), 0) / recentReturns.length;
    const realizedVol = Math.sqrt(variance) * Math.sqrt(365 * 24 * 4); // Annualized 15m
    const regime = this.detectRegime(candles);
    const volScore = regime === "TRENDING_BULL" ? 0.6 : regime === "TRENDING_BEAR" ? -0.6 : regime === "LOW_VOLATILITY_SQUEEZE" ? 0.35 : -0.2;
    results.volatility_regime = {
      category: "volatility_regime",
      primitiveName: "realized_vol_regime",
      rawValue: realizedVol * 100,
      normalizedScore: this.clip(volScore),
      direction: volScore > 0.2 ? "UP" : volScore < -0.2 ? "DOWN" : "NEUTRAL",
      confidence: 0.9,
      missingness: 0,
      supportCount: recentReturns.length,
      metadata: { realizedVol, regime },
    };

    // 4. Order Flow & Aggression (CVD & Taker Imbalance)
    let approxAggressiveBuy = 0;
    let approxAggressiveSell = 0;
    for (let i = Math.max(0, len - 10); i < len; i++) {
      const c = candles[i];
      const range = c.high - c.low;
      if (range > 0) {
        const buyFrac = (c.close - c.low) / range;
        approxAggressiveBuy += c.volume * buyFrac;
        approxAggressiveSell += c.volume * (1 - buyFrac);
      }
    }
    const flowTotal = approxAggressiveBuy + approxAggressiveSell;
    const flowImbalance = flowTotal > 0 ? (approxAggressiveBuy - approxAggressiveSell) / flowTotal : 0;
    const flowNorm = this.clip(flowImbalance * 2.0);
    results.order_flow = {
      category: "order_flow",
      primitiveName: "cvd_aggression_imbalance",
      rawValue: flowImbalance * 100,
      normalizedScore: flowNorm,
      direction: flowNorm > 0.15 ? "UP" : flowNorm < -0.15 ? "DOWN" : "NEUTRAL",
      confidence: 0.8,
      missingness: 0,
      supportCount: 10,
      metadata: { aggressiveBuy: approxAggressiveBuy, aggressiveSell: approxAggressiveSell },
    };

    // 5. Order Book Microstructure (IR@2% + Top 20 Depth Asymmetry)
    let bookImbalance = 0;
    // null = спреда нет, потому что нет стакана. Прежнее значение 1.5 bps
    // выдавалось за измерение и уходило в метаданные как факт.
    let spreadBps: number | null = null;
    let ir2pct = 0;
    const hasBook = Boolean(book && book.bids.length > 0 && book.asks.length > 0);
    if (book && book.bids.length > 0 && book.asks.length > 0) {
      const bidDepth = book.bids.slice(0, 15).reduce((acc, [, sz]) => acc + sz, 0);
      const askDepth = book.asks.slice(0, 15).reduce((acc, [, sz]) => acc + sz, 0);
      const totDepth = bidDepth + askDepth;
      if (totDepth > 0) {
        bookImbalance = (bidDepth - askDepth) / totDepth;
      }
      const topBid = book.bids[0][0];
      const topAsk = book.asks[0][0];
      if (topBid > 0) {
        spreadBps = ((topAsk - topBid) / topBid) * 10000;
      }
      // IR@2%: Imbalance Rate at 2% threshold
      const bidAskDiff = bidDepth - askDepth;
      const bidAskTotal = bidDepth + askDepth;
      ir2pct = bidAskTotal > 0 ? (bidAskDiff / bidAskTotal) * 2.0 : 0;
    }
    const bookNorm = this.clip(bookImbalance * 1.5);
    results.order_book_microstructure = {
      category: "order_book_microstructure",
      primitiveName: "depth_asymmetry_top20_ir2pct",
      rawValue: bookImbalance * 100,
      normalizedScore: bookNorm,
      direction: bookNorm > 0.1 ? "UP" : bookNorm < -0.1 ? "DOWN" : "NEUTRAL",
      // Нет стакана — нет и признака: нулевая уверенность и полная пропущенность.
      // Раньше отсутствующие данные давали уверенность 0.4, которая поднимала
      // coverageLiquidity связки и её EVS, то есть вознаграждала за пробел.
      confidence: hasBook ? 0.95 : 0,
      missingness: hasBook ? 0 : 1,
      supportCount: book ? book.bids.length : 0,
      metadata: { bookImbalance, spreadBps, ir2pct },
    };

    // 6. Derivatives Positioning (Funding Rate & Open Interest)
    //
    // Что исправлено:
    //  a) `funding?.fundingRate ?? 0.0001` подставлял нейтральную ставку OKX
    //     вместо отсутствующих данных, и формула выдавала из пробела готовый
    //     сигнал DOWN с уверенностью 0.5.
    //  b) normalizedScore и direction считались из ДВУХ разных величин с
    //     ПРОТИВОПОЛОЖНЫМИ знаками: `fundingAdjustedNorm = +funding*2000`
    //     (моментум) шёл в скор, а `fundingNorm = -funding*4000` (возврат к
    //     среднему) — в направление. При положительном фандинге получалось
    //     «скор > 0, direction = DOWN»: движок связок считал согласие
    //     категорий по direction, а EVS — по score, то есть одно и то же
    //     свидетельство усиливало связку и одновременно её разворачивало.
    //  Оставлена одна интерпретация — контртрендовая (переполненная сторона
    //  платит funding), и скор с направлением теперь выводятся из одного числа.
    const hasFunding = funding !== undefined && funding !== null;
    const fundingRateVal = hasFunding ? funding!.fundingRate : 0;
    const annualizedFunding = fundingRateVal * 3 * 365 * 100;
    // Отклонение от базовой ставки OKX (0.01% за 8ч): переполненность стороны
    // видна именно в отклонении, а не в абсолютном значении.
    const fundingExcess = hasFunding ? fundingRateVal - FUNDING_NEUTRAL_RATE : 0;
    const fundingScore = hasFunding ? this.clip(-fundingExcess * FUNDING_SCORE_MULT) : 0;
    results.derivatives_positioning = {
      category: "derivatives_positioning",
      primitiveName: "annualized_funding_pressure",
      rawValue: annualizedFunding,
      normalizedScore: fundingScore,
      direction: fundingScore > FUNDING_DIR_THRESHOLD ? "UP" : fundingScore < -FUNDING_DIR_THRESHOLD ? "DOWN" : "NEUTRAL",
      confidence: hasFunding ? 0.95 : 0,
      missingness: hasFunding ? 0 : 1,
      supportCount: 1,
      // OI пока остаётся только в метаданных: уровень открытого интереса сам по
      // себе не сигнал (это размер, а не изменение). См. идею в аудите: нужен
      // ряд OI по времени, чтобы считать dOI/dt и связку «цена↑ + OI↓».
      metadata: {
        fundingRate: fundingRateVal,
        fundingExcess,
        annualizedFunding,
        oiVal: oi && oi.oi > 0 ? oi.oi : null,
        oiCcy: oi && oi.oiCcy > 0 ? oi.oiCcy : null,
      },
    };

    // 7. Liquidations & Cascades (LGS - Liquidation Gravity Score)
    const recentHigh = Math.max(...candles.slice(-30).map((c) => c.high));
    const recentLow = Math.min(...candles.slice(-30).map((c) => c.low));
    const distToHigh = (recentHigh - lastClose) / lastClose;
    const distToLow = (lastClose - recentLow) / lastClose;
    // LGS: Liquidation Gravity Score - measures proximity to liquidation zones.
    // If very close to high (<0.5%), short liquidation breakout potential.
    // If very close to low (<0.5%), long liquidation cascade potential.
    let liqScore = 0;
    if (distToHigh < 0.005) liqScore = 0.55; // Breakout squeeze upward - shorts getting squeezed
    else if (distToLow < 0.005) liqScore = -0.55; // Breakdown cascade downward - longs getting liquidated
    else liqScore = (distToLow - distToHigh) * 15;
    const liqNorm = this.clip(liqScore);
    results.liquidations = {
      category: "liquidations",
      primitiveName: "lgs_liquidation_gravity_score",
      rawValue: (distToHigh - distToLow) * 100,
      normalizedScore: liqNorm,
      direction: liqNorm > 0.15 ? "UP" : liqNorm < -0.15 ? "DOWN" : "NEUTRAL",
      confidence: 0.85,
      missingness: 0,
      supportCount: 30,
      metadata: { distToHigh, distToLow, recentHigh, recentLow, lgs: liqScore },
    };

    // 8. Cross-Exchange & Cross-Venue Dispersion
    // Spot vs Futures basis proxy:
    // Прежнее `: 2.5` при отсутствии фандинга подставляло выдуманный базис
    // (+2.5 bps → dispNorm ≈ 0.24 → direction UP) с уверенностью 0.75 и
    // пропущенностью 0.1: категория выглядела измеренной, не будучи ею.
    const basisBps = hasFunding ? funding!.fundingRate * 10000 : 0;
    const dispNorm = hasFunding ? this.clip(Math.tanh(basisBps / 10)) : 0;
    results.cross_exchange_dispersion = {
      category: "cross_exchange_dispersion",
      primitiveName: "spot_swap_basis_dispersion",
      rawValue: basisBps,
      normalizedScore: dispNorm,
      direction: dispNorm > 0.2 ? "UP" : dispNorm < -0.2 ? "DOWN" : "NEUTRAL",
      confidence: hasFunding ? 0.75 : 0,
      missingness: hasFunding ? 0.1 : 1,
      supportCount: 1,
      metadata: { basisBps },
    };

    // 9. Cross-Asset Relationships (Beta to BTC & Relative Strength)
    let btcRelStrength = 0;
    if (btcCandles && btcCandles.length >= 20 && symbol !== "BTC-USDT") {
      const btcLast = btcCandles[btcCandles.length - 1].close;
      const btcPrev = btcCandles[btcCandles.length - 20].close;
      const btcReturn = (btcLast - btcPrev) / btcPrev;

      const symLast = lastClose;
      const symPrev = closes[Math.max(0, len - 20)];
      const symReturn = (symLast - symPrev) / symPrev;

      btcRelStrength = symReturn - btcReturn; // Alpha vs BTC
    } else {
      btcRelStrength = momReturn * 0.5;
    }
    const betaNorm = this.clip(Math.tanh(btcRelStrength * 25));
    results.cross_asset_relationships = {
      category: "cross_asset_relationships",
      primitiveName: "relative_strength_vs_btc",
      rawValue: btcRelStrength * 100,
      normalizedScore: betaNorm,
      direction: betaNorm > 0.15 ? "UP" : betaNorm < -0.15 ? "DOWN" : "NEUTRAL",
      confidence: 0.85,
      missingness: 0,
      supportCount: 20,
      metadata: { btcRelStrength },
    };

    // 10. Market Breadth & Rotation
    let breadthRatio = 0.5;
    if (allTickersPerformance && allTickersPerformance.length > 0) {
      const advancing = allTickersPerformance.filter((t) => t.change24h > 0).length;
      breadthRatio = advancing / allTickersPerformance.length;
    }
    const breadthNorm = this.clip((breadthRatio - 0.5) * 2);
    results.market_breadth_rotation = {
      category: "market_breadth_rotation",
      primitiveName: "advance_decline_breadth",
      rawValue: breadthRatio * 100,
      normalizedScore: breadthNorm,
      direction: breadthNorm > 0.2 ? "UP" : breadthNorm < -0.2 ? "DOWN" : "NEUTRAL",
      confidence: 0.8,
      missingness: 0.05,
      supportCount: allTickersPerformance?.length || 6,
      metadata: { breadthRatio },
    };

    // 11. Stablecoin & Flow Proxies (USDT Depth & Quote Liquidity Pressure)
    const quoteVolume = lastCandle.volCcy;
    const quoteAvg = candles.slice(-20).reduce((acc, c) => acc + c.volCcy, 0) / 20;
    const flowRatio = quoteAvg > 0 ? quoteVolume / quoteAvg : 1;
    const stableFlowNorm = this.clip((flowRatio - 1.0) * 0.7);
    results.stablecoin_flow_proxies = {
      category: "stablecoin_flow_proxies",
      primitiveName: "stablecoin_quote_turnover_flow",
      rawValue: flowRatio,
      normalizedScore: stableFlowNorm,
      direction: stableFlowNorm > 0.2 ? "UP" : stableFlowNorm < -0.2 ? "DOWN" : "NEUTRAL",
      confidence: 0.75,
      missingness: 0.1,
      supportCount: 20,
      metadata: { quoteVolume, quoteAvg, flowRatio },
    };

    // 12. On-Chain Activity Proxy (Whale Velocity & Large Print Concentration)
    // Modeled from OKX trade size distribution proxy
    const avgCandleVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const whaleVelocity = lastCandle.volume / Math.max(avgCandleVol, 1e-4);
    const onChainScore = whaleVelocity > 2.2 ? 0.6 : whaleVelocity < 0.5 ? -0.3 : 0.05;
    results.on_chain_activity = {
      category: "on_chain_activity",
      primitiveName: "whale_velocity_concentration_proxy",
      rawValue: whaleVelocity,
      normalizedScore: this.clip(onChainScore),
      direction: onChainScore > 0.2 ? "UP" : onChainScore < -0.2 ? "DOWN" : "NEUTRAL",
      confidence: 0.7,
      missingness: 0.15,
      supportCount: len,
      metadata: { whaleVelocity, avgCandleVol },
    };

    // 13. Sentiment & Attention (Spike Detector)
    // Combines extreme volume + directional price movement
    const attentionSpike = Math.abs(momReturn) * rvol;
    const sentimentBias = momReturn > 0 ? attentionSpike : -attentionSpike;
    const sentNorm = this.clip(Math.tanh(sentimentBias * 15));
    results.sentiment_attention = {
      category: "sentiment_attention",
      primitiveName: "attention_surge_polarity",
      rawValue: attentionSpike * 100,
      normalizedScore: sentNorm,
      direction: sentNorm > 0.2 ? "UP" : sentNorm < -0.2 ? "DOWN" : "NEUTRAL",
      confidence: 0.8,
      missingness: 0.05,
      supportCount: 20,
      metadata: { attentionSpike, sentimentBias },
    };

    // 14. Time, Calendar & Session Overlaps
    const now = new Date();
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    // Funding happens at 00:00, 08:00, 16:00 UTC on OKX
    const minutesToNextFunding = (8 * 60) - (((utcHours % 8) * 60) + utcMinutes);
    // London (07:00-15:00 UTC), NY (13:00-21:00 UTC), Asia (00:00-08:00 UTC)
    // NY + London overlap (13:00 - 16:00 UTC) has maximum liquidity and directional trend continuation
    const isOverlap = utcHours >= 13 && utcHours <= 16;
    const sessionScore = isOverlap ? 0.4 : minutesToNextFunding < 30 ? -0.25 : 0.1;
    results.time_calendar_session = {
      category: "time_calendar_session",
      primitiveName: "session_overlap_and_funding_window",
      rawValue: minutesToNextFunding,
      normalizedScore: this.clip(sessionScore),
      direction: sessionScore > 0.2 ? "UP" : sessionScore < -0.2 ? "DOWN" : "NEUTRAL",
      confidence: 1.0,
      missingness: 0,
      supportCount: 24,
      metadata: { utcHours, minutesToNextFunding, isOverlap },
    };

    // 15. Anomaly & Novelty Detector (Multi-dimensional Z-Score)
    // Compute distance of current vector from standard neutral state
    // В ядро аномалии входят только ИЗМЕРЕННЫЕ категории: раньше отсутствующий
    // стакан и фандинг попадали сюда нулями, но оставались в знаменателе, и
    // отклонение систематически занижалось именно тогда, когда данных мало.
    const coreScores: number[] = [momNorm, rvolNorm, flowNorm];
    if (hasBook) coreScores.push(bookNorm);
    if (hasFunding) coreScores.push(fundingScore);
    const meanDev = coreScores.reduce((a, b) => a + Math.abs(b), 0) / coreScores.length;
    // High anomaly means unusual confluence across multiple factors
    const anomalyZ = Math.tanh((meanDev - 0.25) * 4);
    results.anomaly_novelty = {
      category: "anomaly_novelty",
      primitiveName: "multivariate_confluence_anomaly",
      rawValue: meanDev,
      normalizedScore: this.clip(anomalyZ),
      direction: anomalyZ > 0.25 ? (momNorm >= 0 ? "UP" : "DOWN") : "NEUTRAL",
      // Уверенность пропорциональна числу измеренных ядер из пяти.
      confidence: 0.88 * (coreScores.length / 5),
      missingness: 1 - coreScores.length / 5,
      supportCount: len,
      metadata: { meanDev, anomalyZ },
    };

    const detectedRegime = this.detectRegime(candles);
    const macroRegime = toMacroRegime(detectedRegime);
    const dataQualityScore = this.calculateDataQualityScore(results, len);

    return {
      signals: results as Record<CategoryKey, NormalizedSignal>,
      regime: detectedRegime,
      macroRegime,
      dataQualityScore,
    };
  }

  /**
   * Качество данных актива, **в шкале 0..10**.
   *
   * Единая шкала важна: потребитель (`combination-engine`) считает компонент
   * EVS как `(dataQualityBase / 10) * (1 - avgMissing) * 10`, а запасные
   * значения в планировщике и роутах — 7.5 и 9.2, то есть все вокруг считают,
   * что максимум равен 10. Эта функция возвращала 0..100, поэтому компонент
   * качества данных всегда упирался в потолок 10 из 10: связка с мёртвыми
   * котировками получала столько же баллов, сколько связка с полным набором
   * живых признаков, и EVS переставал наказывать за плохие данные.
   */
  private calculateDataQualityScore(
    signals: Partial<Record<CategoryKey, NormalizedSignal>>,
    candleCount: number
  ): number {
    let score = 100;

    // Штраф за незаполненные категории. Нулевой скор — это НЕ признак пропуска
    // (фандинг ровно на базовой ставке даёт законный ноль), поэтому считаем
    // пропущенными только категории с полной пропущенностью.
    const values = Object.values(signals).filter((s): s is NormalizedSignal => Boolean(s));
    const filledCount = values.filter((s) => s.missingness < 1).length;
    score -= (CATEGORY_KEYS.length - filledCount) * 2;

    // Штраф за короткую историю
    if (candleCount < 10) score -= 15;
    if (candleCount < 5) score -= 20;

    // Штраф за среднюю пропущенность
    const avgMissing = values.length > 0
      ? values.reduce((acc, s) => acc + s.missingness, 0) / values.length
      : 1;
    score -= avgMissing * 30;

    // Приведение к шкале 0..10 — той самой, которую ждут потребители.
    return Math.max(0, Math.min(100, score)) / 10;
  }
}

export const featureEngine = new FeatureEngine();
