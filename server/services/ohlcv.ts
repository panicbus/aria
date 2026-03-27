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

export type OHLCVFetchResult = {
  rows: OHLCVRow[];
  raw?: string;
  detail?: string;
  source?: "alphavantage" | "coingecko";
};

/** Historical closes for sidebar charts when Alpha Vantage is missing or rate-limited (BTC/ETH only). */
async function fetchOhlcvFromCoinGecko(geckoId: string, symbol: string): Promise<OHLCVRow[]> {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(geckoId)}/market_chart?vs_currency=usd&days=90`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { prices?: [number, number][] };
    const prices = data.prices ?? [];
    const byDate = new Map<string, number>();
    for (const [ts, price] of prices) {
      const d = new Date(ts).toISOString().slice(0, 10);
      byDate.set(d, price);
    }
    const dates = [...byDate.keys()].sort();
    const rows = dates.map((date) => {
      const c = byDate.get(date)!;
      return { symbol, date, open: c, high: c, low: c, close: c, volume: 0 };
    });
    return rows.slice(-OHLCV_DAYS);
  } catch (e) {
    console.error(`CoinGecko OHLCV ${symbol}:`, e);
    return [];
  }
}

export async function fetchOHLCVForTicker(
  symbol: string,
  options?: { cryptoIds?: Record<string, string> }
): Promise<OHLCVFetchResult> {
  const cryptoIds = options?.cryptoIds ?? { BTC: "bitcoin", ETH: "ethereum" };
  const upper = symbol.toUpperCase();
  const isCrypto = upper in cryptoIds;
  const geckoId = isCrypto ? (cryptoIds[upper] ?? "") : "";
  const key = process.env.ALPHAVANTAGE_API_KEY?.trim();

  if (!key) {
    console.warn("OHLCV: ALPHAVANTAGE_API_KEY not set — stocks need it; trying CoinGecko for BTC/ETH only.");
    if (isCrypto && geckoId) {
      const rows = await fetchOhlcvFromCoinGecko(geckoId, upper);
      return rows.length
        ? { rows, source: "coingecko" }
        : {
            rows: [],
            detail:
              "No API key and CoinGecko returned no data. Set ALPHAVANTAGE_API_KEY in .env / fly secrets for stocks; check network for crypto.",
          };
    }
    return {
      rows: [],
      detail:
        "ALPHAVANTAGE_API_KEY is not set on the server. Add it to .env (local) or run: fly secrets set ALPHAVANTAGE_API_KEY=YOUR_KEY -a <app>",
    };
  }

  let url: string;
  if (isCrypto) {
    url = alphavantageUrl({ function: "DIGITAL_CURRENCY_DAILY", symbol: upper, market: "USD", outputsize: "full" });
  } else {
    url = alphavantageUrl({ function: "TIME_SERIES_DAILY", symbol: upper, outputsize: "compact", datatype: "json" });
  }
  try {
    const res = await fetch(url);
    const data = (await res.json()) as Record<string, unknown>;
    const raw = JSON.stringify(data);
    const avNote = (data.Note ?? data["Error Message"]) as string | undefined;
    if (avNote) {
      console.warn(`OHLCV ${upper} (Alpha Vantage):`, avNote);
      if (isCrypto && geckoId) {
        const rows = await fetchOhlcvFromCoinGecko(geckoId, upper);
        if (rows.length) {
          return {
            rows,
            source: "coingecko",
            detail: `Alpha Vantage unavailable (${avNote.slice(0, 120)}…). Using CoinGecko history.`,
          };
        }
      }
      return { rows: [], raw, detail: avNote };
    }
    let rows: OHLCVRow[];
    if (isCrypto) {
      rows = parseOHLCVFromCrypto(data, upper);
    } else {
      const parsed = parseOHLCVFromStock(data);
      rows = parsed.map((r) => ({ ...r, symbol: upper }));
    }
    rows = rows.slice(0, OHLCV_DAYS);
    if (rows.length === 0 && isCrypto && geckoId) {
      const cg = await fetchOhlcvFromCoinGecko(geckoId, upper);
      if (cg.length) return { rows: cg, source: "coingecko", detail: "Used CoinGecko (Alpha Vantage had no series)." };
    }
    if (rows.length === 0) {
      return { rows: [], raw, detail: "No daily series in Alpha Vantage response (check symbol or premium endpoint)." };
    }
    return { rows, raw, source: "alphavantage" };
  } catch (e) {
    console.error(`OHLCV fetch ${upper}:`, e);
    if (isCrypto && geckoId) {
      const rows = await fetchOhlcvFromCoinGecko(geckoId, upper);
      if (rows.length) return { rows, source: "coingecko", detail: "Alpha Vantage request failed; used CoinGecko." };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { rows: [], detail: msg };
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
      if (!result.rows.length) {
        console.warn(`OHLCV skip ${symbol}:`, result.detail ?? "no data or rate limited");
        await new Promise((r) => setTimeout(r, 13000));
        continue;
      }
      const rowSource = result.source ?? "alphavantage";
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
            ":source": rowSource,
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
      if (rowSource === "alphavantage") {
        await new Promise((r) => setTimeout(r, 13000)); // Free tier: 5 calls/min
      }
    }
  };
}
