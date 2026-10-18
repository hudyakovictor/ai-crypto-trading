/**
 * Shared client-safe response types for the Quant Lab API.
 * No server-only imports allowed in this file.
 */

export interface StatusStats {
  totalAssetsTracked: number;
  activeHypothesesCount: number;
  totalResolved: number;
  hits: number;
  misses: number;
  ambiguous: number;
  empiricalHitRate: number;
  averageBrierScore: number;
}

export interface SchedulerInfo {
  lastRunTime: string | null;
  nextRunTime: string | null;
  secondsToNextRun: number;
  intervalMinutes: number;
}

/** Состав вселенной — как его видит UI: числа, объясняющие отбор пары. */
export type UniverseRole = "core" | "explore";

export interface UniverseMemberRow {
  symbol: string;
  role: UniverseRole;
  score: number;
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
  dataLive: boolean;
}

/** Откуда UI знает этот состав: цикл в памяти, последний записанный цикл, живой скан. */
export type UniverseSource = "memory" | "persisted" | "live-scan" | "none";

export interface AssetRow {
  id: number;
  symbol: string;
  baseAsset: string;
  lastPrice: number;
  priceChange24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
}

export interface StatusResponse {
  success: boolean;
  error?: string;
  scheduler: SchedulerInfo;
  stats: StatusStats;
  assets: AssetRow[];
  activeHypotheses: HypothesisRow[];
  recentForecasts: ForecastRow[];
  isLive?: boolean | null;
  latestLatencyMs?: number | null;
  latestRegime?: string | null;
  dataQuality?: string | null;
  autopilot?: { enabled: boolean; cyclesCompleted: number; retrainsCompleted: number };
  universe?: UniverseMemberRow[];
  universeSize?: number;
  universeSource?: UniverseSource;
  /** Сколько USDT-пар листинговано и сколько прошло пол исполнимости */
  universeListedCount?: number | null;
  universeFloorCount?: number | null;
  /** Кто оформил гипотезы последнего цикла — модель, правило или запас */
  planner?: PlannerDecisionRow | null;
}

export interface SignalCell {
  category: string;
  primitiveName: string;
  rawValue: number;
  normalizedScore: number;
  direction: string;
  confidence: number;
  missingness: number;
  supportCount: number;
}

export interface HeatmapAsset {
  symbol: string;
  lastPrice: number;
  change24h: number;
  regime: string;
  closes24: number[];
  topEvs: number;
  topDirection: string;
  signals: Record<string, SignalCell>;
  role?: UniverseRole;
  universeScore?: number;
  selectionReason?: string;
  dataLive?: boolean;
}

export interface HeatmapResponse {
  success: boolean;
  error?: string;
  categories: string[];
  isLive: boolean;
  latencyMs: number;
  assets: HeatmapAsset[];
  universeSource?: UniverseSource;
  universeSize?: number;
  updatedAt: string;
}

export interface ComboBreakdown {
  novelty: number;
  crossAgreement: number;
  historicalSupport: number;
  effectStability: number;
  coverageLiquidity: number;
  dataQuality: number;
  testability: number;
  totalScore: number;
}

export interface CombinationRow {
  passes?: boolean;
  code: string;
  name: string;
  categories: string[];
  operator: "AND" | "OR" | "WEIGHTED" | "VETO";
  expression: string;
  parameters: { lookback: number; threshold: number; regimeFilter?: string };
  earlyValueScore: number;
  breakdown: ComboBreakdown;
  sampleSize: number;
  status: "candidate" | "promising" | "validated" | "rejected";
  targetDirection: string;
  compositeScore: number;
}

export interface CombinationsResponse {
  success: boolean;
  error?: string;
  symbol: string;
  regime: string;
  dataLive?: boolean;
  universe?: UniverseMemberRow[];
  totalCount: number;
  stats: {
    promisingCount: number;
    candidatesCount: number;
    rejectedCount: number;
    topScore: number;
    avgScore: string;
  };
  filters?: { minEvs: number; minCategories: number; operators: string[]; directions: string[]; regimeLock: string; excludedCategories: string[] };
  passCount?: number;
  combinations: CombinationRow[];
}

export interface HypothesisRow {
  id: number;
  code: string;
  asset: string;
  direction: string;
  horizonMinutes: number;
  entryPrice: number;
  targetPrice: number;
  invalidationPrice: number;
  expectedMechanism: string;
  categoriesJson: unknown;
  exactFormula: string;
  uncertainty: number;
  status: string;
  createdAt: string;
}

export interface ForecastRow {
  id: number;
  hypothesisId: number | null;
  asset: string;
  direction: string;
  horizonMinutes: number;
  fixedAt: string;
  resolveAt: string;
  entryPrice: number;
  status: string;
  outcome: string | null;
  resolvedPrice: number | null;
  mfe: number | null;
  mae: number | null;
  realizedReturnNet: number | null;
  errorType: string | null;
  createdAt: string;
  hypothesis?: HypothesisRow | null;
}

export interface LedgerResponse {
  success: boolean;
  error?: string;
  hypotheses: HypothesisRow[];
  forecasts: ForecastRow[];
  totalCount: number;
}

export interface WeightRow {
  id: number;
  categoryName: string;
  labelRu?: string;
  labelEn?: string;
  currentWeight: number;
  priorWeight: number;
  totalSamples: number;
  totalHits: number;
  totalMisses: number;
  empiricalWinrate: number;
  brierScore: number;
  lastUpdated: string;
}

export interface LearningResponse {
  success: boolean;
  error?: string;
  weights: WeightRow[];
  errorDistribution: Record<string, number>;
  calibrationBins: { bin: string; predictedProb: number; actualHitRate: number; count: number }[];
  totalAccumulatedSamples: number;
  averageBrierScore: string;
}

export interface WalkForwardMetrics {
  sampleSize: number;
  hits: number;
  misses: number;
  hitRate: number;
  avgReturnNetBps: number;
  avgMfePct: number;
  avgMaePct: number;
  profitFactor: number;
}

export interface WalkForwardResponse {
  success: boolean;
  message?: string;
  error?: string;
  split?: { totalSamples: number; trainSamples: number; validationSamples: number; holdoutSamples: number };
  windows?: {
    inSampleTrain: WalkForwardMetrics;
    outOfSampleValidation: WalkForwardMetrics;
    strictlyHoldout: WalkForwardMetrics;
  };
  baselines?: Record<string, { name: string; hitRate: number; netReturnBps: number; description: string }>;
  verdict?: {
    isHoldoutRobust: boolean;
    alphaOverMomentumBps: number;
    stabilityScore: number;
    leakageAudit: string;
  };
}

/* ---------- Edge Lab (new) ---------- */

export interface EquityPoint {
  t: string;
  pnlUsd: number;
  cumPnlUsd: number;
  outcome: string;
  asset: string;
  retPct: number;
}

export interface StrategyLeaderRow {
  key: string;
  labelRu: string;
  categories: string[];
  direction: string;
  n: number;
  hits: number;
  misses: number;
  hitRate: number;
  wilsonLb: number;
  expectancyBps: number;
  totalPnlUsd: number;
  profitFactor: number;
  avgMfe: number;
  avgMae: number;
  status: "validated" | "promising" | "testing" | "invalid";
  lastSeen: string;
  regimes: string[];
}

export interface RegimePerfRow {
  regime: string;
  labelRu: string;
  n: number;
  hits: number;
  hitRate: number;
}

export interface ErrorTaxonomyRow {
  type: string;
  labelRu: string;
  fixRu: string;
  count: number;
  sharePct: number;
}

export interface CategoryContributionRow {
  category: string;
  labelRu: string;
  nWith: number;
  hrWith: number;
  nWithout: number;
  hrWithout: number;
  lift: number;
}

export interface ThresholdAdvisorRow {
  cutoff: number;
  n: number;
  hitRate: number;
  expectancyBps: number;
}

export interface FunnelStage {
  stage: string;
  count: number;
  note: string;
}

export interface EdgeResponse {
  success: boolean;
  error?: string;
  capital: {
    notionalPerTradeUsd: number;
    goalUsd: number;
  };
  categoryContribution?: CategoryContributionRow[];
  thresholdAdvisor?: ThresholdAdvisorRow[];
  bestCutoff?: number;
  funnel?: FunnelStage[];
  equity: {
    points: EquityPoint[];
    totalPnlUsd: number;
    tradesCount: number;
    goalProgressPct: number;
    maxDrawdownUsd: number;
    profitFactor: number;
    expectancyUsd: number;
    avgWinUsd: number;
    avgLossUsd: number;
    winRate: number;
  };
  leaderboard: StrategyLeaderRow[];
  regimeMatrix: RegimePerfRow[];
  errors: ErrorTaxonomyRow[];
  rolling: { recentHitRate: number; previousHitRate: number; delta: number; windowSize: number };
}

export interface CycleApiResult {
  timestamp: string;
  isLiveOKX: boolean;
  latencyMs: number;
  marketRegime: string;
  combinationsGenerated: number;
  hypothesesCreated: number;
  forecastsResolved: number;
  learningUpdated: boolean;
  summary: string;
  universe?: UniverseMemberRow[];
  trackedCount?: number;
  planner?: PlannerDecisionRow | null;
}

/* ---------- Планировщик цикла: кто решает, сколько гипотез оформлять ---------- */

/** Кому принадлежит выбор: модели («ai») или детерминированному правилу («rule»). */
export type PlannerAuthority = "ai" | "rule";
/** Кто РЕШИЛ на этом цикле: модель, правило или правило как запас при отказе LLM. */
export type PlannerMode = "ai" | "rule" | "fallback";

export interface PlannerPickRow {
  code: string;
  asset: string;
  /** Уверенность решившего 0..1 — идёт в uncertainty гипотезы и калибруется исходами */
  conviction: number;
  why: string;
  evs?: number;
  direction?: string;
  catsRu?: string[];
}

export interface PlannerDecisionRow {
  authority: PlannerAuthority;
  mode: PlannerMode;
  provider: string | null;
  model: string | null;
  /** Сколько связок было предложено на выбор */
  offered: number;
  /** Страховочный потолок, а не план */
  ceiling: number;
  picks: PlannerPickRow[];
  narrative: string;
  /** Отбракованные решения модели: выдуманный код, повтор, выше потолка */
  dropped: { code: string; reason: string }[];
  latencyMs: number;
  error: string | null;
  createdAt?: string;
}

/** Исходы решений каждой из политик — сама модель стоит под тестом. */
export interface PlannerArmStats {
  n: number;
  hits: number;
  hitRate: number;
  avgConviction: number;
  expectancyBps: number;
}

export interface PlannerRecordRow {
  ai: PlannerArmStats;
  rule: PlannerArmStats;
}

export interface PlannerResponse {
  success: boolean;
  error?: string;
  decision: PlannerDecisionRow | null;
  history: { createdAt: string; mode: PlannerMode; offered: number; picked: number; summary: string }[];
  /** Запасный порядок — это тоже правило, поэтому арми две: модель против детерминизма. */
  record: PlannerRecordRow;
  /** Сводка последних циклов: сколько решала модель и чем это кончалось. */
  summary?: { cycles: number; aiCycles: number; fallbackCycles: number; emptyCycles: number };
  policy: { authority: PlannerAuthority; ceiling: number };
}

/** GET/PUT /api/research/policy — кому принадлежит отбор и страховочный потолок. */
export interface PolicyResponse {
  success: boolean;
  error?: string;
  message?: string;
  policy: { authority: PlannerAuthority; ceiling: number; updatedAt?: string };
  limits?: { ceilingMin: number; ceilingMax: number };
}

/* ---------- AI Copilot ---------- */

export interface AiPromptMeta {
  key: string;
  title: string;
  descRu: string;
}

export interface AiAnalysisRow {
  id: number;
  kind: string;
  title: string;
  content: string;
  provider: string;
  model: string | null;
  createdAt: string;
  /** Причина офлайн-фолбэка (если разбор дал glassbox вместо LLM). */
  contextJson?: { llmError?: string | null } & Record<string, unknown> | null;
}

/** Провайдер локального детерминированного движка (офлайн, без внешней LLM). */
export const GLASSBOX_PROVIDER_ID = "glassbox-local";

/** true — ответила внешняя LLM (онлайн), false — локальный движок (офлайн). */
export function isOnlineProvider(providerId: string | null | undefined): boolean {
  return !!providerId && providerId !== GLASSBOX_PROVIDER_ID;
}

export interface AiStatusResponse {
  success: boolean;
  error?: string;
  provider: { id: string; model: string | null; live: boolean; chain: string[] };
  promptCatalog: AiPromptMeta[];
  history: AiAnalysisRow[];
}

export interface AiRunResponse {
  success: boolean;
  error?: string;
  analysis: AiAnalysisRow;
  provider: { id: string; model: string | null; live: boolean; chain: string[] };
  llmError: string | null;
  contextStats: { resolvedForecasts: number; hitRate: number; topCombo: string | null };
}

/* ---------- Filters / Autopilot ---------- */

export interface FiltersState {
  minEvs: number;
  minCategories: number;
  operators: string[];
  directions: string[];
  regimeLock: string;
  excludedCategories: string[];
}

export interface FiltersResponse {
  success: boolean;
  error?: string;
  filters: FiltersState & { updatedAt?: string };
  options: { operators: string[]; directions: string[]; regimes: string[] };
}

export interface AiProviderPublic {
  id: string;
  titleRu: string;
  hintRu: string;
  needsKey: boolean;
  enabled: boolean;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  keySource: "env" | "settings" | "none";
  hasKey: boolean;
}

export interface AiSettingsResponse {
  success: boolean;
  error?: string;
  providers: AiProviderPublic[];
  updatedAt?: string;
}

export interface AutopilotInfo {
  enabled: boolean;
  cyclesCompleted: number;
  retrainsCompleted: number;
  lastCycleAt?: string | null;
  lastError?: string | null;
  nextCycleEtaSec?: number;
}
