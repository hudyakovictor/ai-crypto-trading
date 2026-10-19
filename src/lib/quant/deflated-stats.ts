import { db } from "@/db";
import { experimentRuns, forecasts } from "@/db/schema";
import { asc, eq } from "drizzle-orm";

/**
 * СЧЁТЧИК ИСПЫТАНИЙ И DEFLATED SHARPE (H004, замороженный протокол P4).
 *
 * Планировщик каждый цикл отбирает лучшее из десятков кандидатов — это машина
 * множественного тестирования: наблюдаемый hit-rate/SR лучших связок завышен
 * систематически (winner's curse). Масштабное воспроизведение LdP на крипто:
 * 50 000 конфигураций, лучший SR 2.00 при E[max|null] 2.72 → DSR 0.029.
 *
 * Правила протокола P4 (внешний якорь — LLM эти пороги не меняет):
 *  — trials = Σ offered кандидатов всех циклов + Σ combos/100 (эффективные);
 *  — trials считаются по OFFERED, а не по SELECTED — перебор нельзя занизить;
 *  — DSR ≥ 0.95 — допуск связки к sizing; при n < 30 исходов гейт МОЛЧИТ
 *    (не «пропускает»): статистически неотличимо от шума.
 *
 * Формулы: Bailey & López de Prado — PSR/DSR; Var[SR] аппроксимируется
 * выборочной дисперсией SR (консервативный proxy при малом числе независимых
 * trial-серий — open question H004).
 */

const EULER_MASCHERONI = 0.5772156649;

/** Стандартная нормальная CDF через аппроксимацию erf (точность ~1e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Обратная нормальная CDF (рациональная аппроксимация Acklam, |ε|<1.15e-9). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Wilson lower bound доли: «HR 100% при n=2» больше не аргумент. */
export function wilsonLowerBound(hits: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const ph = hits / n;
  const denom = 1 + (z * z) / n;
  const center = ph + (z * z) / (2 * n);
  const margin = z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (center - margin) / denom);
}

export function skewness(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = xs.reduce((a, x) => a + x, 0) / n;
  const s = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1));
  if (s === 0) return 0;
  const g = xs.reduce((a, x) => a + ((x - m) / s) ** 3, 0) / n;
  return (Math.sqrt(n * (n - 1)) / (n - 2)) * g;
}

/** Эксцесс (нормальный = 3). */
export function kurtosis(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return 3;
  const m = xs.reduce((a, x) => a + x, 0) / n;
  const s2 = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1);
  if (s2 === 0) return 3;
  const k = xs.reduce((a, x) => a + ((x - m) ** 4), 0) / (n * s2 * s2);
  return Math.max(1, k);
}

export interface DeflatedGate {
  /** Кумулятивное число испытаний лаборатории (offered + combos/100). */
  trials: number;
  /** Число разрешённых net-доходностей, по которым считается SR. */
  n: number;
  /** Sharpe на одну сделку (не аннуализированный): mean/std net-доходностей. */
  sr: number;
  /** Ожидаемый максимум SR под нулевой гипотезой при N trials. */
  sr0: number;
  /** Probabilistic Sharpe Ratio против SR*=0. */
  psr: number;
  /** Deflated Sharpe Ratio: PSR против SR0 с поправкой на trials. */
  dsr: number;
  /** Wilson LB общего hit-rate. */
  wilsonLb: number;
  hitRate: number;
  /**
   * Вердикт гейта: gate_silent (n<30 — молчит, НЕ пропускает), pass (DSR≥0.95),
   * fail (DSR<0.95 при достаточном n).
   */
  verdict: "gate_silent" | "pass" | "fail";
}

export const DSR_GATE = 0.95;
export const DSR_MIN_N = 30;

/**
 * PSR/DSR-математика инлайнится в computeDeflatedGate: SR* для PSR = 0,
 * для DSR — E[max|null] при N trials (expectedMaxSharpeNull). Знаменатель —
 * стандартная ошибка SR со skew/kurtosis поправкой Bailey–LdP.
 */

/** E[max SR | null] при N независимых испытаниях (False Strategy Theorem). */
export function expectedMaxSharpeNull(numTrials: number, varSrAcrossTrials: number): number {
  const N = Math.max(2, Math.round(numTrials));
  const sd = Math.sqrt(Math.max(1e-12, varSrAcrossTrials));
  const z1 = normInv(1 - 1 / N);
  const z2 = normInv(1 - 1 / (N * Math.E));
  return sd * ((1 - EULER_MASCHERONI) * z1 + EULER_MASCHERONI * z2);
}

/** Полный гейт лаборатории: trials из experiment_runs, returns из forecasts. */
export async function computeDeflatedGate(): Promise<DeflatedGate> {
  const empty: DeflatedGate = {
    trials: 0, n: 0, sr: 0, sr0: 0, psr: 0, dsr: 0, wilsonLb: 0, hitRate: 0, verdict: "gate_silent",
  };
  try {
    const [runs, fc] = await Promise.all([
      db
        .select({
          combinationsGenerated: experimentRuns.combinationsGenerated,
          metricsJson: experimentRuns.metricsJson,
        })
        .from(experimentRuns)
        .orderBy(asc(experimentRuns.createdAt))
        .limit(20000),
      db
        .select({ outcome: forecasts.outcome, ret: forecasts.realizedReturnNet })
        .from(forecasts)
        .where(eq(forecasts.status, "resolved")),
    ]);

    let trials = 0;
    for (const r of runs) {
      const offered = Number((r.metricsJson as { planner?: { offered?: number } } | null)?.planner?.offered ?? 0);
      const combos = Number(r.combinationsGenerated ?? 0);
      trials += (Number.isFinite(offered) ? offered : 0) + (Number.isFinite(combos) ? combos / 100 : 0);
    }

    const returns: number[] = [];
    let hits = 0;
    let nm = 0;
    for (const f of fc) {
      if (f.outcome !== "hit" && f.outcome !== "miss") continue;
      nm++;
      if (f.outcome === "hit") hits++;
      returns.push((f.ret ?? 0) * 100); // net в bps
    }

    const n = returns.length;
    if (n < 3) {
      return { ...empty, trials: Math.round(trials), n, hitRate: nm ? hits / nm : 0, wilsonLb: wilsonLowerBound(hits, nm) };
    }
    const mean = returns.reduce((a, x) => a + x, 0) / n;
    const sd = Math.sqrt(returns.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
    const sr = sd > 0 ? mean / sd : 0;
    const g3 = skewness(returns);
    const g4 = kurtosis(returns);
    const denomTerm = Math.max(1e-9, 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr);
    const varSr = denomTerm / Math.max(1, n - 1);
    const sr0 = expectedMaxSharpeNull(Math.max(2, trials), varSr);
    const psr = normCdf(((sr - 0) * Math.sqrt(n - 1)) / Math.sqrt(denomTerm));
    const dsr = normCdf(((sr - sr0) * Math.sqrt(n - 1)) / Math.sqrt(denomTerm));

    const verdict: DeflatedGate["verdict"] = n < DSR_MIN_N ? "gate_silent" : dsr >= DSR_GATE ? "pass" : "fail";
    return {
      trials: Math.round(trials),
      n,
      sr: Number(sr.toFixed(4)),
      sr0: Number(sr0.toFixed(4)),
      psr: Number(psr.toFixed(4)),
      dsr: Number(dsr.toFixed(4)),
      wilsonLb: Number(wilsonLowerBound(hits, nm).toFixed(4)),
      hitRate: nm ? Number(((hits / nm) * 100).toFixed(1)) : 0,
      verdict,
    };
  } catch {
    return empty;
  }
}
