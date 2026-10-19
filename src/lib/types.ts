export type MarketRegime = 
  | "TRENDING_BULL" 
  | "TRENDING_BEAR" 
  | "RANGING" 
  | "VOLATILE" 
  | "HIGH_VOLATILITY_CHOP" 
  | "LOW_VOLATILITY_SQUEEZE" 
  | "LIQUIDITY_CRUNCH" 
  | "NEUTRAL_CONSOLIDATION";

export type MacroRegime = "BULLISH" | "BEARISH" | "NEUTRAL" | "UNSTABLE";

/**
 * Рыночный режим → макро-режим.
 *
 * ВАЖНО: раньше TRENDING_BEAR попадал в одну ветку с TRENDING_BULL и возвращал
 * "BULLISH". Любой фильтр или подсказка модели, построенные на macroRegime,
 * получали «бычий рынок» на медвежьем тренде — то есть систематически
 * переворачивали знак контекста. Медвежий тренд теперь даёт BEARISH.
 */
export function toMacroRegime(marketRegime: MarketRegime): MacroRegime {
  switch (marketRegime) {
    case "TRENDING_BULL":
      return "BULLISH";
    case "TRENDING_BEAR":
      return "BEARISH";
    case "RANGING":
      return "NEUTRAL";
    case "VOLATILE":
    case "HIGH_VOLATILITY_CHOP":
      return "UNSTABLE";
    case "LOW_VOLATILITY_SQUEEZE":
    case "LIQUIDITY_CRUNCH":
    case "NEUTRAL_CONSOLIDATION":
      return "NEUTRAL";
    default:
      return "NEUTRAL";
  }
}

export type SignalDirection = "UP" | "DOWN" | "NEUTRAL" | "FLAT" | "RANGE" | "VOLATILITY";

export type ForecastStatus = "pending" | "resolved" | "expired";
export type ForecastOutcome = "hit" | "miss" | "ambiguous" | "expired";

export type ErrorType = 
  | "none"
  | "weak_signal"
  | "wrong_sign"
  | "wrong_horizon"
  | "regime_mismatch"
  | "insufficient_liquidity"
  | "category_conflict"
  | "cost_drag"
  | "external_event"
  | "data_gap";

export type CombinationStatus = "candidate" | "promising" | "validated" | "rejected";

export interface OKXTicker {
  instId: string;
  last: number;
  open24h: number;
  high24h: number;
  low24h: number;
  vol24h: number;
  volCcy24h: number;
  bidPx: number;
  bidSz: number;
  askPx: number;
  askSz: number;
  ts: number;
}

export interface OKXCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  volCcy: number;
}

export interface OKXFundingRate {
  instId: string;
  fundingRate: number;
  fundingTime: number;
  nextFundingRate?: number;
}

export interface OKXOpenInterest {
  instId: string;
  oi: number;
  oiCcy: number;
  ts: number;
}

export interface OKXOrderBook {
  instId: string;
  bids: [number, number][]; // [price, size]
  asks: [number, number][];
  ts: number;
}

export const CATEGORY_KEYS = [
  "price_returns",
  "volume_liquidity",
  "volatility_regime",
  "order_flow",
  "order_book_microstructure",
  "derivatives_positioning",
  "liquidations",
  "cross_exchange_dispersion",
  "cross_asset_relationships",
  "market_breadth_rotation",
  "stablecoin_flow_proxies",
  "on_chain_activity",
  "sentiment_attention",
  "time_calendar_session",
  "anomaly_novelty",
] as const;

export type CategoryKey = typeof CATEGORY_KEYS[number];

export interface CategoryInfo {
  key: CategoryKey;
  labelEn: string;
  labelRu: string;
  description: string;
}

export const CATEGORY_DEFINITIONS: Record<CategoryKey, CategoryInfo> = {
  price_returns: {
    key: "price_returns",
    labelEn: "Price & Returns",
    labelRu: "Цена и доходности",
    description: "Momentum, mean reversion distance, volatility-adjusted return, range expansion",
  },
  volume_liquidity: {
    key: "volume_liquidity",
    labelEn: "Volume & Liquidity",
    labelRu: "Объём и ликвидность",
    description: "Relative volume (RVOL), turnover ratio, Amihud illiquidity proxy, surge factor",
  },
  volatility_regime: {
    key: "volatility_regime",
    labelEn: "Volatility & Regime",
    labelRu: "Волатильность и режим",
    description: "Realized vol (GK), ATR ratio, volatility clustering, regime transition",
  },
  order_flow: {
    key: "order_flow",
    labelEn: "Order Flow & Aggression",
    labelRu: "Поток ордеров и CVD",
    description: "Taker buy/sell imbalance, CVD momentum, trade size toxicity proxy",
  },
  order_book_microstructure: {
    key: "order_book_microstructure",
    labelEn: "Order Book Microstructure",
    labelRu: "Микроструктура стакана",
    description: "Top-20 depth imbalance, bid/ask spread bps, depth asymmetry, slippage proxy",
  },
  derivatives_positioning: {
    key: "derivatives_positioning",
    labelEn: "Derivatives Positioning",
    labelRu: "Деривативы и фандинг",
    description: "Annualized funding rate, Open Interest delta, Basis premium, leverage proxy",
  },
  liquidations: {
    key: "liquidations",
    labelEn: "Liquidation Cascades",
    labelRu: "Ликвидации и каскады",
    description: "Liquidation imbalance proxy, cascade proximity, squeeze risk index",
  },
  cross_exchange_dispersion: {
    key: "cross_exchange_dispersion",
    labelEn: "Cross-Venue Dispersion",
    labelRu: "Межрыночная дисперсия",
    description: "Futures-spot basis spread, funding divergence across venues, venue lead-lag",
  },
  cross_asset_relationships: {
    key: "cross_asset_relationships",
    labelEn: "Cross-Asset Relationships",
    labelRu: "Межассетные связи",
    description: "BTC/ETH beta, market leader correlation, cointegration residual z-score",
  },
  market_breadth_rotation: {
    key: "market_breadth_rotation",
    labelEn: "Market Breadth & Rotation",
    labelRu: "Ширина рынка и ротация",
    description: "Advance/Decline ratio, volume concentration, cross-sectional ranking shifts",
  },
  stablecoin_flow_proxies: {
    key: "stablecoin_flow_proxies",
    labelEn: "Stablecoin & Flow Proxies",
    labelRu: "Потоки стейблкоинов",
    description: "USDT/USDC dominance delta, exchange inflow/outflow proxy, dry powder ratio",
  },
  on_chain_activity: {
    key: "on_chain_activity",
    labelEn: "On-Chain Activity Proxy",
    labelRu: "Ончейн активность",
    description: "Whale transfer velocity, active network fee proxy, concentration metric",
  },
  sentiment_attention: {
    key: "sentiment_attention",
    labelEn: "Sentiment & Attention",
    labelRu: "Сентимент и внимание",
    description: "Crowd bias from funding extremes, search/volume attention spike index",
  },
  time_calendar_session: {
    key: "time_calendar_session",
    labelEn: "Session & Calendar Cycles",
    labelRu: "Сессии и циклы времени",
    description: "OKX 8h funding window countdown, London/NY/Asia session overlaps, weekend liquidity",
  },
  anomaly_novelty: {
    key: "anomaly_novelty",
    labelEn: "Anomaly & Novelty Detector",
    labelRu: "Аномалии и новизна",
    description: "Robust Mahalanobis z-score, multi-factor change-point, outlier isolation",
  },
};

export interface NormalizedSignal {
  category: CategoryKey;
  primitiveName: string;
  rawValue: number;
  normalizedScore: number; // -1.0 to +1.0
  direction: SignalDirection;
  confidence: number; // 0 to 1
  missingness: number; // 0 to 1
  supportCount: number;
  metadata?: Record<string, unknown>;
}

export interface EarlyValueBreakdown {
  novelty: number;            // 0 - 20
  crossAgreement: number;     // 0 - 20
  historicalSupport: number;  // 0 - 20
  effectStability: number;    // 0 - 15
  coverageLiquidity: number;  // 0 - 10
  dataQuality: number;        // 0 - 10
  testability: number;        // 0 - 5
  totalScore: number;         // 0 - 100
}

export interface GeneratedCombination {
  code: string;
  name: string;
  categories: CategoryKey[];
  operator: "AND" | "OR" | "WEIGHTED" | "VETO";
  expression: string;
  parameters: {
    lookback: number;
    threshold: number;
    regimeFilter?: MarketRegime;
    weights?: Record<string, number>;
  };
  earlyValueScore: number;
  breakdown: EarlyValueBreakdown;
  sampleSize: number;
  status: CombinationStatus;
  targetDirection: SignalDirection;
  compositeScore: number; // -1.0 to 1.0
}
