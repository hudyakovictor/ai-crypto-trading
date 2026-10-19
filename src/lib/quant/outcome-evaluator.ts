import { ForecastOutcome, ErrorType, OKXCandle } from "../types";
import {
  BAR_MS,
  ERROR_THRESHOLDS,
  OUTCOME_BAR_PCT,
  RANGE_BAR_PCT,
  roundTripCostPct,
} from "./outcome-contract";

export interface ForecastRecord {
  id: number;
  hypothesisId: number | null;
  asset: string;
  direction: string;
  horizonMinutes: number;
  fixedAt: Date;
  resolveAt: Date;
  entryPrice: number;
  expectedMinPrice: number;
  expectedMaxPrice: number;
  targetCondition: string;
  invalidationCondition: string;
  costsBps: number;
  slippageBps: number;
  fundingDragBps: number;
  status: string;
}

export interface OutcomeResolution {
  forecastId: number;
  outcome: ForecastOutcome;
  resolvedPrice: number;
  mfe: number; // %
  mae: number; // %
  realizedReturnNet: number; // %
  errorType: ErrorType;
  resolvedAt: Date;
  /** Сколько подтверждённых баров окна [fixedAt, resolveAt] реально участвовало в расчёте. */
  barsUsed: number;
  /** Причина, по которой исход нельзя считать содержательным (пусто, если исход нормальный). */
  caveat: "" | "no_bars_in_window" | "unconfirmed_last_bar";
}

/**
 * Сверка записанного прогноза с тем, что реально произошло.
 *
 * Три исправления относительно прежней версии, каждое — про честность метки,
 * которой потом обучается система:
 *
 *  1. Окно свечей ограничено СВЕРХУ горизонтом прогноза. Раньше фильтр был
 *     только нижний (`timestamp >= fixedAt - 15m`), поэтому в MFE/MAE попадали
 *     бары после горизонта и текущий незакрытый бар: hit засчитывался за
 *     движение, которого на горизонте ещё не было (look-ahead).
 *  2. Пороги исхода и таксономии ошибок берутся из outcome-contract, а не из
 *     локальных литералов, и выражены в долях бара.
 *  3. Возвращается `barsUsed`/`caveat`: разрешение по нулю баров окна больше
 *     не выглядит как содержательный промах сигнала.
 */
export class OutcomeEvaluator {
  evaluate(forecast: ForecastRecord, currentPrice: number, candles: OKXCandle[]): OutcomeResolution {
    const { entryPrice, direction, costsBps, slippageBps, fundingDragBps } = forecast;
    const roundTripPct = roundTripCostPct(costsBps, slippageBps, fundingDragBps);

    const fixedTime = new Date(forecast.fixedAt).getTime();
    const resolveTime = new Date(forecast.resolveAt).getTime();
    const now = Date.now();

    // Бары, ЦЕЛИКОМ лежащие внутри окна прогноза. Бар, который к моменту
    // разрешения ещё не закрылся, в экстремумы не берётся: его high/low
    // продолжат расти, и это завышало бы MFE.
    const periodCandles = candles.filter(
      (c) => c.timestamp >= fixedTime && c.timestamp + BAR_MS <= resolveTime && c.timestamp + BAR_MS <= now
    );
    const lastBarUnconfirmed = candles.some(
      (c) => c.timestamp >= fixedTime && c.timestamp <= resolveTime && c.timestamp + BAR_MS > now
    );

    let maxPrice = currentPrice;
    let minPrice = currentPrice;
    if (periodCandles.length > 0) {
      maxPrice = Math.max(...periodCandles.map((c) => c.high), currentPrice);
      minPrice = Math.min(...periodCandles.map((c) => c.low), currentPrice);
    } else {
      maxPrice = Math.max(entryPrice, currentPrice);
      minPrice = Math.min(entryPrice, currentPrice);
    }

    let mfe = 0;
    let mae = 0;
    let rawReturn = 0;
    let isHit = false;

    if (direction === "UP") {
      mfe = ((maxPrice - entryPrice) / entryPrice) * 100;
      mae = ((entryPrice - minPrice) / entryPrice) * 100;
      rawReturn = ((currentPrice - entryPrice) / entryPrice) * 100;
      isHit = rawReturn > roundTripPct && mfe >= OUTCOME_BAR_PCT;
    } else if (direction === "DOWN") {
      mfe = ((entryPrice - minPrice) / entryPrice) * 100;
      mae = ((maxPrice - entryPrice) / entryPrice) * 100;
      rawReturn = ((entryPrice - currentPrice) / entryPrice) * 100;
      isHit = rawReturn > roundTripPct && mfe >= OUTCOME_BAR_PCT;
    } else {
      // RANGE / VOLATILITY / FLAT: проверяем, что цена осталась в пределах бара.
      const movePct = (Math.abs(currentPrice - entryPrice) / entryPrice) * 100;
      mfe = movePct;
      mae = 0;
      rawReturn = RANGE_BAR_PCT - movePct;
      isHit = movePct <= RANGE_BAR_PCT;
    }

    const realizedReturnNet = rawReturn - roundTripPct;
    const outcome: ForecastOutcome = isHit ? "hit" : "miss";
    const errorType: ErrorType = outcome === "hit" ? "none" : classifyError(rawReturn, realizedReturnNet, mfe);

    return {
      forecastId: forecast.id,
      outcome,
      resolvedPrice: currentPrice,
      mfe: Math.max(0, mfe),
      mae: Math.max(0, mae),
      realizedReturnNet,
      errorType,
      resolvedAt: new Date(),
      barsUsed: periodCandles.length,
      caveat: periodCandles.length === 0 ? "no_bars_in_window" : lastBarUnconfirmed ? "unconfirmed_last_bar" : "",
    };
  }
}

/** Тип ошибки — в долях бара исхода, а не в абсолютных процентах. */
function classifyError(rawReturn: number, netReturn: number, mfe: number): ErrorType {
  const bar = OUTCOME_BAR_PCT;
  if (rawReturn > 0 && netReturn <= 0) return "cost_drag";
  if (mfe >= bar && rawReturn <= -bar * ERROR_THRESHOLDS.wrongHorizonReversalPctOfBar) return "wrong_horizon";
  if (rawReturn <= -bar * ERROR_THRESHOLDS.wrongSignPctOfBar) return "wrong_sign";
  if (Math.abs(rawReturn) < bar * ERROR_THRESHOLDS.weakSignalPctOfBar) return "weak_signal";
  return "regime_mismatch";
}

export const outcomeEvaluator = new OutcomeEvaluator();
