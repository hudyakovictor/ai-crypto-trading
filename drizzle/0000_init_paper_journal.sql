CREATE TABLE "ai_analyses" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"provider" text DEFAULT 'glassbox-local' NOT NULL,
	"model" text,
	"context_json" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_provider_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile" text DEFAULT 'default' NOT NULL,
	"provider_order" text DEFAULT 'nvidia,opencode,gpt4free' NOT NULL,
	"enabled" text DEFAULT 'nvidia,opencode,gpt4free' NOT NULL,
	"configs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_settings_profile_unique" UNIQUE("profile")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"base_asset" text NOT NULL,
	"quote_asset" text NOT NULL,
	"exchange" text DEFAULT 'OKX' NOT NULL,
	"last_price" double precision DEFAULT 0 NOT NULL,
	"price_change_24h" double precision DEFAULT 0 NOT NULL,
	"volume_24h" double precision DEFAULT 0 NOT NULL,
	"high_24h" double precision DEFAULT 0 NOT NULL,
	"low_24h" double precision DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_fetched_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "assets_symbol_unique" UNIQUE("symbol")
);
--> statement-breakpoint
CREATE TABLE "candles" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text DEFAULT '15m' NOT NULL,
	"timestamp" timestamp NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" double precision NOT NULL,
	"vol_ccy" double precision DEFAULT 0 NOT NULL,
	"confirmed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "combinations" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"expression" text NOT NULL,
	"categories_json" jsonb NOT NULL,
	"parameters_json" jsonb NOT NULL,
	"early_value_score" double precision DEFAULT 0 NOT NULL,
	"novelty_score" double precision DEFAULT 0 NOT NULL,
	"cross_agreement_score" double precision DEFAULT 0 NOT NULL,
	"historical_support_score" double precision DEFAULT 0 NOT NULL,
	"stability_score" double precision DEFAULT 0 NOT NULL,
	"liquidity_score" double precision DEFAULT 0 NOT NULL,
	"data_quality_score" double precision DEFAULT 0 NOT NULL,
	"testability_score" double precision DEFAULT 0 NOT NULL,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"failure_patterns_json" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "combinations_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "data_quality_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text DEFAULT 'OKX-REST' NOT NULL,
	"metric_type" text NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"details" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_type" text NOT NULL,
	"total_signals_processed" integer DEFAULT 0 NOT NULL,
	"combinations_generated" integer DEFAULT 0 NOT NULL,
	"hypotheses_created" integer DEFAULT 0 NOT NULL,
	"forecasts_resolved" integer DEFAULT 0 NOT NULL,
	"learning_updates_count" integer DEFAULT 0 NOT NULL,
	"regime_detected" text DEFAULT 'NEUTRAL_CONSOLIDATION' NOT NULL,
	"log_summary" text NOT NULL,
	"metrics_json" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forecasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"hypothesis_id" integer,
	"asset" text NOT NULL,
	"direction" text NOT NULL,
	"horizon_minutes" integer DEFAULT 15 NOT NULL,
	"fixed_at" timestamp DEFAULT now() NOT NULL,
	"resolve_at" timestamp NOT NULL,
	"entry_price" double precision NOT NULL,
	"expected_min_price" double precision NOT NULL,
	"expected_max_price" double precision NOT NULL,
	"target_condition" text NOT NULL,
	"invalidation_condition" text NOT NULL,
	"costs_bps" double precision DEFAULT 8 NOT NULL,
	"slippage_bps" double precision DEFAULT 3 NOT NULL,
	"funding_drag_bps" double precision DEFAULT 1 NOT NULL,
	"checksum" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome" text,
	"resolved_price" double precision,
	"mfe" double precision,
	"mae" double precision,
	"realized_return_net" double precision,
	"error_type" text,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hypotheses" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"asset" text NOT NULL,
	"venue" text DEFAULT 'OKX' NOT NULL,
	"timeframe" text DEFAULT '15m' NOT NULL,
	"direction" text NOT NULL,
	"horizon_minutes" integer DEFAULT 15 NOT NULL,
	"entry_price" double precision NOT NULL,
	"target_price" double precision NOT NULL,
	"invalidation_price" double precision NOT NULL,
	"expected_mechanism" text NOT NULL,
	"categories_json" jsonb NOT NULL,
	"exact_formula" text NOT NULL,
	"parameter_set_id" text DEFAULT 'v1.0.0' NOT NULL,
	"data_version" text DEFAULT 'okx-v5-live' NOT NULL,
	"score_components_json" jsonb NOT NULL,
	"uncertainty" double precision DEFAULT 0.35 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "hypotheses_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "learning_weights" (
	"id" serial PRIMARY KEY NOT NULL,
	"category_name" text NOT NULL,
	"current_weight" double precision DEFAULT 1 NOT NULL,
	"prior_weight" double precision DEFAULT 1 NOT NULL,
	"total_samples" integer DEFAULT 0 NOT NULL,
	"total_hits" integer DEFAULT 0 NOT NULL,
	"total_misses" integer DEFAULT 0 NOT NULL,
	"empirical_winrate" double precision DEFAULT 0.5 NOT NULL,
	"brier_score" double precision DEFAULT 0.25 NOT NULL,
	"regime_performance_json" jsonb,
	"last_updated" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "learning_weights_category_name_unique" UNIQUE("category_name")
);
--> statement-breakpoint
CREATE TABLE "oi_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"oi" double precision NOT NULL,
	"oi_ccy" double precision DEFAULT 0 NOT NULL,
	"timestamp" timestamp NOT NULL,
	"regime" text DEFAULT 'NEUTRAL_CONSOLIDATION' NOT NULL,
	"liquidation_gravity_score" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "selection_policy" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile" text DEFAULT 'default' NOT NULL,
	"authority" text DEFAULT 'ai' NOT NULL,
	"ceiling" integer DEFAULT 12 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "selection_policy_profile_unique" UNIQUE("profile")
);
--> statement-breakpoint
CREATE TABLE "signal_features" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"category" text NOT NULL,
	"primitive_name" text NOT NULL,
	"raw_value" double precision NOT NULL,
	"normalized_score" double precision NOT NULL,
	"direction" text NOT NULL,
	"confidence" double precision DEFAULT 0.5 NOT NULL,
	"missingness" double precision DEFAULT 0 NOT NULL,
	"support_count" integer DEFAULT 100 NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"metadata_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "signal_filters" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile" text DEFAULT 'default' NOT NULL,
	"min_evs" integer DEFAULT 30 NOT NULL,
	"min_categories" integer DEFAULT 2 NOT NULL,
	"operators" text DEFAULT 'WEIGHTED,AND,OR,VETO' NOT NULL,
	"directions" text DEFAULT 'UP,DOWN,NEUTRAL' NOT NULL,
	"regime_lock" text DEFAULT 'ANY' NOT NULL,
	"excluded_categories" text DEFAULT '' NOT NULL,
	"max_hypotheses_per_cycle" integer DEFAULT 40 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "signal_filters_profile_unique" UNIQUE("profile")
);
--> statement-breakpoint
CREATE INDEX "idx_ai_analyses_kind_created" ON "ai_analyses" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_analyses_created" ON "ai_analyses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_candles_symbol_tf_ts" ON "candles" USING btree ("symbol","timeframe","timestamp");--> statement-breakpoint
CREATE INDEX "idx_combinations_status_created" ON "combinations" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_combinations_created" ON "combinations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_data_quality_logs_created" ON "data_quality_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_experiment_runs_created" ON "experiment_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_experiment_runs_type_created" ON "experiment_runs" USING btree ("run_type","created_at");--> statement-breakpoint
CREATE INDEX "idx_forecasts_status_resolve_at" ON "forecasts" USING btree ("status","resolve_at");--> statement-breakpoint
CREATE INDEX "idx_forecasts_status_outcome" ON "forecasts" USING btree ("status","outcome");--> statement-breakpoint
CREATE INDEX "idx_forecasts_hypothesis_id" ON "forecasts" USING btree ("hypothesis_id");--> statement-breakpoint
CREATE INDEX "idx_forecasts_created" ON "forecasts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_hypotheses_status_created" ON "hypotheses" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_hypotheses_asset_created" ON "hypotheses" USING btree ("asset","created_at");--> statement-breakpoint
CREATE INDEX "idx_oi_snapshots_symbol_ts" ON "oi_snapshots" USING btree ("symbol","timestamp");--> statement-breakpoint
CREATE INDEX "idx_signal_features_symbol_ts" ON "signal_features" USING btree ("symbol","timestamp");--> statement-breakpoint
CREATE INDEX "idx_signal_features_category_ts" ON "signal_features" USING btree ("category","timestamp");