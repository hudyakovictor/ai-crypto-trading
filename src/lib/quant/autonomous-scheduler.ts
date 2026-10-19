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
import { eq, and, inArray, gte } from "drizzle-orm";
import { okxClient } from "../okx/okx-client";
import { featureEngine } from "./feature-engine";
import { combinationEngine } from "./combination-engine";
import { hypothesisEngine } from "./hypothesis-engine";
import { outcomeEvaluator } from "./outcome-evaluator";
import { learningLoop } from "./learning-loop";
import { BAR_MS, MAX_RESOLUTION_DELAY_MS } from "./outcome-contract";
import { CATEGORY_KEYS, CategoryKey, MarketRegime, NormalizedSignal, OKXCandle } from "../types";
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
  signatureFromHypothesis,
  type AssetMoveStats,
  type PoolItem,
} from "./planner";
import type { PlannerDecisionRow } from "../ui-types";

export interface CycleResult {
  timestamp: string;
  /** null — цикл не выполнялся (пропуск) или данные не живые: выдумывать «true» нельзя. */
  isLiveOKX: boolean | null;
  latencyMs: number;
  trackedCount: number;
  universe: UniverseMember[];
  marketRegime: MarketRegime | null;
  combinationsGenerated: number;
  hypothesesCreated: number;
  forecastsResolved: number;
  learningUpdated: boolean;
  /** Причина пропуска, если цикл не выполнялся. */
  skipped?: "concurrent_run";
  summary: string;
  /** Кто на этом цикле решил «сколько гипотез и какие»: модель, правило или запас */
  planner: PlannerDecisionRow | null;
}

export class AutonomousScheduler {
  private isRunning = false;
  private lastRunTime: Date | null = null;
  /** Когда цикл был предпринят в последний раз (успешно или нет) — основа каденса и backoff. */
  private lastAttemptTime: Date | null = null;
  /** Подряд идущие аварии: для экспоненциального backoff вместо ретрая каждую минуту. */
  private consecutiveErrors = 0;
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

  getLastAttemptTime(): Date | null {
    return this.lastAttemptTime;
  }

  getConsecutiveErrors(): number {
    return this.consecutiveErrors;
  }

  /** Идёт ли цикл прямо сейчас: нужно read-only эндпоинтам и UI. */
  isCycleRunning(): boolean {
    return this.isRunning;
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
      // Честный пропуск: раньше здесь возвращался «успешный» результат с
      // isLiveOKX: true и выдуманным режимом рынка, и UI показывал тост
      // «Цикл завершён» для цикла, которого не было.
      return {
        timestamp: new Date().toISOString(),
        isLiveOKX: null,
        latencyMs: 0,
        trackedCount: this.lastUniverse.length,
        universe: this.lastUniverse,
        marketRegime: null,
        combinationsGenerated: 0,
        hypothesesCreated: 0,
        forecastsResolved: 0,
        learningUpdated: false,
        skipped: "concurrent_run",
        summary: "Цикл уже выполняется — одновременный запуск пропущен.",
        planner: this.lastPlannerDecision,
      };
    }

    this.isRunning = true;
    this.lastAttemptTime = new Date();
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

      // Незакрытые прогнозы читаются ОДИН раз за цикл: раньше этот же запрос
      // повторялся ниже (перед разрешением исходов), что давало лишний seq scan
      // и расхождение списков при конкурентной записи.
      const pendingForecasts = await db
        .select()
        .from(forecastsTable)
        .where(eq(forecastsTable.status, "pending"));

      // Свечи нужны и для активов, которые уже вышли из вселенной, но ещё имеют
      // незакрытые прогнозы: иначе ротация состава ломала бы учёт исходов.
      // Лимита «12 активов» больше нет: без цены прогноз разрешался фиктивно
      // (по цене входа), а это выдуманная метка в обучении.
      const missingSymbols = [
        ...new Set(pendingForecasts.map((f) => f.asset).filter((a) => !candlesMap.has(a))),
      ];
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

      // История свечей: сохраняется ВСЁ окно (60 баров), а не 3 последних.
      // Накопленная история — это топливо обучения: без неё невозможен ни
      // бэктест, ни walk-forward, ни оценка базовой частоты движения актива.
      // Запись батчем: один запрос на чтение существующих баров и один на вставку.
      const liveUniverseSymbols = universe.filter((u) => u.dataLive).map((u) => u.symbol);
      let candlesInserted = 0;
      if (liveUniverseSymbols.length > 0) {
        const wanted: { symbol: string; c: OKXCandle }[] = [];
        let minTs = Number.POSITIVE_INFINITY;
        for (const sym of liveUniverseSymbols) {
          for (const c of candlesMap.get(sym) ?? []) {
            if (c.timestamp < minTs) minTs = c.timestamp;
            wanted.push({ symbol: sym, c });
          }
        }
        const existingRows =
          wanted.length > 0 && Number.isFinite(minTs)
            ? await db
                .select({ symbol: candlesTable.symbol, timestamp: candlesTable.timestamp })
                .from(candlesTable)
                .where(
                  and(
                    inArray(candlesTable.symbol, liveUniverseSymbols),
                    gte(candlesTable.timestamp, new Date(minTs))
                  )
                )
            : [];
        const seen = new Set(existingRows.map((r) => `${r.symbol}|${r.timestamp.getTime()}`));
        const nowMs = Date.now();
        const rowsToInsert = wanted
          .filter(({ symbol, c }) => !seen.has(`${symbol}|${c.timestamp}`))
          .map(({ symbol, c }) => ({
            symbol,
            timeframe: "15m",
            timestamp: new Date(c.timestamp),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            volCcy: c.volCcy,
            // Последний бар OKX отдаёт незакрытым: помечаем честно, иначе он
            // участвует в экстремумах MFE/MAE и завышает hit-rate.
            confirmed: c.timestamp + BAR_MS <= nowMs,
          }));
        if (rowsToInsert.length > 0) {
          for (let i = 0; i < rowsToInsert.length; i += 500) {
            await db.insert(candlesTable).values(rowsToInsert.slice(i, i + 500));
          }
          candlesInserted = rowsToInsert.length;
        }
      }

      // Step 3: Разрешение созревших прогнозов.
      // Три правила честности метки:
      //   — нет цены на момент разрешения → expired, а не «miss по цене входа»;
      //   — разрешение сильно позже горизонта → expired (проверяли уже другой рынок);
      //   — expired не участвует в обучении весов.
      const now = new Date();
      let resolvedCount = 0;
      let expiredCount = 0;

      const due = pendingForecasts.filter((fc) => new Date(fc.resolveAt) <= now);
      const dueHypIds = [
        ...new Set(due.map((f) => f.hypothesisId).filter((x): x is number => typeof x === "number")),
      ];
      const dueHypRows =
        dueHypIds.length > 0
          ? await db
              .select({
                id: hypothesesTable.id,
                categoriesJson: hypothesesTable.categoriesJson,
              })
              .from(hypothesesTable)
              .where(inArray(hypothesesTable.id, dueHypIds))
          : [];
      const dueHypById = new Map(dueHypRows.map((h) => [h.id, h]));

      for (const fc of due) {
        const symCandles = candlesMap.get(fc.asset) ?? [];
        const tickerPrice = tickers.find((t) => t.instId === fc.asset)?.last;
        // Цена разрешения: тикер, а если его нет — закрытие последнего бара окна.
        // Подстановка цены входа (прежнее поведение) давала выдуманный исход.
        const lastBarClose = symCandles.length > 0 ? symCandles[symCandles.length - 1].close : 0;
        const currentPrice = tickerPrice && tickerPrice > 0 ? tickerPrice : lastBarClose;
        const delayMs = now.getTime() - new Date(fc.resolveAt).getTime();

        const hyp = fc.hypothesisId ? dueHypById.get(fc.hypothesisId) : undefined;
        const categories = Array.isArray(hyp?.categoriesJson) ? (hyp!.categoriesJson as string[]) : [];

        if (!(currentPrice > 0) || delayMs > MAX_RESOLUTION_DELAY_MS) {
          expiredCount++;
          await db
            .update(forecastsTable)
            .set({
              status: "expired",
              outcome: "expired",
              resolvedPrice: currentPrice > 0 ? currentPrice : null,
              errorType: "data_gap",
              resolvedAt: now,
            })
            .where(eq(forecastsTable.id, fc.id));
          if (fc.hypothesisId) {
            await db
              .update(hypothesesTable)
              .set({ status: "expired" })
              .where(eq(hypothesesTable.id, fc.hypothesisId));
          }
          continue;
        }

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
            errorType: resolution.caveat === "no_bars_in_window" ? "data_gap" : resolution.errorType,
            resolvedAt: resolution.resolvedAt,
          })
          .where(eq(forecastsTable.id, fc.id));

        resolvedCount++;

        if (fc.hypothesisId) {
          await db
            .update(hypothesesTable)
            .set({ status: resolution.outcome === "hit" ? "fulfilled" : "invalidated" })
            .where(eq(hypothesesTable.id, fc.hypothesisId));
        }
      }

      // Step 4: Обучение. Пересчёт АБСОЛЮТНЫЙ и идемпотентный: веса читаются из
      // всей истории одним SQL-агрегатом. Прежний инкрементальный вызов здесь
      // плюс повторное «переобучение на всей истории» в автопилоте считали
      // каждый исход заново каждый цикл (totalSamples рос квадратично).
      let learningUpdated = false;
      let learningStats: Awaited<ReturnType<typeof learningLoop.rebuildFromHistory>> | null = null;
      if (resolvedCount > 0) {
        learningStats = await learningLoop.rebuildFromHistory();
        learningUpdated = true;
      }

      // Step 5: Get Current Learned Weights
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
          // Фолбэки OKX больше не попадают в признаки: синтетический стакан,
          // выдуманный фандинг и константный OI раньше приходили сюда как
          // данные, и категории считались на галлюцинациях.
          book: bookRes.isLive ? bookRes.book : undefined,
          funding: fundingRes.isLive ? fundingRes.funding : undefined,
          oi: oiRes.isLive ? oiRes.oi : undefined,
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
          // Какие источники этого актива пришли синтетикой — пишется в журнал качества.
          syntheticInputs: [
            bookRes.isLive ? null : "book",
            fundingRes.isLive ? null : "funding",
            oiRes.isLive ? null : "oi",
          ].filter((x): x is string => x !== null),
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
      this.lastUniverse = universe;

      // Step 8: Комбинаторная разведка — 100 вариаций НА АКТИВ.
      // раньше 100 связок строились только по BTC; теперь пул объединяет
      // вариации всех участников вселенной, а ранжирование идёт по EVS.
      const pool = studies.flatMap((st) =>
        combinationEngine
          .generate100Combinations(
            st.symbol,
            st.signals,
            st.regime,
            currentWeights,
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

      const decision = await planCycle({
        candidates,
        policy,
        facts,
        weightsTop: weightViews.weightsTop,
        weightsLow: weightViews.weightsLow,
        record,
        universeNote,
      });
      this.lastPlannerDecision = decision;

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
      const summaryText = `Цикл: вселенная ${universe.length} активов (ядро ${
        universe.filter((u) => u.role === "core").length
      }, разведка ${universe.filter((u) => u.role === "explore").length}), режим ${detectedRegime}, связок ${
        pool.length
      }, кандидатов ${decision.offered}, решил ${decidedBy} → гипотез ${hypothesesCreated}, разрешено ${resolvedCount}${
        expiredCount > 0 ? `, протухло без цены ${expiredCount}` : ""
      }, баров сохранено ${candlesInserted}, обучение: ${
        learningStats ? `пересчёт по ${learningStats.events} исходам, Brier ${learningStats.averageBrier}` : "без изменений"
      }.`;

      await db.insert(experimentRuns).values({
        runType: isManualTrigger ? "manual_trigger_15m" : "scheduled_15m",
        totalSignalsProcessed: studies.length * CATEGORY_KEYS.length,
        combinationsGenerated: pool.length,
        hypothesesCreated,
        forecastsResolved: resolvedCount,
        learningUpdatesCount: learningStats?.categories ?? 0,
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
          candlesInserted,
          forecastsExpired: expiredCount,
          learning: learningStats,
          syntheticInputs: studies
            .filter((s) => s.syntheticInputs.length > 0)
            .map((s) => ({ symbol: s.symbol, missing: s.syntheticInputs })),
          // Решение об отборе сохраняется вместе с циклом: история «кто выбирал и
          // что из этого вышло» читается без изменений схемы
          planner: { ...decision, createdAt: new Date().toISOString() },
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
      this.consecutiveErrors = 0;
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
    } catch (err) {
      this.consecutiveErrors += 1;
      throw err;
    } finally {
      this.isRunning = false;
    }
  }
}

export const autonomousScheduler = new AutonomousScheduler();
