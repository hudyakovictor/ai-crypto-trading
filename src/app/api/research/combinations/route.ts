import { NextResponse } from "next/server";
import { db } from "@/db";
import { combinations as combinationsTable, learningWeights } from "@/db/schema";
import { desc } from "drizzle-orm";
import { okxClient } from "@/lib/okx/okx-client";
import { featureEngine } from "@/lib/quant/feature-engine";
import { combinationEngine } from "@/lib/quant/combination-engine";
import { comboPasses, loadFilters } from "@/lib/filters";
import { passesFloor, UNIVERSE_ANCHOR } from "@/lib/quant/universe";
import { loadActiveUniverse, type ActiveUniverse } from "@/lib/quant/universe-store";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get("symbol") || UNIVERSE_ANCHOR;

    // First check if we should generate fresh 100 combinations on the fly
    const { candles, isLive: candlesLive } = await okxClient.getCandles(symbol, "15m", 50);
    const { book } = await okxClient.getOrderBook(symbol, 20);
    const { funding } = await okxClient.getFundingRate(symbol);
    const { oi } = await okxClient.getOpenInterest(symbol);

    const weightsRows = await db.select().from(learningWeights);
    const weightsMap: Record<string, number> = {};
    for (const w of weightsRows) {
      weightsMap[w.categoryName] = w.currentWeight;
    }

    // Тот же контекст, что и в цикле: без BTC-свечей и breadth-среза
    // кросс-активные категории молча схлопывались бы в ноль.
    const { tickers } = await okxClient.getTickers();
    const allTickersPerf = tickers
      .filter((t) => passesFloor(t))
      .slice(0, 150)
      .map((t) => ({
        symbol: t.instId,
        change24h: t.open24h > 0 ? ((t.last - t.open24h) / t.open24h) * 100 : 0,
        volume: t.vol24h,
      }));
    const { candles: btcCandles, isLive: btcLive } =
      symbol === UNIVERSE_ANCHOR
        ? { candles, isLive: candlesLive }
        : await okxClient.getCandles(UNIVERSE_ANCHOR, "15m", 50);

    const feOut = featureEngine.calculate15Categories({
      symbol,
      candles,
      book,
      funding,
      oi,
      btcCandles,
      allTickersPerformance: allTickersPerf,
    });

    const signals = feOut.signals;
    const regime = feOut.regime;
    const dataLive = candlesLive && (symbol !== UNIVERSE_ANCHOR || btcLive);

    // Generate exactly 100 variations
    const variations100 = combinationEngine.generate100Combinations(
      symbol,
      signals,
      regime,
      weightsMap,
      dataLive ? feOut.dataQualityScore : 7.5
    );

    // Count distributions
    const candidatesCount = variations100.filter((c) => c.status === "candidate").length;
    const promisingCount = variations100.filter((c) => c.status === "promising").length;
    const rejectedCount = variations100.filter((c) => c.status === "rejected").length;

    // Пользовательские фильтры потенциальных сигналов
    const filters = await loadFilters();
    const withFlags = variations100.map((c) => ({ ...c, passes: comboPasses(filters, c) }));
    const passCount = withFlags.filter((c) => c.passes).length;

    // Состав вселенной рядом со списком связок: экран «Комбинации» должен
    // позволять переключать актив, а не молча оставаться на BTC.
    let universe: ActiveUniverse["universe"] = [];
    try {
      universe = (await loadActiveUniverse()).universe;
    } catch {
      universe = [];
    }

    return NextResponse.json({
      success: true,
      symbol,
      regime,
      dataLive,
      universe,
      totalCount: variations100.length,
      stats: {
        promisingCount,
        candidatesCount,
        rejectedCount,
        topScore: variations100[0]?.earlyValueScore || 0,
        avgScore: (variations100.reduce((acc, c) => acc + c.earlyValueScore, 0) / variations100.length).toFixed(1),
      },
      filters,
      passCount,
      combinations: withFlags,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to generate combinations";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
