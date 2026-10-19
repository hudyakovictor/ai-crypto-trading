import { NextResponse } from "next/server";
import { db } from "@/db";
import { learningWeights } from "@/db/schema";
import { okxClient } from "@/lib/okx/okx-client";
import { featureEngine } from "@/lib/quant/feature-engine";
import { combinationEngine } from "@/lib/quant/combination-engine";
import { loadActiveUniverse } from "@/lib/quant/universe-store";
import { mapLimited, UNIVERSE_ANCHOR } from "@/lib/quant/universe";
import { CATEGORY_KEYS } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Хитмап строится по активам, которые сама вселенная выбрала в этом цикле,
 * а не по хардкод-списку. Якорь (BTC) всегда первым — остальные по merit-скорам.
 */
const MAX_ROWS = 10;

export async function GET() {
  const started = Date.now();
  try {
    const [{ universe, source }, { tickers, isLive }] = await Promise.all([
      loadActiveUniverse({ allowScan: false }),
      okxClient.getTickers(),
    ]);

    const ordered = [
      ...universe.filter((u) => u.symbol === UNIVERSE_ANCHOR),
      ...universe.filter((u) => u.symbol !== UNIVERSE_ANCHOR),
    ].slice(0, MAX_ROWS);

    const allTickersPerf = tickers.map((t) => ({
      symbol: t.instId,
      change24h: t.open24h > 0 ? ((t.last - t.open24h) / t.open24h) * 100 : 0,
      volume: t.vol24h,
    }));

    let weightsRows: { categoryName: string; currentWeight: number }[] = [];
    try {
      weightsRows = await db.select().from(learningWeights);
    } catch {
      weightsRows = [];
    }
    const weightsMap: Record<string, number> = {};
    for (const w of weightsRows) weightsMap[w.categoryName] = w.currentWeight;

    const { candles: btcCandles } = await okxClient.getCandles(UNIVERSE_ANCHOR, "15m", 40);

    const assetResults = await mapLimited(ordered, 3, async (member) => {
      const sym = member.symbol;
      const { candles, isLive: candlesLive } = await okxClient.getCandles(sym, "15m", 40);
      const [{ book }, { funding }, { oi }] = await Promise.all([
        okxClient.getOrderBook(sym, 10),
        okxClient.getFundingRate(sym),
        okxClient.getOpenInterest(sym),
      ]);

      const feOut = featureEngine.calculate15Categories({
        symbol: sym,
        candles,
        book,
        funding,
        oi,
        btcCandles,
        allTickersPerformance: allTickersPerf,
      });

      const ticker = tickers.find((t) => t.instId === sym);
      const closes24 = candles.slice(-24).map((c) => c.close);

      // Быстрая in-memory разведка: топ-EVS по этому активу для скоринга карточки
      let topEvs = 0;
      let topDirection = "NEUTRAL";
      try {
        const probe = combinationEngine.generate100Combinations(
          sym,
          feOut.signals,
          feOut.regime,
          weightsMap,
          candlesLive ? feOut.dataQualityScore : 7.5
        );
        if (probe.length > 0) {
          topEvs = probe[0].earlyValueScore;
          topDirection = probe[0].targetDirection;
        }
      } catch {
        /* разведка носит справочный характер */
      }

      return {
        symbol: sym,
        lastPrice: ticker?.last || (candles[candles.length - 1]?.close ?? 0),
        change24h: ticker?.open24h ? ((ticker.last - ticker.open24h) / ticker.open24h) * 100 : 0,
        regime: feOut.regime,
        closes24,
        topEvs,
        topDirection,
        signals: feOut.signals,
        // Прозрачность отбора: почему актив в матрице и насколько свежи данные
        role: member.role,
        universeScore: member.score,
        selectionReason: member.reason,
        dataLive: member.dataLive && candlesLive,
      };
    });

    return NextResponse.json({
      success: true,
      categories: CATEGORY_KEYS,
      isLive,
      latencyMs: Date.now() - started,
      universeSource: source,
      universeSize: universe.length,
      assets: assetResults,
      updatedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to load heatmap";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
