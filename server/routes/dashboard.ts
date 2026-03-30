/**
 * Dashboard API routes.
 * GET /prices — latest prices; GET /news — HN headlines; GET /dashboard — aggregate (prices + news + signals).
 * GET /dashboard/market-pulse — dynamic ticker list for sidebar (market context + holdings + watchlist).
 */

import { Router, Request, Response } from "express";
import { parseWatchlistValue } from "../utils/watchlist";

type PriceRow = { symbol: string; price: number; change_24h: number | null; source: string; updated_at: string };
type NewsRow = { id: number; title: string; url: string | null; source: string; created_at: string; summary?: string | null };
type RiskContext = {
  suggested_position_size_pct: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  risk_reward_ratio: number;
  confidence: string;
  warning?: string;
};

type DbContext = {
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
  getWatchedTickers: () => string[];
  getRiskContextForTicker: (ticker: string, signal?: string, indicatorData?: { score?: number } | null) => RiskContext;
};

type MarketPulseEntry = { ticker: string; category: "market_context" | "holding" | "watchlist" };

// WAYPOINT: Market Pulse Dynamic Tickers
// WHAT: Builds the market pulse ticker list from memory (position_*, watchlist_core, watchlist_speculative).
// WHY: Sidebar should always reflect current portfolio and watchlist.
// HOW IT HELPS NICO: No manual updates needed when positions or watchlist change via chat.
function buildMarketPulseTickers(execAll: DbContext["execAll"]): MarketPulseEntry[] {
  const MARKET_CONTEXT = ["SPY", "BTC", "ETH"];
  const seen = new Set<string>(MARKET_CONTEXT);
  const result: MarketPulseEntry[] = MARKET_CONTEXT.map((t) => ({ ticker: t, category: "market_context" as const }));

  // Holdings from position_*
  const posRows = execAll<{ key: string; value: string }>("SELECT key, value FROM memories WHERE key LIKE 'position_%'");
  for (const r of posRows) {
    try {
      const t = (JSON.parse(r.value) as { ticker?: string })?.ticker?.toUpperCase();
      if (t && !seen.has(t)) {
        seen.add(t);
        result.push({ ticker: t, category: "holding" });
      }
    } catch (_) {}
  }

  // Watchlist: core first, then speculative — use parseWatchlistValue for robust parsing (handles ["IGPT"] etc.)
  const core = parseWatchlistValue(execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist_core' LIMIT 1")[0]?.value);
  const spec = parseWatchlistValue(execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist_speculative' LIMIT 1")[0]?.value);
  const legacy = parseWatchlistValue(execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist' LIMIT 1")[0]?.value);
  const watchlistAll = [...core, ...spec.filter((t) => !core.includes(t)), ...legacy.filter((t) => !core.includes(t) && !spec.includes(t))];
  for (const t of watchlistAll) {
    if (!seen.has(t)) {
      seen.add(t);
      result.push({ ticker: t, category: "watchlist" });
    }
  }

  return result.slice(0, 30);
}

export function createDashboardRouter(ctx: DbContext): Router {
  const router = Router();
  const { execAll, getWatchedTickers, getRiskContextForTicker } = ctx;

  router.get("/prices", (req: Request, res: Response) => {
    const prices = execAll<PriceRow>("SELECT symbol, price, change_24h, source, updated_at FROM prices ORDER BY symbol");
    res.json(prices);
  });

  router.get("/news", (req: Request, res: Response) => {
    const daysParam = parseInt(String(req.query.days || ""), 10);
    const days = daysParam > 0 ? Math.min(daysParam, 30) : 15;
    const sql = `SELECT id, title, url, source, created_at, summary FROM news WHERE created_at >= date('now', '-${days} days') ORDER BY created_at DESC`;
    const news = execAll<NewsRow>(sql);
    res.json(news);
  });

  router.get("/dashboard", (req: Request, res: Response) => {
    const pulseEntries = buildMarketPulseTickers(execAll);
    const tickers = pulseEntries.map((e) => e.ticker);
    const allPrices = execAll<PriceRow>("SELECT symbol, price, change_24h, source, updated_at FROM prices ORDER BY symbol");
    const prices = tickers.length > 0 ? allPrices.filter((p) => tickers.includes(p.symbol)) : allPrices;
    const news = execAll<NewsRow>("SELECT id, title, url, source, created_at, summary FROM news ORDER BY created_at DESC LIMIT 10");
    const signals = execAll<{ ticker: string; signal: string; reasoning: string; price: number; created_at: string; indicator_data: string | null }>(
      "SELECT ticker, signal, reasoning, price, created_at, indicator_data FROM signals ORDER BY created_at DESC LIMIT 50"
    );
    const byTicker = new Map<string, { signal: string; reasoning: string; price: number; indicator_data?: unknown; risk_context: RiskContext }>();
    for (const s of signals) {
      if (!byTicker.has(s.ticker)) {
        let ind: { score?: number } | null = null;
        if (s.indicator_data) {
          try {
            ind = JSON.parse(s.indicator_data);
          } catch (_) {}
        }
        byTicker.set(s.ticker, {
          signal: s.signal,
          reasoning: s.reasoning,
          price: s.price,
          indicator_data: ind,
          risk_context: getRiskContextForTicker(s.ticker, s.signal, ind),
        });
      }
    }
    res.json({ prices, news, tickers: tickers.length > 0 ? tickers : getWatchedTickers(), signalsByTicker: Object.fromEntries(byTicker) });
  });

  // WAYPOINT: Market Health Endpoint
  // WHAT: Returns 4 market health tickers + top 3 scanner picks for the sidebar.
  // WHY: Sidebar shows broad market sentiment and ARIA's best current ideas at a glance.
  // HOW IT HELPS NICO: Instant read on market fear, tech health, and today's scanner picks.
  const MARKET_HEALTH = ["SPY", "QQQ", "BTC", "VIX"];

  router.get("/dashboard/market-pulse", (req: Request, res: Response) => {
    const priceRows = execAll<PriceRow>("SELECT symbol, price, change_24h, source, updated_at FROM prices ORDER BY updated_at DESC");
    const signalRows = execAll<{ ticker: string; signal: string; indicator_data: string | null }>(
      "SELECT ticker, signal, indicator_data FROM signals ORDER BY created_at DESC"
    );
    const bySymbolPrice = new Map<string, PriceRow>();
    for (const p of priceRows) {
      if (!bySymbolPrice.has(p.symbol)) bySymbolPrice.set(p.symbol, p);
    }
    const bySymbolSignal = new Map<string, { signal: string; indicator_data: string | null }>();
    for (const s of signalRows) {
      if (!bySymbolSignal.has(s.ticker)) bySymbolSignal.set(s.ticker, { signal: s.signal, indicator_data: s.indicator_data });
    }

    const enrichTicker = (sym: string) => {
      const p = bySymbolPrice.get(sym);
      const sig = bySymbolSignal.get(sym);
      let ind: { score?: number; rsi?: number } | null = null;
      if (sig?.indicator_data) {
        try { ind = JSON.parse(sig.indicator_data); } catch (_) {}
      }
      return {
        symbol: sym,
        price: p?.price ?? null,
        change_24h: p?.change_24h ?? null,
        signal: sig?.signal ?? null,
        score: ind?.score ?? null,
        rsi: ind?.rsi ?? null,
        updated_at: p?.updated_at ?? null,
      };
    };

    const marketHealth = MARKET_HEALTH.map(enrichTicker);

    const scannerPicks = execAll<{
      symbol: string; signal: string; score: number; rsi: number | null;
      aria_reasoning: string | null; category: string; scanned_at: string;
    }>(
      `SELECT symbol, signal, score, rsi, aria_reasoning, category, scanned_at
       FROM scanner_results
       WHERE aria_reasoning IS NOT NULL AND aria_reasoning != ''
         AND scanned_at >= datetime('now', '-2 days')
       ORDER BY score DESC
       LIMIT 3`
    ).map((r) => {
      const p = bySymbolPrice.get(r.symbol);
      return {
        symbol: r.symbol,
        signal: r.signal,
        score: r.score,
        rsi: r.rsi,
        aria_reasoning: r.aria_reasoning,
        category: r.category,
        price: p?.price ?? null,
        change_24h: p?.change_24h ?? null,
      };
    });

    res.json({ marketHealth, scannerPicks });
  });

  router.get("/stock-news", (req: Request, res: Response) => {
    const days = Math.min(30, Math.max(1, parseInt(String(req.query.days || 5), 10) || 5));
    const rows = execAll<{
      id: number; ticker: string; title: string; url: string;
      summary: string | null; source: string; published_at: string; created_at: string;
    }>(
      `SELECT id, ticker, title, url, summary, source, published_at, created_at
       FROM stock_news
       WHERE published_at >= datetime('now', '-${days} days')
       ORDER BY published_at DESC
       LIMIT 60`
    );
    res.json(rows);
  });

  return router;
}
