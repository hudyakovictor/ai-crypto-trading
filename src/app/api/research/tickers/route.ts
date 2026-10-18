import { NextResponse } from "next/server";
import { okxClient } from "@/lib/okx/okx-client";
import { passesFloor, quoteVolumeUsd } from "@/lib/quant/universe";

export const dynamic = "force-dynamic";

/**
 * Исполнимый срез рынка: USDT-пары, прошедшие пол ликвидности.
 * Диагностический эндпоинт — UI читает вселенную из /status и /heatmap.
 * Отдаём только прошедшие пол (десятки пар вместо ~450 листингов), чтобы
 * ответ оставался маленьким и означал то же, что и отбор цикла.
 */
const MAX_ROWS = 60;

export async function GET() {
  const started = Date.now();
  try {
    const { tickers, isLive, latencyMs } = await okxClient.getTickers();
    const executable = tickers.filter((t) => passesFloor(t)).slice(0, MAX_ROWS);
    return NextResponse.json({
      success: true,
      isLive,
      latencyMs: latencyMs || Date.now() - started,
      updatedAt: new Date().toISOString(),
      listedCount: tickers.length,
      executableCount: executable.length,
      tickers: executable.map((t) => ({
        symbol: t.instId,
        base: t.instId.split("-")[0],
        last: t.last,
        change24h: t.open24h > 0 ? ((t.last - t.open24h) / t.open24h) * 100 : 0,
        high24h: t.high24h,
        low24h: t.low24h,
        vol24h: t.vol24h,
        quoteVolumeUsd: quoteVolumeUsd(t),
        spreadBps: t.bidPx > 0 && t.askPx > 0 ? ((t.askPx - t.bidPx) / ((t.askPx + t.bidPx) / 2)) * 10000 : 0,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "OKX tickers failed";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
