/**
 * ЕДИНЫЙ КОНТРАКТ ИСХОДА ПРОГНОЗА.
 *
 * До этого модуля порог исхода жил в двух местах и в двух единицах сразу:
 * `mfe > 0.35` (проценты) в outcome-evaluator и `OUTCOME_BAR_BPS = 35` (bps)
 * в planner, который печатал это число модели в промпте как «физику лаборатории».
 * Изменение одного из них молча рассинхронизировало то, что система делает,
 * и то, что она обещает. Теперь все пороги исхода и издержек объявлены здесь,
 * а evaluator и planner импортируют их.
 *
 * Все величины — в процентах и в базисных пунктах, производные пороги выражены
 * через бар исхода, чтобы при его изменении таксономия ошибок менялась вместе
 * с ним, а не жила своей жизнью.
 */

/** Бар исхода: минимальный ход в сторону сигнала за горизонт, bps. */
export const OUTCOME_BAR_BPS = 35;

/** То же в процентах — единица, в которой хранятся mfe/mae/realizedReturnNet. */
export const OUTCOME_BAR_PCT = OUTCOME_BAR_BPS / 100;

/** Издержки по умолчанию, bps. Реальные издержки актива должны переопределять их в прогнозе. */
export const DEFAULT_COSTS_BPS = 8;
export const DEFAULT_SLIPPAGE_BPS = 3;
export const DEFAULT_FUNDING_DRAG_BPS = 1;

/** Round-trip: вход и выход, bps и %. */
export function roundTripCostBps(costsBps = DEFAULT_COSTS_BPS, slippageBps = DEFAULT_SLIPPAGE_BPS, fundingDragBps = DEFAULT_FUNDING_DRAG_BPS): number {
  return (costsBps + slippageBps + fundingDragBps) * 2;
}

export function roundTripCostPct(costsBps = DEFAULT_COSTS_BPS, slippageBps = DEFAULT_SLIPPAGE_BPS, fundingDragBps = DEFAULT_FUNDING_DRAG_BPS): number {
  return roundTripCostBps(costsBps, slippageBps, fundingDragBps) / 100;
}

/** Бар для RANGE-прогноса: ход за горизонт не больше этого значения считается «флэт». */
export const RANGE_BAR_PCT = 0.45;

/*
 * Пороги таксономии ошибок — доли бара исхода, а не абсолютные проценты:
 * иначе на тихом активе всё попадает в weak_signal, а на волатильном — в
 * wrong_horizon, и таксономия описывает волатильность актива, а не природу ошибки.
 */
export const ERROR_THRESHOLDS = {
  /** MFE достиг бара, но к горизонту цена ушла против сигнала на эту долю бара. */
  wrongHorizonReversalPctOfBar: 0.5,
  /** Финальный ход против сигнала больше этой доли бара — знак был неверным. */
  wrongSignPctOfBar: 2,
  /** Финальный ход меньше этой доли бара — сигналу не хватило силы. */
  weakSignalPctOfBar: 0.4,
} as const;

/**
 * Задержка разрешения, при которой исход ещё считается действительным.
 * Если прогноз разрешили заметно позже горизонта, цена уже не та, которую
 * проверяли: такой исход честнее помечать expired и не пускать в обучение.
 */
export const MAX_RESOLUTION_DELAY_MS = 6 * 60 * 1000;

/** Длина бара, на котором работает контур. */
export const BAR_MS = 15 * 60 * 1000;
