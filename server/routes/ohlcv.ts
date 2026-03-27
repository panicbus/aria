/**
 * OHLCV API routes.
 * GET /status — ticker counts and watched list; GET /:symbol — historical bars;
 * POST /refresh-all — background refresh; POST /refresh/:symbol — single ticker refresh.
 */

import { Router, Request, Response } from "express";
import { fetchOHLCVForTicker } from "../services/ohlcv";
import { mergeLivePriceIntoBars } from "../utils/mergeOhlcvLivePrice";

type DbContext = {
  db: import("sql.js").Database;
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
  saveDb: () => void;
  getWatchedTickers: () => string[];
  fetchAndStoreOHLCV: () => Promise<void>;
  cryptoIds: Record<string, string>;
};

/** Safe ticker for OHLCV path/SQL (letters, digits, dot only). */
function normalizeOhlcvSymbol(raw: string): string | null {
  const s = String(raw || "").toUpperCase().trim();
  if (!/^[A-Z0-9.]{1,10}$/.test(s)) return null;
  return s;
}

function sqlQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/** Symbol may be refreshed if it appears in watchlist, prices, portfolio, or position_* memories (sidebar holdings). */
function symbolTrackedForOhlcvRefresh(symbol: string, execAll: DbContext["execAll"], getWatchedTickers: () => string[]): boolean {
  if (getWatchedTickers().includes(symbol)) return true;
  const e = sqlQuote(symbol);
  if (execAll<{ x: number }>(`SELECT 1 AS x FROM prices WHERE upper(symbol) = '${e}' LIMIT 1`).length) return true;
  if (execAll<{ x: number }>(`SELECT 1 AS x FROM crypto_portfolio WHERE upper(symbol) = '${e}' LIMIT 1`).length) return true;
  const posRows = execAll<{ key: string; value: string }>("SELECT key, value FROM memories WHERE key LIKE 'position_%'");
  for (const row of posRows) {
    const tickerFromKey = row.key.replace(/^position_/i, "").toUpperCase();
    if (!/^[A-Z0-9.]{1,6}$/.test(tickerFromKey) || tickerFromKey.includes("_")) continue;
    let t = tickerFromKey;
    try {
      const pos = JSON.parse(row.value) as { ticker?: string };
      t = (pos?.ticker ?? tickerFromKey).toUpperCase();
    } catch (_) {
      /* use tickerFromKey */
    }
    if (t === symbol) return true;
  }
  return false;
}

export function createOhlcvRouter(ctx: DbContext): Router {
  const router = Router();
  const { db, execAll, saveDb, getWatchedTickers, fetchAndStoreOHLCV, cryptoIds } = ctx;

  // WAYPOINT [ohlcv-api]
  // WHAT: GET /:symbol?days=90 returns historical OHLCV for a ticker, sorted by date desc.
  // WHY: Frontend chart and backtest need historical bars; this serves them from the local DB.

  router.get("/status", (req: Request, res: Response) => {
    if (!db) return res.json({ tickers: {} });
    const rows = execAll<{ symbol: string; cnt: number }>(
      "SELECT symbol, COUNT(*) AS cnt FROM ohlcv GROUP BY symbol"
    );
    const tickers: Record<string, number> = {};
    for (const r of rows) tickers[r.symbol] = r.cnt;
    res.json({ tickers, watched: getWatchedTickers() });
  });

  router.get("/:symbol", (req: Request, res: Response) => {
    const symbol = normalizeOhlcvSymbol(String(req.params.symbol || ""));
    const days = Math.min(365, Math.max(1, parseInt(String(req.query.days || 90), 10) || 90));
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    // No "watched only" gate: after DB reset, holdings charts must load bars if present (may be [] until refresh).
    const rows = execAll<{ date: string; open: number; high: number; low: number; close: number; volume: number }>(
      `SELECT date, open, high, low, close, volume FROM ohlcv WHERE symbol = '${sqlQuote(symbol)}' ORDER BY date DESC LIMIT ${days}`
    );
    const chronological = rows.reverse();
    const liveRow = execAll<{ price: number; updated_at: string }>(
      `SELECT price, updated_at FROM prices WHERE upper(symbol) = '${sqlQuote(symbol)}' LIMIT 1`
    )[0];
    res.json(mergeLivePriceIntoBars(chronological, liveRow));
  });

  router.post("/refresh-all", (req: Request, res: Response) => {
    res.status(202).json({ message: "OHLCV refresh started in background (takes ~13s per ticker)" });
    fetchAndStoreOHLCV().catch((err) => console.error("OHLCV refresh-all failed:", err));
  });

  router.post("/refresh/:symbol", async (req: Request, res: Response) => {
    const symbol = normalizeOhlcvSymbol(String(req.params.symbol || ""));
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    if (!symbolTrackedForOhlcvRefresh(symbol, execAll, getWatchedTickers)) {
      return res.status(400).json({
        error: `${symbol} is not linked to your watchlist, holdings, or dashboard prices. Add the ticker to Memory (watchlist or position) or wait for prices to sync.`,
      });
    }
    try {
      const result = await fetchOHLCVForTicker(symbol, { cryptoIds });
      if (!result.rows.length) {
        return res.status(502).json({
          error: "No OHLCV data stored",
          detail: result.detail ?? "No rows returned (check ALPHAVANTAGE_API_KEY on Fly, rate limits, or symbol).",
        });
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
      saveDb();
      res.json({ ok: true, symbol, rows: result.rows.length, source: rowSource, note: result.detail });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: "Refresh failed", detail: msg });
    }
  });

  return router;
}
