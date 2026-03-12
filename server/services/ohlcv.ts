/**
 * OHLCV fetch and store from Alphavantage.
 * Stocks: TIME_SERIES_DAILY. Crypto: DIGITAL_CURRENCY_DAILY.
 * Used by Holdings charts, backtest, and signal generation.
 */

const ALPHAVANTAGE_BASE = "https://www.alphavantage.co/query";
const OHLCV_DAYS = 100;

export type OHLCVRow = {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function alphavantageUrl(params: Record<string, string>): string {
  const key = process.env.ALPHAVANTAGE_API_KEY?.trim() ?? "";
  const q = new URLSearchParams({ ...params, apikey: key });
  return `${ALPHAVANTAGE_BASE}?${q.toString()}`;
}

function parseOHLCVFromStock(data: Record<string, unknown>): OHLCVRow[] {
  const series =
    (data["Time Series (Daily)"] as Record<string, Record<string, string>> | undefined) ??
    (data["Time Series 1 (Daily)"] as Record<string, Record<string, string>> | undefined);
  if (!series || typeof series !== "object") return [];
  return Object.entries(series).map(([date, row]) => ({
    symbol: "",
    date,
    open: parseFloat(row["1. open"] ?? row["1. open (USD)"] ?? "0") || 0,
    high: parseFloat(row["2. high"] ?? row["2a. high (USD)"] ?? "0") || 0,
    low: parseFloat(row["3. low"] ?? row["3a. low (USD)"] ?? "0") || 0,
    close: parseFloat(row["4. close"] ?? row["4a. close (USD)"] ?? "0") || 0,
    volume: parseFloat(row["5. volume"] ?? row["5. volume"] ?? "0") || 0,
  }));
}

function parseOHLCVFromCrypto(data: Record<string, unknown>, symbol: string): OHLCVRow[] {
  const key = "Time Series (Digital Currency Daily)";
  const series = data[key] as Record<string, Record<string, string>> | undefined;
  if (!series || typeof series !== "object") return [];
  return Object.entries(series).map(([date, row]) => {
    const o = row["1a. open (USD)"] ?? row["1. open"] ?? "0";
    const h = row["2a. high (USD)"] ?? row["2. high"] ?? "0";
    const l = row["3a. low (USD)"] ?? row["3. low"] ?? "0";
    const c = row["4a. close (USD)"] ?? row["4. close"] ?? "0";
    const v = row["5. volume"] ?? "0";
    return {
      symbol,
      date,
      open: parseFloat(o) || 0,
      high: parseFloat(h) || 0,
      low: parseFloat(l) || 0,
      close: parseFloat(c) || 0,
      volume: parseFloat(v) || 0,
    };
  });
}

export async function fetchOHLCVForTicker(
  symbol: string,
  options?: { cryptoIds?: Record<string, string> }
): Promise<{ rows: OHLCVRow[]; raw?: string } | null> {
  const cryptoIds = options?.cryptoIds ?? { BTC: "bitcoin", ETH: "ethereum" };
  const key = process.env.ALPHAVANTAGE_API_KEY?.trim();
  if (!key) {
    console.warn("OHLCV: Add ALPHAVANTAGE_API_KEY to .env (free at alphavantage.co)");
    return null;
  }
  const isCrypto = symbol in cryptoIds;
  let url: string;
  if (isCrypto) {
    url = alphavantageUrl({ function: "DIGITAL_CURRENCY_DAILY", symbol, market: "USD", outputsize: "full" });
  } else {
    url = alphavantageUrl({ function: "TIME_SERIES_DAILY", symbol, outputsize: "compact", datatype: "json" });
  }
  try {
    const res = await fetch(url);
    const data = (await res.json()) as Record<string, unknown>;
    const raw = JSON.stringify(data);
    if (data.Note || data["Error Message"]) {
      console.warn(`OHLCV ${symbol}:`, (data.Note ?? data["Error Message"]) as string);
      return null;
    }
    let rows: OHLCVRow[];
    if (isCrypto) {
      rows = parseOHLCVFromCrypto(data, symbol);
    } else {
      const parsed = parseOHLCVFromStock(data);
      rows = parsed.map((r) => ({ ...r, symbol }));
    }
    return { rows: rows.slice(0, OHLCV_DAYS), raw };
  } catch (e) {
    console.error(`OHLCV fetch ${symbol}:`, e);
    return null;
  }
}

/** DB interface for storing OHLCV rows. Compatible with sql.js Database. */
export interface OHLCVDbAdapter {
  run: (sql: string, params?: Record<string, string | number | null>) => unknown;
}

export function createFetchAndStoreOHLCV(deps: {
  getWatchedTickers: () => string[];
  db: OHLCVDbAdapter;
  saveDb: () => void;
  cryptoIds?: Record<string, string>;
}): () => Promise<void> {
  const { getWatchedTickers, db, saveDb, cryptoIds } = deps;
  return async function fetchAndStoreOHLCV() {
    const tickers = getWatchedTickers();
    for (let i = 0; i < tickers.length; i++) {
      const symbol = tickers[i];
      const result = await fetchOHLCVForTicker(symbol, { cryptoIds });
      if (!result?.rows.length) {
        console.warn(`OHLCV skip ${symbol} (no data or rate limited)`);
        await new Promise((r) => setTimeout(r, 13000));
        continue;
      }
      for (const r of result.rows) {
        db.run(
          `INSERT OR IGNORE INTO ohlcv (symbol, date, open, high, low, close, volume, source, created_at)
           VALUES (:symbol, :date, :open, :high, :low, :close, :volume, :source, :created_at)`,
          {
            ":symbol": r.symbol,
            ":date": r.date,
            ":open": r.open,
            ":high": r.high,
            ":low": r.low,
            ":close": r.close,
            ":volume": r.volume,
            ":source": "alphavantage",
            ":created_at": new Date().toISOString(),
          }
        );
      }
      if (result.raw) {
        const latestPrice = result.rows[0];
        db.run("UPDATE prices SET source_raw = :raw WHERE symbol = :symbol", {
          ":raw": result.raw.slice(0, 50000),
          ":symbol": symbol,
        });
      }
      saveDb();
      console.log(`OHLCV stored ${symbol} (${result.rows.length} bars) [${i + 1}/${tickers.length}]`);
      await new Promise((r) => setTimeout(r, 13000)); // Alphavantage free: 5 req/min → need ~13s between calls
    }
  };
}
