import { OKXTicker, OKXCandle, OKXFundingRate, OKXOpenInterest, OKXOrderBook } from "../types";

/**
 * Список только для полностью синтетического режима (OKX недоступен).
 * Реальная вселенная больше не хардкодится — её строит quant/universe.ts
 * из полного ответа /market/tickers. Устаревшие тикеры (MATIC → POL) сами
 * отваливаются: их нет в ответе биржи, и мы их больше не выдумываем.
 */
export const FALLBACK_SYMBOLS = [
  "BTC-USDT",
  "ETH-USDT",
  "SOL-USDT",
  "XRP-USDT",
  "DOGE-USDT",
  "AVAX-USDT",
  "BNB-USDT",
  "LINK-USDT",
];

const OKX_BASE_URL = "https://www.okx.com";

export /** Строгий парсинг уровней стакана: нечисловые строки отбрасываются. */
function parseLevels(raw: unknown): [number, number][] {
  if (!Array.isArray(raw)) return [];
  const out: [number, number][] = [];
  for (const level of raw) {
    if (!Array.isArray(level) || level.length < 2) continue;
    const price = Number(level[0]);
    const size = Number(level[1]);
    if (Number.isFinite(price) && Number.isFinite(size) && price > 0 && size > 0) {
      out.push([price, size]);
    }
  }
  return out;
}

/** Метка времени из ответа OKX; при мусоре — текущее время. */
function parseTs(raw: unknown): number {
  const ts = Number(raw);
  return Number.isFinite(ts) && ts > 0 ? ts : Date.now();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class OKXClient {
  private timeoutMs: number;

  constructor(timeoutMs = 5000) {
    this.timeoutMs = timeoutMs;
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "Accept": "application/json",
          "User-Agent": "QuantResearchDashboard/1.0",
        },
      });
      clearTimeout(id);
      return response;
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  }

  /**
   * Все реальные USDT-пары спот-линейки OKX (сортировка по объёму в котировке).
   * Важнее всего то, чего здесь больше нет: раньше отсутствующий инструмент
   * молча подменялся синтетикой при глобальном isLive: true — движок строил
   * гипотезы на выдуманных ценах, считая их живыми. Теперь синтетика возможна
   * только если весь запрос к OKX упал, и тогда isLive: true не бывает.
   */
  async getTickers(): Promise<{ tickers: OKXTicker[]; latencyMs: number; isLive: boolean }> {
    const startTime = Date.now();
    try {
      const url = `${OKX_BASE_URL}/api/v5/market/tickers?instType=SPOT`;
      const res = await this.fetchWithTimeout(url);
      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        throw new Error(`OKX HTTP error: ${res.status}`);
      }

      const json = await res.json();
      if (json.code !== "0" || !Array.isArray(json.data)) {
        throw new Error(`OKX API error: ${json.msg || "Unknown error"}`);
      }

      const parsed: OKXTicker[] = [];
      for (const item of json.data) {
        const instId: string = item.instId ?? "";
        if (!instId.endsWith("-USDT")) continue;
        const last = parseFloat(item.last) || 0;
        if (last <= 0) continue;
        parsed.push({
          instId,
          last,
          open24h: parseFloat(item.open24h) || 0,
          high24h: parseFloat(item.high24h) || 0,
          low24h: parseFloat(item.low24h) || 0,
          vol24h: parseFloat(item.vol24h) || 0,
          volCcy24h: parseFloat(item.volCcy24h) || 0,
          bidPx: parseFloat(item.bidPx) || 0,
          bidSz: parseFloat(item.bidSz) || 0,
          askPx: parseFloat(item.askPx) || 0,
          askSz: parseFloat(item.askSz) || 0,
          ts: parseInt(item.ts, 10) || Date.now(),
        });
      }

      if (parsed.length === 0) throw new Error("OKX returned no tradeable USDT pairs");

      parsed.sort(
        (a, b) => (b.volCcy24h || b.vol24h * b.last) - (a.volCcy24h || a.vol24h * a.last)
      );
      return { tickers: parsed, latencyMs, isLive: true };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      console.warn("OKX tickers fetch failed, falling back to realistic synthetic data:", err);
      const synthetic = FALLBACK_SYMBOLS.map((sym) => this.generateSyntheticTicker(sym));
      return { tickers: synthetic, latencyMs, isLive: false };
    }
  }

  async getCandles(symbol: string, bar = "15m", limit = 100): Promise<{ candles: OKXCandle[]; latencyMs: number; isLive: boolean }> {
    const startTime = Date.now();
    try {
      const url = `${OKX_BASE_URL}/api/v5/market/candles?instId=${encodeURIComponent(symbol)}&bar=${bar}&limit=${limit}`;
      const res = await this.fetchWithTimeout(url);
      const latencyMs = Date.now() - startTime;

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.code !== "0" || !Array.isArray(json.data) || json.data.length === 0) {
        throw new Error(json.msg || "No candles data");
      }

      // OKX returns newest candle first, so reverse to chronological order
      const parsed: OKXCandle[] = json.data
        .map((row: string[]) => ({
          timestamp: parseInt(row[0], 10),
          open: parseFloat(row[1]),
          high: parseFloat(row[2]),
          low: parseFloat(row[3]),
          close: parseFloat(row[4]),
          volume: parseFloat(row[5]),
          volCcy: parseFloat(row[6]),
        }))
        .sort((a: OKXCandle, b: OKXCandle) => a.timestamp - b.timestamp);

      return { candles: parsed, latencyMs, isLive: true };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      console.warn(`OKX candles fetch failed for ${symbol}, generating synthetic series:`, err);
      const synthCandles = this.generateSyntheticCandles(symbol, limit);
      return { candles: synthCandles, latencyMs, isLive: false };
    }
  }

  /**
   * Журнал последних отказов по каждому источнику данных.
   *
   * Раньше ошибка глоталась в catch и наружу возвращалась синтетика: понять,
   * что именно отвалилось (стакан, фандинг, OI, свечи), можно было только по
   * логам. Теперь последний отказ по каждому источнику виден в /api/research/status.
   */
  readonly lastErrors: Record<string, { symbol: string; message: string; at: number }> = {};

  async getOrderBook(symbol: string, depth = 20): Promise<{ book: OKXOrderBook; latencyMs: number; isLive: boolean }> {
    const startTime = Date.now();
    try {
      const url = `${OKX_BASE_URL}/api/v5/market/books?instId=${encodeURIComponent(symbol)}&sz=${depth}`;
      const res = await this.fetchWithTimeout(url);
      const latencyMs = Date.now() - startTime;

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.code !== "0" || !json.data || !json.data[0]) {
        throw new Error(json.msg || "No order book data");
      }

      const bookData = json.data[0];
      // Строгий парсинг: NaN-строки отбрасываются, а не превращаются в мусор,
      // который потом усредняется в imbalance и меняет направление сигнала.
      const bids: [number, number][] = parseLevels(bookData.bids);
      const asks: [number, number][] = parseLevels(bookData.asks);
      // Пустой стакан — это не стакан. Раньше он уходил в движок как «живой»,
      // и imbalance считался нулём, то есть признаком равновесия.
      if (bids.length === 0 || asks.length === 0) {
        throw new Error("empty order book");
      }

      return {
        book: {
          instId: symbol,
          bids,
          asks,
          ts: parseTs(bookData.ts),
        },
        latencyMs,
        isLive: true,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      this.lastErrors.orderBook = { symbol, message: errMessage(err), at: Date.now() };
      return {
        book: this.generateSyntheticOrderBook(symbol),
        latencyMs,
        isLive: false,
      };
    }
  }

  async getFundingRate(symbol: string): Promise<{ funding: OKXFundingRate; latencyMs: number; isLive: boolean }> {
    const startTime = Date.now();
    const swapSymbol = symbol.replace("-USDT", "-USDT-SWAP");
    try {
      const url = `${OKX_BASE_URL}/api/v5/public/funding-rate?instId=${encodeURIComponent(swapSymbol)}`;
      const res = await this.fetchWithTimeout(url);
      const latencyMs = Date.now() - startTime;

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.code !== "0" || !json.data || !json.data[0]) {
        throw new Error(json.msg || "No funding data");
      }

      const item = json.data[0];
      // `parseFloat(x) || 0.0001` подменял законный нулевой фандинг и NaN
      // одной и той же выдуманной константой — категория derivatives_positioning
      // получала сигнал «фандинг положительный» там, где данных не было.
      const fundingRate = Number(item.fundingRate);
      if (!Number.isFinite(fundingRate)) {
        throw new Error("fundingRate is not a number");
      }
      const nextFundingRate = Number(item.nextFundingRate);
      return {
        funding: {
          instId: swapSymbol,
          fundingRate,
          fundingTime: parseTs(item.fundingTime),
          ...(Number.isFinite(nextFundingRate) ? { nextFundingRate } : {}),
        },
        latencyMs,
        isLive: true,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      this.lastErrors.fundingRate = { symbol, message: errMessage(err), at: Date.now() };
      return {
        funding: {
          instId: swapSymbol,
          fundingRate: 0,
          fundingTime: Date.now() + 4 * 3600000,
        },
        latencyMs,
        isLive: false,
      };
    }
  }

  async getOpenInterest(symbol: string): Promise<{ oi: OKXOpenInterest; latencyMs: number; isLive: boolean }> {
    const startTime = Date.now();
    const swapSymbol = symbol.replace("-USDT", "-USDT-SWAP");
    try {
      const url = `${OKX_BASE_URL}/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(swapSymbol)}`;
      const res = await this.fetchWithTimeout(url);
      const latencyMs = Date.now() - startTime;

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.code !== "0" || !json.data || !json.data[0]) {
        throw new Error(json.msg || "No OI data");
      }

      const item = json.data[0];
      const oi = Number(item.oi);
      const oiCcy = Number(item.oiCcy);
      if (!Number.isFinite(oi) || !Number.isFinite(oiCcy)) {
        throw new Error("open interest is not a number");
      }
      return {
        oi: {
          instId: swapSymbol,
          oi,
          oiCcy,
          ts: parseTs(item.ts),
        },
        latencyMs,
        isLive: true,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      this.lastErrors.openInterest = { symbol, message: errMessage(err), at: Date.now() };
      // Нули и isLive: false вместо констант 12500 / 850000000, которые раньше
      // выдавались за живые данные и участвовали в расчёте признаков.
      return {
        oi: {
          instId: swapSymbol,
          oi: 0,
          oiCcy: 0,
          ts: Date.now(),
        },
        latencyMs,
        isLive: false,
      };
    }
  }

  toSwapId(symbol: string): string {
    return symbol.replace("-USDT", "-USDT-SWAP");
  }

  // --- Realistic Deterministic Synthetic Fallback Generators ---
  private getBasePrice(symbol: string): number {
    switch (symbol) {
      case "BTC-USDT": return 78000;
      case "ETH-USDT": return 2450;
      case "SOL-USDT": return 145;
      case "XRP-USDT": return 2.15;
      case "DOGE-USDT": return 0.22;
      case "AVAX-USDT": return 28.5;
      default: return 100;
    }
  }

  private generateSyntheticTicker(symbol: string): OKXTicker {
    const base = this.getBasePrice(symbol);
    const jitter = (Math.sin(Date.now() / 60000 + symbol.length) * 0.015);
    const currentPrice = base * (1 + jitter);
    const spread = currentPrice * 0.0002;

    return {
      instId: symbol,
      last: currentPrice,
      open24h: base,
      high24h: currentPrice * 1.025,
      low24h: currentPrice * 0.975,
      vol24h: 15000 + Math.random() * 5000,
      volCcy24h: 15000 * base,
      bidPx: currentPrice - spread / 2,
      bidSz: 1.25,
      askPx: currentPrice + spread / 2,
      askSz: 1.15,
      ts: Date.now(),
    };
  }

  private generateSyntheticCandles(symbol: string, count: number): OKXCandle[] {
    const basePrice = this.getBasePrice(symbol);
    const candles: OKXCandle[] = [];
    const stepMs = 15 * 60 * 1000;
    const now = Math.floor(Date.now() / stepMs) * stepMs;
    let current = basePrice * 0.98;

    for (let i = count; i >= 0; i--) {
      const t = now - i * stepMs;
      const drift = Math.sin(i * 0.25) * 0.004 + (Math.random() - 0.49) * 0.008;
      const open = current;
      const close = open * (1 + drift);
      const high = Math.max(open, close) * (1 + Math.random() * 0.004);
      const low = Math.min(open, close) * (1 - Math.random() * 0.004);
      const volume = (basePrice > 1000 ? 50 : 5000) * (0.6 + Math.random() * 0.8);

      candles.push({
        timestamp: t,
        open,
        high,
        low,
        close,
        volume,
        volCcy: volume * close,
      });

      current = close;
    }

    return candles;
  }

  private generateSyntheticOrderBook(symbol: string): OKXOrderBook {
    const base = this.getBasePrice(symbol);
    const bids: [number, number][] = [];
    const asks: [number, number][] = [];
    const tick = base * 0.0001;

    for (let i = 1; i <= 20; i++) {
      bids.push([base - i * tick, 0.5 + Math.random() * 2]);
      asks.push([base + i * tick, 0.5 + Math.random() * 2]);
    }

    return {
      instId: symbol,
      bids,
      asks,
      ts: Date.now(),
    };
  }
}

export const okxClient = new OKXClient();
