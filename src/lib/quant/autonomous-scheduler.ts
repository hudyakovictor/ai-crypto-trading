import { db } from "@/db";
import {
  assets,
  candles as candlesTable,
  signalFeatures,
  combinations as combinationsTable,
  hypotheses as hypothesesTable,
  forecasts as forecastsTable,
  experimentRuns,
  dataQualityLogs,
} from "@/db/schema";
import { eq, lte, and, inArray } from "drizzle-orm";
import { okxClient } from "../okx/okx-client";
import { featureEngine } from "./feature-engine";
import { combinationEngine } from "./combination-engine";
import { hypothesisEngine } from "./hypothesis-engine";
import { outcomeEvaluator } from "./outcome-evaluator";
import { learningLoop } from "./learning-loop";
import { CategoryKey, MarketRegime, NormalizedSignal, OKXCandle } from "../types";
import {
  ALL_DIRECTIONS,
  ALL_OPERATORS,
  comboPasses,
  loadFilters,
  type FilterState,
} from "../filters";
import {
  UNIVERSE_ANCHOR,
  UNIVERSE_CONFIG,
  fetchSeries,
  mapLimited,
  passesFloor,
  scanUniverse,
  type UniverseMember,
  type UniverseRole,
} from "./universe";
import { loadPolicy } from "./policy";
import {
  buildShortlist,
  computeMoveStats,
  loadModelFacts,
  loadSelectionRecord,
  loadSignatureHistory,
  loadWeightViews,
  planCycle,
  rulePick,
  signatureFromHypothesis,
  type AssetMoveStats,
  type PoolItem,
} from "./planner";
import { computeOpeReport, logCycleDecisions, resolveShadowDecisions } from "./shadow-book";
import { runEnsemble, type EnsembleVote } from "../ai/ensemble";
import type { PlannerDecisionRow } from "../ui-types";

export interface CycleResult {
  timestamp: string;
  isLiveOKX: boolean;
  latencyMs: number;
  trackedCount: number;
  universe: UniverseMember[];
  marketRegime: MarketRegime;
  combinationsGenerated: number;
  hypothesesCreated: number;
  forecastsResolved: number;
  learningUpdated: boolean;
  summary: string;
  /** Кто на этом цикле решил «сколько гипотез и какие»: модель, правило или запас */
  planner: PlannerDecisionRow | null;
}

export class AutonomousScheduler {
  private isRunning = false;
  private lastRunTime: Date | null = null;
  private nextRunTime: Date | null = null;
  private intervalMinutes = 15;
  /** Номер цикла — детерминированное «семя» для exploration-слотов */
  private cycleIndex = 0;
  /** Последняя выбранная вселенная: UI показывает состав и обоснование отбора */
  private lastUniverse: UniverseMember[] = [];
  /** Последнее решение об отборе: кем оно принято и что именно взято */
  private lastPlannerDecision: PlannerDecisionRow | null = null;

  getUniverse(): UniverseMember[] {
    return this.lastUniverse;
  }

  getPlannerDecision(): PlannerDecisionRow | null {
    return this.lastPlannerDecision;
  }

  getLastRunTime(): Date | null {
    return this.lastRunTime;
  }

  getNextRunTime(): Date | null {
    if (!this.lastRunTime) {
      return new Date(Date.now() + 15 * 60 * 1000);
    }
    return new Date(this.lastRunTime.getTime() + this.intervalMinutes * 60 * 1000);
  }

  /**
   * Run one full autonomous quant research cycle.
   */
  async runCycle(isManualTrigger = false): Promise<CycleResult> {
    if (this.isRunning) {
      return {
        timestamp: new Date().toISOString(),
        isLiveOKX: true,
        latencyMs: 0,
        trackedCount: 0,
        universe: this.lastUniverse,
        marketRegime: "NEUTRAL_CONSOLIDATION",
        combinationsGenerated: 0,
        hypothesesCreated: 0,
        forecastsResolved: 0,
        learningUpdated: false,
        summary: "Cycle already in progress. Skipping concurrent run.",
        planner: this.lastPlannerDecision,
      };
    }

    this.isRunning = true;
    const cycleStartTime = Date.now();

    try {
      await learningLoop.ensureInitialized();

      // Step 1: Динамическая вселенная — система сама выбирает пары
      const scan = await scanUniverse(UNIVERSE_CONFIG, this.cycleIndex);
      const { tickers, tickersLive: isLiveTickers, tickersLatencyMs: scanLatencyMs, universe, series } = scan;
      this.cycleIndex += 1;

      const candlesMap = new Map<string, OKXCandle[]>();
      for (const [sym, bundle] of series) candlesMap.set(sym, bundle.candles);
      let btcCandles = candlesMap.get(UNIVERSE_ANCHOR) ?? [];

      // Свечи нужны и для активов, которые уже вышли из вселенной, но ещё имеют
      // незакрытые прогнозы: иначе ротация состава ломала бы учёт исходов.
      const pendingForResolution = await db
        .select()
        .from(forecastsTable)
        .where(eq(forecastsTable.status, "pending"));
      const missingSymbols = [
        ...new Set(pendingForResolution.map((f) => f.asset).filter((a) => !candlesMap.has(a))),
      ].slice(0, 12);
      if (missingSymbols.length > 0) {
        const extra = await fetchSeries(missingSymbols, "15m", 24);
        for (const [sym, bundle] of extra) candlesMap.set(sym, bundle.candles);
      }

      // Step 2: В реестр попадают только участники вселенной (плюс якорь),
      // а не все ~1000 USDT-пар — иначе статусный экран разрастается мусором.
      const registrySymbols = [...new Set([...universe.map((u) => u.symbol), UNIVERSE_ANCHOR])];
      for (const sym of registrySymbols) {
        const t = tickers.find((x) => x.instId === sym);
        if (!t) continue;
        const [base, quote] = t.instId.split("-");
        const change24h = t.open24h > 0 ? ((t.last - t.open24h) / t.open24h) * 100 : 0;

        const existing = await db.select().from(assets).where(eq(assets.symbol, t.instId)).limit(1);
        if (existing.length > 0) {
          await db
            .update(assets)
            .set({
              lastPrice: t.last,
              priceChange24h: change24h,
              volume24h: t.vol24h,
              high24h: t.high24h,
              low24h: t.low24h,
              isActive: true,
              lastFetchedAt: new Date(),
            })
            .where(eq(assets.symbol, t.instId));
        } else {
          await db.insert(assets).values({
            symbol: t.instId,
            baseAsset: base || "CRYPTO",
            quoteAsset: quote || "USDT",
            exchange: "OKX",
            lastPrice: t.last,
            priceChange24h: change24h,
            volume24h: t.vol24h,
            high24h: t.high24h,
            low24h: t.low24h,
            isActive: true,
            lastFetchedAt: new Date(),
          });
        }
      }

      // История свечей: по 3 последние свечи на участника вселенной
      for (const member of universe) {
        for (const c of (candlesMap.get(member.symbol) ?? []).slice(-3)) {
          const cDate = new Date(c.timestamp);
          const existing = await db
            .select()
            .from(candlesTable)
            .where(and(eq(candlesTable.symbol, member.symbol), eq(candlesTable.timestamp, cDate)))
            .limit(1);

          if (existing.length === 0) {
            await db.insert(candlesTable).values({
              symbol: member.symbol,
              timeframe: "15m",
              timestamp: cDate,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
              volCcy: c.volCcy,
              confirmed: true,
            });
          }
        }
      }

      // Step 2.5: Shadow-книга (H003) — разрешить созревшие теневые решения
      // до боевого разбора: их исходы кормят Δ-OPE и гейт доверия.
      const shadowResolved = await resolveShadowDecisions(
        candlesMap,
        (asset) => tickers.find((t) => t.instId === asset)?.last
      ).catch(() => 0);

      // Step 3: Check and Resolve Due Forecasts
      const pendingForecasts = await db
        .select()
        .from(forecastsTable)
        .where(eq(forecastsTable.status, "pending"));

      const now = new Date();
      const resolvedEventsForLearning: {
        categories: string[];
        outcome: "hit" | "miss" | "ambiguous" | "expired";
        realizedReturn: number;
        regime?: string;
        statedProb?: number;
      }[] = [];

      let resolvedCount = 0;

      for (const fc of pendingForecasts) {
        // Resolve if past resolution time or if manual trigger testing
        const isPastHorizon = new Date(fc.resolveAt) <= now;
        if (isPastHorizon) {
          const symCandles = candlesMap.get(fc.asset) || [];
          const currentPrice = tickers.find((t) => t.instId === fc.asset)?.last || fc.entryPrice;

          const resolution = outcomeEvaluator.evaluate(fc, currentPrice, symCandles);

          await db
            .update(forecastsTable)
            .set({
              status: "resolved",
              outcome: resolution.outcome,
              resolvedPrice: resolution.resolvedPrice,
              mfe: resolution.mfe,
              mae: resolution.mae,
              realizedReturnNet: resolution.realizedReturnNet,
              errorType: resolution.errorType,
              resolvedAt: resolution.resolvedAt,
            })
            .where(eq(forecastsTable.id, fc.id));

          resolvedCount++;

          // Look up corresponding hypothesis categories
          if (fc.hypothesisId) {
            const hyp = await db
              .select()
              .from(hypothesesTable)
              .where(eq(hypothesesTable.id, fc.hypothesisId))
              .limit(1);

            if (hyp.length > 0 && Array.isArray(hyp[0].categoriesJson)) {
              // H002/H005: обучение несёт ЗАЯВЛЕННУЮ вероятность (planner conviction)
              // и режим на момент решения — апостериоры режимов и честный Brier.
              const plannerMeta = (hyp[0].scoreComponentsJson as {
                planner?: { conviction?: number; regimeAtCreation?: string };
              } | null)?.planner;
              resolvedEventsForLearning.push({
                categories: hyp[0].categoriesJson as string[],
                outcome: resolution.outcome,
                realizedReturn: resolution.realizedReturnNet,
                regime: plannerMeta?.regimeAtCreation,
                statedProb: plannerMeta?.conviction ?? (1 - (hyp[0].uncertainty ?? 0.35)),
              });

              // Update hypothesis status
              await db
                .update(hypothesesTable)
                .set({
                  status: resolution.outcome === "hit" ? "fulfilled" : "invalidated",
                })
                .where(eq(hypothesesTable.id, fc.hypothesisId));
            }
          }
        }
      }

      // Step 4: Online Learning - Update weights in Postgres based on accumulated outcomes
      let learningUpdated = false;
      if (resolvedEventsForLearning.length > 0) {
        await learningLoop.updateFromOutcomes(resolvedEventsForLearning);
        learningUpdated = true;
      }

      // Step 5: Get Current Learned Weights
      // Веса запрашиваются ПОСЛЕ обучения этого цикла (изменения сразу в деле).
      // H005: пул строится на regime-специфичных весах — для каждого режима,
      // встретившегося в studies, отдельная карта; fallback — глобальная.
      const currentWeights = await learningLoop.getWeightsMap();

      // Step 6: Market Regime Detection (via FeatureEngine output, see Step 7)

      // Step 7: 15 категорий сигналов — по КАЖДОМУ активу выбранной вселенной.
      // Breadth считаем по исполнимым парам (пол ликвидности), а не по всем
      // ~1000 листингов: иначе «ширина рынка» тонет в мёртвых инструментах.
      const floorTickers = tickers.filter((t) => passesFloor(t, UNIVERSE_CONFIG));
      const breadthSet = floorTickers.slice(0, 150);
      const allTickersPerf = breadthSet.map((t) => ({
        symbol: t.instId,
        change24h: t.open24h > 0 ? ((t.last - t.open24h) / t.open24h) * 100 : 0,
        volume: t.vol24h,
      }));

      const studies = await mapLimited(universe, 4, async (member) => {
        const sym = member.symbol;
        const candles = candlesMap.get(sym) ?? [];
        const [bookRes, fundingRes, oiRes] = await Promise.all([
          okxClient.getOrderBook(sym, 20),
          okxClient.getFundingRate(sym),
          okxClient.getOpenInterest(sym),
        ]);

        const feOut = featureEngine.calculate15Categories({
          symbol: sym,
          candles,
          book: bookRes.book,
          funding: fundingRes.funding,
          oi: oiRes.oi,
          btcCandles,
          allTickersPerformance: allTickersPerf,
        });

        return {
          symbol: sym,
          role: member.role,
          signals: feOut.signals,
          regime: feOut.regime,
          dataQualityScore: feOut.dataQualityScore,
          // Живые ли именно свечи этого актива: синтетика не должна участвовать
          // в отборе гипотез, даже если остальной рынок читается нормально.
          dataLive: member.dataLive && candles.length >= UNIVERSE_CONFIG.minCandles,
        };
      });

      // Снапшоты сигналов одним батчем: 15 категорий × N активов
      const featureRows = studies.flatMap((st) =>
        Object.entries(st.signals).map(([catKey, sig]) => ({
          symbol: st.symbol,
          category: catKey,
          primitiveName: (sig as NormalizedSignal).primitiveName,
          rawValue: (sig as NormalizedSignal).rawValue,
          normalizedScore: (sig as NormalizedSignal).normalizedScore,
          direction: (sig as NormalizedSignal).direction,
          confidence: (sig as NormalizedSignal).confidence,
          missingness: (sig as NormalizedSignal).missingness,
          supportCount: (sig as NormalizedSignal).supportCount,
          timestamp: new Date(),
          metadataJson: (sig as NormalizedSignal).metadata || {},
        }))
      );
      if (featureRows.length > 0) await db.insert(signalFeatures).values(featureRows);

      const anchorStudy = studies.find((s) => s.symbol === UNIVERSE_ANCHOR) ?? studies[0];
      const detectedRegime: MarketRegime = anchorStudy?.regime ?? "NEUTRAL_CONSOLIDATION";
      const signals15: Record<CategoryKey, NormalizedSignal> = anchorStudy?.signals ?? ({} as never);
      this.lastUniverse = universe;

      // Step 8: Комбинаторная разведка — 100 вариаций НА АКТИВ.
      // раньше 100 связок строились только по BTC; теперь пул объединяет
      // вариации всех участников вселенной, а ранжирование идёт по EVS.
      const weightsByRegime = new Map<string, Record<string, number>>([["__global", currentWeights]]);
      for (const reg of [...new Set(studies.map((st) => st.regime))]) {
        if (!weightsByRegime.has(reg)) {
          weightsByRegime.set(reg, await learningLoop.getWeightsMap(reg).catch(() => currentWeights));
        }
      }
      const pool = studies.flatMap((st) =>
        combinationEngine
          .generate100Combinations(
            st.symbol,
            st.signals,
            st.regime,
            weightsByRegime.get(st.regime) ?? currentWeights,
            isLiveTickers ? st.dataQualityScore : 7.5
          )
          .map((c) => ({ ...c, asset: st.symbol, assetLive: st.dataLive, assetRegime: st.regime }))
      );
      pool.sort((a, b) => b.earlyValueScore - a.earlyValueScore);

      // В аудит идут топ-25 пула целиком (а не топ-25 одного актива)
      for (const combo of pool.slice(0, 25)) {
        const existing = await db
          .select()
          .from(combinationsTable)
          .where(eq(combinationsTable.code, combo.code))
          .limit(1);

        if (existing.length === 0) {
          await db.insert(combinationsTable).values({
            code: combo.code,
            name: combo.name,
            expression: combo.expression,
            categoriesJson: combo.categories,
            // asset в parametersJson: колонок в схеме не добавляем, но актив
            // становится восстанавливаемым из любой выборки комбинаций
            parametersJson: { ...combo.parameters, asset: combo.asset },
            earlyValueScore: combo.earlyValueScore,
            noveltyScore: combo.breakdown.novelty,
            crossAgreementScore: combo.breakdown.crossAgreement,
            historicalSupportScore: combo.breakdown.historicalSupport,
            stabilityScore: combo.breakdown.effectStability,
            liquidityScore: combo.breakdown.coverageLiquidity,
            dataQualityScore: combo.breakdown.dataQuality,
            testabilityScore: combo.breakdown.testability,
            sampleSize: combo.sampleSize,
            status: combo.status,
            createdAt: new Date(),
          });
        }
      }

      // Step 9: Отбор гипотез — решение принимает модель, а не ползунок.
      // Вето человека остаётся (что вообще допустимо: порог EVS, операторы,
      // направления, исключённые категории), но «СКОЛЬКО и КАКИЕ» больше не
      // квота: на бумажном исполнении объём ставок ничего не приносит, а шумная
      // гипотеза стоит калибровке весов и памяти лаборатории.
      const policy = await loadPolicy();
      let filters: FilterState = {
        minEvs: 30,
        minCategories: 2,
        maxHypothesesPerCycle: 40,
        operators: ALL_OPERATORS,
        directions: ALL_DIRECTIONS,
        regimeLock: "ANY",
        excludedCategories: [],
      };
      try {
        filters = await loadFilters();
      } catch {
        /* демо-режим без БД фильтров — берём дефолты */
      }

      // Физика, а не вкус: только активы с живыми свечами и только связки с
      // тестируемым направлением. Повторно не предлагаем то, что уже стоит
      // неразрешённым прогнозом с той же подписью.
      const eligible = pool.filter((c) => c.assetLive && comboPasses(filters, c));
      const poolByCode = new Map<string, PoolItem>(eligible.map((c) => [c.code, c as PoolItem]));

      const pendingHypIds = [
        ...new Set(pendingForecasts.map((f) => f.hypothesisId).filter((x): x is number => typeof x === "number")),
      ];
      const excludeSignatures = new Set<string>();
      if (pendingHypIds.length > 0) {
        const rows = await db
          .select({
            asset: hypothesesTable.asset,
            categoriesJson: hypothesesTable.categoriesJson,
            direction: hypothesesTable.direction,
            parameterSetId: hypothesesTable.parameterSetId,
          })
          .from(hypothesesTable)
          .where(inArray(hypothesesTable.id, pendingHypIds));
        for (const h of rows) excludeSignatures.add(signatureFromHypothesis(h));
      }

      const [history, record, weightViews, facts] = await Promise.all([
        loadSignatureHistory(),
        loadSelectionRecord(),
        loadWeightViews(),
        loadModelFacts(pendingForecasts.length),
      ]);

      // Список для решающего держим коротким: 20 строк — это ~4–20 с ответа на
      // доступной модели, 30 строк уже упирались в таймаут и уходили в запасной порядок.
      // Кандидат без цифры «достижим ли бар исхода на этом активе» решал бы вслепую,
      // поэтому волатильность актива считается из свечей заранее.
      const moveStats = new Map<string, AssetMoveStats>();
      for (const [sym, candles] of candlesMap) {
        const stats = computeMoveStats(candles);
        if (stats) moveStats.set(sym, stats);
      }

      const candidates = buildShortlist(eligible, {
        perAsset: 2,
        total: 20,
        excludeSignatures,
        history,
        moveStats,
      });

      const universeNote = universe
        .map((u) => `${u.symbol} [${u.role === "core" ? "ядро" : "разведка"}] — ${u.reason}`)
        .join("; ");

      // H001: ансамбль асимметричных срезов — параллельно, с собственным бюджетом,
      // fail-tolerant: пустая карта не меняет поведение планировщика.
      const ensembleStart = Date.now();
      const ensemble: Map<string, EnsembleVote> = await runEnsemble(candidates).catch(
        () => new Map<string, EnsembleVote>()
      );
      const ensembleMs = Date.now() - ensembleStart;

      const decision = await planCycle({
        candidates,
        policy,
        facts,
        weightsTop: weightViews.weightsTop,
        weightsLow: weightViews.weightsLow,
        record,
        universeNote,
        ensemble,
      });
      this.lastPlannerDecision = decision;

      // H003: shadow-книга. Логируем ВСЕХ предложенных кандидатов и ОБЕ руки:
      // боевой выбор (ai/fallback) и выбор правила на тех же кандидатах — даже
      // когда режим боевой руки «rule» (тогда chosenAi=chosenRule, это корректно:
      // рука определяется тем, КТО решал). Propensity — softmax по value (T=8),
      // детерминированной политики здесь нет: IPS должен оставаться оцениваемым.
      const shadowCycleAt = new Date();
      const shadowResolveAt = new Date(shadowCycleAt.getTime() + 15 * 60 * 1000);
      const rulePicksForShadow = decision.mode === "rule" ? decision.picks : rulePick(candidates, policy.ceiling);
      const entryPrices = new Map<string, number>();
      for (const c of candidates) {
        if (entryPrices.has(c.asset)) continue;
        const t = tickers.find((x) => x.instId === c.asset);
        const cs = candlesMap.get(c.asset) ?? [];
        const px = t?.last || (cs.length ? cs[cs.length - 1].close : 0);
        if (px > 0) entryPrices.set(c.asset, px);
      }
      const shadowLogged = await logCycleDecisions({
        candidates,
        decision,
        rulePicks: rulePicksForShadow,
        entryPrices,
        cycleAt: shadowCycleAt,
        resolveAt: shadowResolveAt,
      }).catch(() => 0);

      let hypothesesCreated = 0;

      for (const pick of decision.picks) {
        const candidate = poolByCode.get(pick.code);
        if (!candidate) continue; // код вне предложенного списка — не должен был пройти валидацию

        const assetTicker = tickers.find((t) => t.instId === candidate.asset);
        const assetCandles = candlesMap.get(candidate.asset) ?? [];
        const currentPrice =
          assetTicker?.last || (assetCandles.length > 0 ? assetCandles[assetCandles.length - 1].close : 0);
        if (currentPrice <= 0) continue;

        const { hypothesis, forecast } = hypothesisEngine.createHypothesis(
          candidate,
          candidate.asset,
          currentPrice,
          15 // 15-minute horizon
        );

        // Уверенность решившего становится ставкой: гипотеза несёт её как
        // uncertainty, а калиброчный Brier-механизм проверяет, не соврала ли модель.
        const uncertainty = Math.max(0.1, Math.min(0.6, 1 - pick.conviction));

        const [createdHyp] = await db
          .insert(hypothesesTable)
          .values({
            code: hypothesis.code,
            asset: hypothesis.asset,
            venue: hypothesis.venue,
            timeframe: hypothesis.timeframe,
            direction: hypothesis.direction,
            horizonMinutes: hypothesis.horizonMinutes,
            entryPrice: hypothesis.entryPrice,
            targetPrice: hypothesis.targetPrice,
            invalidationPrice: hypothesis.invalidationPrice,
            expectedMechanism: `${hypothesis.expectedMechanism} | отбор (${decision.mode}): ${pick.why}`,
            categoriesJson: hypothesis.categories,
            exactFormula: hypothesis.exactFormula,
            parameterSetId: hypothesis.parameterSetId,
            dataVersion: hypothesis.dataVersion,
            scoreComponentsJson: {
              ...hypothesis.scoreComponents,
              // провенанс решения: чем выбрано и кем — по этому же полю считается
              // отдельная статистика «ИИ vs правило»
              planner: {
                mode: decision.mode,
                authority: decision.authority,
                provider: decision.provider,
                model: decision.model,
                conviction: pick.conviction,
                why: pick.why,
                // H005: режим на момент решения — ключ апостериоров и paired-сравнения
                regimeAtCreation: candidate.assetRegime,
              },
            },
            uncertainty,
            status: "active",
            createdAt: new Date(),
          })
          .returning({ id: hypothesesTable.id });

        await db.insert(forecastsTable).values({
          hypothesisId: createdHyp ? createdHyp.id : null,
          asset: forecast.asset,
          direction: forecast.direction,
          horizonMinutes: forecast.horizonMinutes,
          fixedAt: forecast.fixedAt,
          resolveAt: forecast.resolveAt,
          entryPrice: forecast.entryPrice,
          expectedMinPrice: forecast.expectedMinPrice,
          expectedMaxPrice: forecast.expectedMaxPrice,
          targetCondition: forecast.targetCondition,
          invalidationCondition: forecast.invalidationCondition,
          costsBps: forecast.costsBps,
          slippageBps: forecast.slippageBps,
          fundingDragBps: forecast.fundingDragBps,
          checksum: forecast.checksum,
          status: "pending",
          createdAt: new Date(),
        });

        hypothesesCreated++;
      }

      // Step 10: Quality metrics — честно про то, сколько активов потеряли
      const droppedSymbols = universe.filter((u) => !u.dataLive).map((u) => u.symbol);
      const latencyMs = scanLatencyMs;
      const cycleMs = Date.now() - cycleStartTime;
      // Масштаб отбора для UI: из скольких листингов и скольких исполнимых пар
      // выбрана вселенная. Без этой цифры «система сама выбрала» звучит как магия.
      const listedCount = tickers.length;
      const floorCount = floorTickers.length;

      await db.insert(dataQualityLogs).values({
        source: isLiveTickers ? "OKX-REST-LIVE" : "OKX-SYNTHETIC-FALLBACK",
        metricType: decision.mode === "fallback" ? "ai-unavailable" : droppedSymbols.length > 0 ? "stale" : "latency",
        status:
          decision.mode === "fallback" || !isLiveTickers || droppedSymbols.length > 0
            ? "WARN"
            : latencyMs < 1500
              ? "OK"
              : "WARN",
        latencyMs,
        details: [
          `Листингов USDT: ${listedCount}, исполнимых: ${floorCount}, свечных серий: ${candlesMap.size}, вселенная: ${universe.length}.`,
          `Латентность тикеров: ${latencyMs}ms, цикл: ${cycleMs}ms.`,
          droppedSymbols.length > 0
            ? `Без живых данных (гипотезы по ним не строились): ${droppedSymbols.join(", ")}`
            : "",
          // Если решил запасной порядок — это отдельный факт качества, его нельзя прятать
          decision.mode === "fallback"
            ? `Отбор гипотез ушёл на запасной EVS-порядок: ${decision.error ?? "модель не ответила"}`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        createdAt: new Date(),
      });

      // Step 11: Log Experiment Record — состав вселенной сохраняется как история
      // отбора: по нему UI объясняет, почему актив здесь, и можно аудировать ротацию.
      const decidedBy =
        decision.mode === "ai"
          ? `ИИ (${decision.model ?? decision.provider ?? "модель"})`
          : decision.mode === "rule"
            ? "правило EVS"
            : "запасное правило (ИИ недоступен)";

      // Δ-OPE отчёт по накопленной shadow-книге (H003) — разности политик,
      // не абсолютные значения; публикуется только при гейте доверия ESS/maxW.
      const ope = await computeOpeReport().catch(() => null);
      const summaryText = `Цикл: вселенная ${universe.length} активов (ядро ${
        universe.filter((u) => u.role === "core").length
      }, разведка ${universe.filter((u) => u.role === "explore").length}), режим ${detectedRegime}, связок ${
        pool.length
      }, кандидатов ${decision.offered}, решил ${decidedBy} → гипотез ${hypothesesCreated}, решено ${resolvedCount}, обучение обновлено: ${learningUpdated}.`;

      await db.insert(experimentRuns).values({
        runType: isManualTrigger ? "manual_trigger_15m" : "scheduled_15m",
        totalSignalsProcessed: studies.length * Object.keys(signals15).length,
        combinationsGenerated: pool.length,
        hypothesesCreated,
        forecastsResolved: resolvedCount,
        learningUpdatesCount: learningUpdated ? 15 : 0,
        regimeDetected: detectedRegime,
        logSummary: summaryText,
        metricsJson: {
          latencyMs,
          cycleMs,
          isLiveOKX: isLiveTickers,
          topScore: pool[0]?.earlyValueScore || 0,
          universeSize: universe.length,
          universe,
          listedCount,
          floorCount,
          droppedSymbols,
          // Решение об отборе сохраняется вместе с циклом: история «кто выбирал и
          // что из этого вышло» читается без изменений схемы
          planner: { ...decision, createdAt: new Date().toISOString() },
          // H001/H003/H004: ансамбль, теневая книга и гейт DSR — аудит каждого цикла
          ensemble: {
            votes: ensemble.size,
            ensembleMs,
            summary: ensemble.size
              ? {
                  meanP:
                    Number(
                      ([...ensemble.values()].reduce((a, v) => a + v.p, 0) / ensemble.size).toFixed(4)
                    ),
                  meanSpread:
                    Number(
                      ([...ensemble.values()].reduce((a, v) => a + v.spread, 0) / ensemble.size).toFixed(4)
                    ),
                }
              : null,
          },
          shadow: { logged: shadowLogged, resolved: shadowResolved, ope },
          gate: { trials: facts.trials, dsr: facts.dsr, verdict: facts.gateVerdict },
          assetsInPool: studies.map((s) => ({
            symbol: s.symbol,
            role: s.role,
            regime: s.regime,
            dataLive: s.dataLive,
            topEvs: pool.find((c) => c.asset === s.symbol)?.earlyValueScore ?? 0,
          })),
        },
        createdAt: new Date(),
      });

      this.lastRunTime = new Date();
      this.nextRunTime = new Date(Date.now() + this.intervalMinutes * 60 * 1000);

      return {
        timestamp: this.lastRunTime.toISOString(),
        isLiveOKX: isLiveTickers,
        latencyMs,
        trackedCount: universe.length,
        universe,
        marketRegime: detectedRegime,
        combinationsGenerated: pool.length,
        hypothesesCreated,
        forecastsResolved: resolvedCount,
        learningUpdated,
        summary: summaryText,
        planner: decision,
      };
    } finally {
      this.isRunning = false;
    }
  }
}

export const autonomousScheduler = new AutonomousScheduler();
