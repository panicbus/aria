/**
 * Signal generation: technical composite (RSI+MACD+MAs) when ≥50 days OHLCV;
 * 24h momentum fallback otherwise.
 */

import { computeIndicatorsForCloses, scoreToSignal } from "./indicators";

type PriceRow = { symbol: string; price: number; change_24h: number | null; source: string; updated_at?: string };

type SignalDeps = {
  db: import("sql.js").Database | null;
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
  run: (sql: string, params?: Record<string, string | number | null>) => { lastInsertRowid: number };
  saveDb: () => void;
  getWatchedTickers: () => string[];
};

export function createGenerateSignals(deps: SignalDeps): () => void {
  const { db, execAll, run, saveDb, getWatchedTickers } = deps;

  return function generateSignals(): void {
    if (!db) return;
    const tickers = getWatchedTickers();
    const priceRows = execAll<PriceRow>("SELECT symbol, price, change_24h, source FROM prices ORDER BY updated_at DESC");
    const bySymbol = new Map<string, PriceRow>();
    for (const r of priceRows) {
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, r);
    }

    let inserted = 0;
    for (const symbol of tickers) {
      const r = bySymbol.get(symbol);
      if (!r) continue;
      const price = Number(r.price);
      const ohlcvRows = execAll<{ close: number }>(
        `SELECT close FROM ohlcv WHERE symbol = '${symbol}' ORDER BY date ASC`
      );
      const closes = ohlcvRows.map((row) => Number(row.close));

      let signal: string;
      let reasoning: string;
      let indicatorDataJson: string | null = null;

      const ind = computeIndicatorsForCloses(closes);
      if (ind && closes.length >= 50) {
        const res = scoreToSignal(ind.score);
        signal = res.signal;
        reasoning = res.reasoning;
        indicatorDataJson = JSON.stringify(ind);
      } else {
        const change = r.change_24h ?? 0;
        if (change >= 5) {
          signal = "WATCH";
          reasoning = `24h up ${change.toFixed(1)}%; momentum. Limited OHLCV data — using 24h fallback.`;
        } else if (change <= -5) {
          signal = "WATCH";
          reasoning = `24h down ${Math.abs(change).toFixed(1)}%; potential dip. Limited OHLCV data — using 24h fallback.`;
        } else if (change >= 2) {
          signal = "BUY";
          reasoning = `Up ${change.toFixed(1)}% 24h; trend positive. Limited OHLCV data — using 24h fallback.`;
        } else if (change <= -2) {
          signal = "SELL";
          reasoning = `Down ${Math.abs(change).toFixed(1)}% 24h; consider trimming. Limited OHLCV data — using 24h fallback.`;
        } else {
          signal = "HOLD";
          reasoning = `Flat 24h (${change.toFixed(1)}%). Limited OHLCV data — using 24h fallback.`;
        }
      }

      run(
        "INSERT INTO signals (ticker, signal, reasoning, price, indicator_data) VALUES (:ticker, :signal, :reasoning, :price, :indicator_data)",
        {
          ":ticker": symbol,
          ":signal": signal,
          ":reasoning": reasoning,
          ":price": price,
          ":indicator_data": indicatorDataJson,
        }
      );
      inserted++;
    }
    if (inserted) saveDb();
  };
}

export function createGenerateSignalForTicker(deps: SignalDeps): (ticker: string) => Promise<{
  id: number;
  ticker: string;
  signal: string;
  reasoning: string;
  price: number;
  indicator_data: string | null;
} | null> {
  const { db, execAll, run, saveDb } = deps;

  return async function generateSignalForTicker(ticker: string) {
    if (!db) return null;
    const symbol = ticker.toUpperCase();
    const all = execAll<PriceRow>(
      "SELECT symbol, price, change_24h, source, updated_at FROM prices ORDER BY updated_at DESC"
    );
    const target = all.find((p) => p.symbol.toUpperCase() === symbol);
    if (!target) return null;

    const price = Number(target.price);
    const ohlcvRows = execAll<{ close: number }>(
      `SELECT close FROM ohlcv WHERE symbol = '${symbol}' ORDER BY date ASC`
    );
    const closes = ohlcvRows.map((row) => Number(row.close));

    let signal: string;
    let reasoning: string;
    let indicatorDataJson: string | null = null;

    const ind = computeIndicatorsForCloses(closes);
    if (ind && closes.length >= 50) {
      const res = scoreToSignal(ind.score);
      signal = res.signal;
      reasoning = res.reasoning;
      indicatorDataJson = JSON.stringify(ind);
    } else {
      const change = target.change_24h ?? 0;
      if (change >= 5) {
        signal = "WATCH";
        reasoning = `24h up ${change.toFixed(1)}%; momentum. Limited OHLCV data — using 24h fallback.`;
      } else if (change <= -5) {
        signal = "WATCH";
        reasoning = `24h down ${Math.abs(change).toFixed(1)}%; potential dip. Limited OHLCV data — using 24h fallback.`;
      } else if (change >= 2) {
        signal = "BUY";
        reasoning = `Up ${change.toFixed(1)}% 24h; trend positive. Limited OHLCV data — using 24h fallback.`;
      } else if (change <= -2) {
        signal = "SELL";
        reasoning = `Down ${Math.abs(change).toFixed(1)}% 24h; consider trimming. Limited OHLCV data — using 24h fallback.`;
      } else {
        signal = "HOLD";
        reasoning = `Flat 24h (${change.toFixed(1)}%). Limited OHLCV data — using 24h fallback.`;
      }
    }

    const result = run(
      "INSERT INTO signals (ticker, signal, reasoning, price, indicator_data) VALUES (:ticker, :signal, :reasoning, :price, :indicator_data)",
      {
        ":ticker": symbol,
        ":signal": signal,
        ":reasoning": reasoning,
        ":price": price,
        ":indicator_data": indicatorDataJson,
      }
    );
    saveDb();

    return { id: result.lastInsertRowid, ticker: symbol, signal, reasoning, price, indicator_data: indicatorDataJson };
  };
}
