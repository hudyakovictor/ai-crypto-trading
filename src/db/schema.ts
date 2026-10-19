import { pgTable, text, serial, timestamp, doublePrecision, integer, boolean, jsonb } from "drizzle-orm/pg-core";

export const assets = pgTable("assets", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().unique(), // e.g. BTC-USDT
  baseAsset: text("base_asset").notNull(),   // e.g. BTC
  quoteAsset: text("quote_asset").notNull(), // e.g. USDT
  exchange: text("exchange").notNull().default("OKX"),
  lastPrice: doublePrecision("last_price").notNull().default(0),
  priceChange24h: doublePrecision("price_change_24h").notNull().default(0),
  volume24h: doublePrecision("volume_24h").notNull().default(0),
  high24h: doublePrecision("high_24h").notNull().default(0),
  low24h: doublePrecision("low_24h").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  lastFetchedAt: timestamp("last_fetched_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const candles = pgTable("candles", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull().default("15m"),
  timestamp: timestamp("timestamp").notNull(), // Candle open time
  open: doublePrecision("open").notNull(),
  high: doublePrecision("high").notNull(),
  low: doublePrecision("low").notNull(),
  close: doublePrecision("close").notNull(),
  volume: doublePrecision("volume").notNull(),
  volCcy: doublePrecision("vol_ccy").notNull().default(0), // Quote volume
  confirmed: boolean("confirmed").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const signalFeatures = pgTable("signal_features", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  category: text("category").notNull(), // 1 of 15 categories
  primitiveName: text("primitive_name").notNull(),
  rawValue: doublePrecision("raw_value").notNull(),
  normalizedScore: doublePrecision("normalized_score").notNull(), // -1.0 to +1.0
  direction: text("direction").notNull(), // UP, DOWN, NEUTRAL
  confidence: doublePrecision("confidence").notNull().default(0.5), // 0 to 1
  missingness: doublePrecision("missingness").notNull().default(0),
  supportCount: integer("support_count").notNull().default(100),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  metadataJson: jsonb("metadata_json"),
});

export const combinations = pgTable("combinations", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  expression: text("expression").notNull(),
  categoriesJson: jsonb("categories_json").notNull(), // Array of categories included
  parametersJson: jsonb("parameters_json").notNull(),
  earlyValueScore: doublePrecision("early_value_score").notNull().default(0), // 0-100
  noveltyScore: doublePrecision("novelty_score").notNull().default(0),
  crossAgreementScore: doublePrecision("cross_agreement_score").notNull().default(0),
  historicalSupportScore: doublePrecision("historical_support_score").notNull().default(0),
  stabilityScore: doublePrecision("stability_score").notNull().default(0),
  liquidityScore: doublePrecision("liquidity_score").notNull().default(0),
  dataQualityScore: doublePrecision("data_quality_score").notNull().default(0),
  testabilityScore: doublePrecision("testability_score").notNull().default(0),
  sampleSize: integer("sample_size").notNull().default(0),
  status: text("status").notNull().default("candidate"), // candidate, promising, validated, rejected
  failurePatternsJson: jsonb("failure_patterns_json"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const hypotheses = pgTable("hypotheses", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(), // e.g. HYP-BTC-2026-001
  asset: text("asset").notNull(),
  venue: text("venue").notNull().default("OKX"),
  timeframe: text("timeframe").notNull().default("15m"),
  direction: text("direction").notNull(), // UP, DOWN, FLAT, RANGE, VOLATILITY
  horizonMinutes: integer("horizon_minutes").notNull().default(15),
  entryPrice: doublePrecision("entry_price").notNull(),
  targetPrice: doublePrecision("target_price").notNull(),
  invalidationPrice: doublePrecision("invalidation_price").notNull(),
  expectedMechanism: text("expected_mechanism").notNull(),
  categoriesJson: jsonb("categories_json").notNull(),
  exactFormula: text("exact_formula").notNull(),
  parameterSetId: text("parameter_set_id").notNull().default("v1.0.0"),
  dataVersion: text("data_version").notNull().default("okx-v5-live"),
  scoreComponentsJson: jsonb("score_components_json").notNull(),
  uncertainty: doublePrecision("uncertainty").notNull().default(0.35),
  status: text("status").notNull().default("active"), // active, fulfilled, invalidated, expired
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const forecasts = pgTable("forecasts", {
  id: serial("id").primaryKey(),
  hypothesisId: integer("hypothesis_id"),
  asset: text("asset").notNull(),
  direction: text("direction").notNull(),
  horizonMinutes: integer("horizon_minutes").notNull().default(15),
  fixedAt: timestamp("fixed_at").defaultNow().notNull(),
  resolveAt: timestamp("resolve_at").notNull(),
  entryPrice: doublePrecision("entry_price").notNull(),
  expectedMinPrice: doublePrecision("expected_min_price").notNull(),
  expectedMaxPrice: doublePrecision("expected_max_price").notNull(),
  targetCondition: text("target_condition").notNull(),
  invalidationCondition: text("invalidation_condition").notNull(),
  costsBps: doublePrecision("costs_bps").notNull().default(8.0), // Fees + slippage in bps
  slippageBps: doublePrecision("slippage_bps").notNull().default(3.0),
  fundingDragBps: doublePrecision("funding_drag_bps").notNull().default(1.0),
  checksum: text("checksum").notNull(),
  status: text("status").notNull().default("pending"), // pending, resolved, expired
  outcome: text("outcome"), // hit, miss, ambiguous, expired
  resolvedPrice: doublePrecision("resolved_price"),
  mfe: doublePrecision("mfe"), // Max Favorable Excursion %
  mae: doublePrecision("mae"), // Max Adverse Excursion %
  realizedReturnNet: doublePrecision("realized_return_net"), // % after costs
  errorType: text("error_type"), // weak_signal, wrong_sign, wrong_horizon, regime_mismatch, cost_drag, none
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const learningWeights = pgTable("learning_weights", {
  id: serial("id").primaryKey(),
  categoryName: text("category_name").notNull().unique(), // 1 of 15 categories
  currentWeight: doublePrecision("current_weight").notNull().default(1.0),
  priorWeight: doublePrecision("prior_weight").notNull().default(1.0),
  totalSamples: integer("total_samples").notNull().default(0),
  totalHits: integer("total_hits").notNull().default(0),
  totalMisses: integer("total_misses").notNull().default(0),
  empiricalWinrate: doublePrecision("empirical_winrate").notNull().default(0.5),
  brierScore: doublePrecision("brier_score").notNull().default(0.25),
  regimePerformanceJson: jsonb("regime_performance_json"),
  lastUpdated: timestamp("last_updated").defaultNow().notNull(),
});

export const experimentRuns = pgTable("experiment_runs", {
  id: serial("id").primaryKey(),
  runType: text("run_type").notNull(), // scheduled_15m, manual_trigger, walk_forward, parameter_grid
  totalSignalsProcessed: integer("total_signals_processed").notNull().default(0),
  combinationsGenerated: integer("combinations_generated").notNull().default(0),
  hypothesesCreated: integer("hypotheses_created").notNull().default(0),
  forecastsResolved: integer("forecasts_resolved").notNull().default(0),
  learningUpdatesCount: integer("learning_updates_count").notNull().default(0),
  regimeDetected: text("regime_detected").notNull().default("NEUTRAL_CONSOLIDATION"),
  logSummary: text("log_summary").notNull(),
  metricsJson: jsonb("metrics_json"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const dataQualityLogs = pgTable("data_quality_logs", {
  id: serial("id").primaryKey(),
  source: text("source").notNull().default("OKX-REST"),
  metricType: text("metric_type").notNull(), // latency, gap, rate_limit, stale
  status: text("status").notNull(), // OK, WARN, ERROR
  latencyMs: integer("latency_ms").notNull().default(0),
  details: text("details"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const oiSnapshots = pgTable("oi_snapshots", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  oi: doublePrecision("oi").notNull(),
  oiCcy: doublePrecision("oi_ccy").notNull().default(0),
  timestamp: timestamp("timestamp").notNull(),
  regime: text("regime").notNull().default("NEUTRAL_CONSOLIDATION"),
  liquidationGravityScore: doublePrecision("liquidation_gravity_score").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const aiAnalyses = pgTable("ai_analyses", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(), // signal_today, combo_audit, edge_critic, regime_playbook, postmortem, risk_gate, hypothesis_writer
  title: text("title").notNull(),
  content: text("content").notNull(),
  provider: text("provider").notNull().default("glassbox-local"), // nvidia-nim | openai-compat | glassbox-local
  model: text("model"),
  contextJson: jsonb("context_json"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const aiProviderSettings = pgTable("ai_provider_settings", {
  id: serial("id").primaryKey(),
  profile: text("profile").notNull().default("default").unique(),
  providerOrder: text("provider_order").notNull().default("nvidia,opencode,gpt4free"),
  enabled: text("enabled").notNull().default("nvidia,opencode,gpt4free"),
  configs: jsonb("configs").notNull().default({}),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const signalFilters = pgTable("signal_filters", {
  id: serial("id").primaryKey(),
  profile: text("profile").notNull().default("default").unique(),
  minEvs: integer("min_evs").notNull().default(30),
  minCategories: integer("min_categories").notNull().default(2),
  operators: text("operators").notNull().default("WEIGHTED,AND,OR,VETO"),
  directions: text("directions").notNull().default("UP,DOWN,NEUTRAL"),
  regimeLock: text("regime_lock").notNull().default("ANY"),
  excludedCategories: text("excluded_categories").notNull().default(""),
  maxHypothesesPerCycle: integer("max_hypotheses_per_cycle").notNull().default(40),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * SHADOW-КНИГА РЕШЕНИЙ (H003, протокол итерации 2).
 * Каждый предложенный планировщику кандидат логируется ВСЕГДА — выбран он или нет,
 * с propensity (вероятностью выбора softmax-политикой) и обеими руками (ai и rule).
 * Через 15 минут кандидаты разрешаются по той же физике, что боевые прогнозы.
 * Это даёт: (1) paired-сравнение политик на одних циклах; (2) off-policy оценку
 * (SNIPS/Δ-OPE) альтернативных политик БЕЗ исполнения; (3) счётчик испытаний
 * для Deflated Sharpe — trials считаются по offered, а не по selected.
 * Без logged propensity альтернативная политика неоценива [S166,S167].
 */
export const shadowDecisions = pgTable("shadow_decisions", {
  id: serial("id").primaryKey(),
  cycleAt: timestamp("cycle_at").notNull(),
  resolveAt: timestamp("resolve_at").notNull(),
  code: text("code").notNull(),
  asset: text("asset").notNull(),
  signature: text("signature").notNull(),
  direction: text("direction").notNull(),
  evs: doublePrecision("evs").notNull().default(0),
  regime: text("regime").notNull().default("NEUTRAL_CONSOLIDATION"),
  /** Вероятность выбора этого кандидата стохастической политикой (softmax, T=8) */
  propensityAi: doublePrecision("propensity_ai").notNull().default(0),
  /** Фактический выбор боевой руки ai/fallback */
  chosenAi: boolean("chosen_ai").notNull().default(false),
  /** Что выбрало бы детерминированное правило на том же списке (вторая рука) */
  chosenRule: boolean("chosen_rule").notNull().default(false),
  entryPrice: doublePrecision("entry_price").notNull().default(0),
  status: text("status").notNull().default("pending"), // pending | resolved | expired
  outcome: text("outcome"), // hit | miss | ambiguous | expired
  mfePct: doublePrecision("mfe_pct"),
  realizedReturnNetPct: doublePrecision("realized_return_net_pct"),
  resolvedPrice: doublePrecision("resolved_price"),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Кто принимает решение об отборе гипотез. Фильтры выше — это вето человека
 * (что вообще допустимо), эта таблица — кому принадлежит сам выбор: модели или
 * детерминированному правилу. ceiling — страховка от потока записей, а не цель.
 */
export const selectionPolicy = pgTable("selection_policy", {
  id: serial("id").primaryKey(),
  profile: text("profile").notNull().default("default").unique(),
  /** "ai" — решение за моделью, "rule" — детерминированное EVS-правило */
  authority: text("authority").notNull().default("ai"),
  ceiling: integer("ceiling").notNull().default(12),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
