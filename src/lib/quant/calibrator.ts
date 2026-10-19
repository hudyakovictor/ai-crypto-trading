import { db } from "@/db";
import { forecasts, hypotheses } from "@/db/schema";
import { asc, eq } from "drizzle-orm";

/**
 * ВНЕШНИЙ КАЛИБРАТОР (H002, замороженный протокол P2).
 *
 * Проблема старого кода: Brier в learning-loop считался от СОБСТВЕННОГО
 * сглаженного winrate, а не от вероятности, которую система реально заявила.
 * Такая метрика измеряет саму себя и не измеряет калибровку [R05].
 *
 * Вербализованная уверенность LLM систематически переоценена (ECE 0.09–0.40 в
 * литературе), поэтому заявленная вероятность (planner conviction) калибруется
 * СНАРУЖИ на журнале разрешённых исходов: Beta-Bernoulli по 10 корзинам шириной
 * 0.1 с приором α=β=5. Изотоник запрещён до n≥1000 — переобучается на малых
 * выборках (Platt/Beta работают от ~50–200 наблюдений).
 *
 * ECE/Brier публикуются ТОЛЬКО на held-out хвосте (последние 20% исходов по
 * времени) — калибровочный ECE на train-выборке искусственно низкий.
 */

export const CALIBRATION_BINS = 10;
export const CALIBRATION_PRIOR_A = 5;
export const CALIBRATION_PRIOR_B = 5;
/** До n<50 калибратор — тождественное отображение (протокол P2, invalidation). */
export const CALIBRATION_MIN_N = 50;
/** Минимальный held-out для публикации ECE. */
export const CALIBRATION_MIN_HOLDOUT = 30;
/** Порог, после которого разрешается изотоник (не реализован здесь намеренно). */
export const ISOTONIC_MIN_N = 1000;

export interface CalibrationSample {
  /** Заявленная вероятность hit в момент решения (planner conviction). */
  stated: number;
  /** Фактический исход: hit=true, miss=false. Ambiguous/expired не входят. */
  hit: boolean;
  at: number;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  hits: number;
  /** Апостериорное среднее Beta(α0+hits, β0+n−hits) — откалиброванная вероятность корзины. */
  posterior: number;
}

export interface CalibrationState {
  n: number;
  ready: boolean;
  bins: CalibrationBin[];
  holdoutN: number;
  /** ECE сырого stated на held-out; null при holdoutN < 30. */
  eceRaw: number | null;
  /** ECE после калибратора на held-out. */
  eceCal: number | null;
  /** Brier сырого stated на held-out. */
  brierRaw: number | null;
  /** Brier откалиброванной вероятности на held-out. */
  brierCal: number | null;
  /** Brier константного прогноза базовой частотой — навык считается относительно него. */
  brierBase: number | null;
  baseRate: number;
}

function binIndex(p: number): number {
  const i = Math.floor(Math.max(0, Math.min(0.999999, p)) * CALIBRATION_BINS);
  return Math.max(0, Math.min(CALIBRATION_BINS - 1, i));
}

/**
 * Сэмплы из журнала: stated prob берётся из planner.conviction (проверенный
 * clamp 0.4–0.9 в planning-коде сохраняется как есть — протокол фиксирует
 * «clamp сжимает диапазон» как open question, а не правит данные задним числом).
 * Fallback, если conviction не записан: 1 − uncertainty гипотезы.
 */
export async function loadCalibrationSamples(limit = 4000): Promise<CalibrationSample[]> {
  try {
    const fc = await db
      .select({
        hypothesisId: forecasts.hypothesisId,
        outcome: forecasts.outcome,
        createdAt: forecasts.createdAt,
      })
      .from(forecasts)
      .where(eq(forecasts.status, "resolved"))
      .orderBy(asc(forecasts.createdAt))
      .limit(limit);
    const hyp = await db
      .select({
        id: hypotheses.id,
        uncertainty: hypotheses.uncertainty,
        scoreComponentsJson: hypotheses.scoreComponentsJson,
      })
      .from(hypotheses)
      .orderBy(asc(hypotheses.createdAt))
      .limit(limit);
    const byId = new Map(hyp.map((h) => [h.id, h]));

    const out: CalibrationSample[] = [];
    for (const f of fc) {
      if (f.outcome !== "hit" && f.outcome !== "miss") continue;
      const h = f.hypothesisId ? byId.get(f.hypothesisId) : undefined;
      const planner = (h?.scoreComponentsJson as { planner?: { conviction?: number } } | null)?.planner;
      let stated = typeof planner?.conviction === "number" ? planner.conviction : NaN;
      if (!Number.isFinite(stated) && h) stated = 1 - (h.uncertainty ?? 0.35);
      if (!Number.isFinite(stated)) continue;
      out.push({ stated: Math.max(0.01, Math.min(0.99, stated)), hit: f.outcome === "hit", at: f.createdAt.getTime() });
    }
    return out;
  } catch {
    return [];
  }
}

function eceOf(samples: { p: number; hit: boolean }[]): number {
  if (samples.length === 0) return NaN;
  const buckets = new Map<number, { sum: number; hits: number; n: number }>();
  for (const s of samples) {
    const i = binIndex(s.p);
    const b = buckets.get(i) ?? { sum: 0, hits: 0, n: 0 };
    b.sum += s.p;
    b.hits += s.hit ? 1 : 0;
    b.n++;
    buckets.set(i, b);
  }
  let ece = 0;
  for (const b of buckets.values()) {
    ece += (b.n / samples.length) * Math.abs(b.sum / b.n - b.hits / b.n);
  }
  return ece;
}

/** Строит состояние калибратора из сэмплов (детерминированно, без БД). */
export function buildCalibration(samples: CalibrationSample[]): CalibrationState {
  const bins: CalibrationBin[] = Array.from({ length: CALIBRATION_BINS }, (_, i) => ({
    lo: i / CALIBRATION_BINS,
    hi: (i + 1) / CALIBRATION_BINS,
    n: 0,
    hits: 0,
    posterior: (i + 0.5) / CALIBRATION_BINS,
  }));
  for (const s of samples) {
    const b = bins[binIndex(s.stated)];
    b.n++;
    if (s.hit) b.hits++;
  }
  for (const b of bins) {
    b.posterior =
      (CALIBRATION_PRIOR_A + b.hits) / (CALIBRATION_PRIOR_A + CALIBRATION_PRIOR_B + b.n);
  }

  const n = samples.length;
  const ready = n >= CALIBRATION_MIN_N;
  const baseRate = n > 0 ? samples.filter((s) => s.hit).length / n : 0.5;

  // Held-out: последние 20% по времени (samples уже отсортированы по createdAt).
  const holdoutStart = Math.floor(n * 0.8);
  const holdout = samples.slice(holdoutStart);
  const publish = holdout.length >= CALIBRATION_MIN_HOLDOUT;

  const train = samples.slice(0, holdoutStart);
  const trainBins: CalibrationBin[] = bins.map((b) => ({ ...b }));
  // Калибратор для ECE-оценки обучается только на train-части (честный held-out).
  for (const b of trainBins) {
    b.n = 0;
    b.hits = 0;
  }
  for (const s of train) {
    const b = trainBins[binIndex(s.stated)];
    b.n++;
    if (s.hit) b.hits++;
  }
  for (const b of trainBins) {
    b.posterior =
      (CALIBRATION_PRIOR_A + b.hits) / (CALIBRATION_PRIOR_A + CALIBRATION_PRIOR_B + b.n);
  }
  const cal = (p: number) => (ready ? trainBins[binIndex(p)].posterior : p);

  const rawPts = holdout.map((s) => ({ p: s.stated, hit: s.hit }));
  const calPts = holdout.map((s) => ({ p: cal(s.stated), hit: s.hit }));
  const brier = (pts: { p: number; hit: boolean }[]) =>
    pts.length ? pts.reduce((a, x) => a + (x.p - (x.hit ? 1 : 0)) ** 2, 0) / pts.length : NaN;
  const basePts = holdout.map((s) => ({ p: baseRate, hit: s.hit }));

  return {
    n,
    ready,
    bins,
    holdoutN: holdout.length,
    eceRaw: publish ? eceOf(rawPts) : null,
    eceCal: publish ? eceOf(calPts) : null,
    brierRaw: publish ? brier(rawPts) : null,
    brierCal: publish ? brier(calPts) : null,
    brierBase: publish ? brier(basePts) : null,
    baseRate,
  };
}

/** Откалибровать вероятность: при n<50 — тождественно (протокол P2). */
export function calibrateProbability(p: number, state: CalibrationState): number {
  if (!state.ready) return p;
  return state.bins[binIndex(p)].posterior;
}

let cache: { at: number; state: CalibrationState } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Состояние калибратора с коротким кэшем: пересчёт раз в 10 минут, не на каждый вызов. */
export async function getCalibrationState(): Promise<CalibrationState> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.state;
  const samples = await loadCalibrationSamples();
  const state = buildCalibration(samples);
  cache = { at: Date.now(), state };
  return state;
}
