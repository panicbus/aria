/**
 * Portfolio API routes.
 * Phase 6a — Real Portfolio: Crypto
 * GET /crypto, GET /summary, GET /aria-take, POST /refresh
 */

import { Router, Request, Response } from "express";
import type Anthropic from "@anthropic-ai/sdk";

type CryptoPortfolioRow = {
  symbol: string;
  quantity: number;
  cost_basis: number;
  average_buy_price: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  buying_power: number | null;
  portfolio_value: number | null;
  source: string;
  updated_at: string;
};

type PortfolioDeps = {
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
  refreshCryptoPortfolio: () => Promise<void>;
  anthropic: Anthropic;
};

let ariaTakeCache: { btc: string; eth: string } | null = null;
let ariaTakeCacheAt = 0;
const ARIA_TAKE_CACHE_MS = 15 * 60 * 1000;

export function createPortfolioRouter(deps: PortfolioDeps): Router {
  const router = Router();
  const { execAll, refreshCryptoPortfolio, anthropic } = deps;

  router.get("/crypto", (req: Request, res: Response) => {
    const rows = execAll<CryptoPortfolioRow>(
      "SELECT symbol, quantity, cost_basis, average_buy_price, current_price, market_value, unrealized_pnl, unrealized_pnl_pct, buying_power, portfolio_value, source, updated_at FROM crypto_portfolio ORDER BY symbol"
    );
    res.json(rows);
  });

  router.get("/summary", (req: Request, res: Response) => {
    const credentialsConfigured = !!(
      process.env.ROBINHOOD_API_KEY?.trim() && process.env.ROBINHOOD_PRIVATE_KEY?.trim()
    );
    const rows = execAll<CryptoPortfolioRow>("SELECT * FROM crypto_portfolio ORDER BY symbol");
    const totalCryptoValue = rows.reduce((s, r) => s + Number(r.market_value || 0), 0);
    const totalCostBasis = rows.reduce((s, r) => s + Number(r.cost_basis || 0), 0);
    const totalUnrealizedPnl = rows.reduce((s, r) => s + Number(r.unrealized_pnl || 0), 0);
    const totalUnrealizedPnlPct = totalCostBasis > 0 ? (totalUnrealizedPnl / totalCostBasis) * 100 : 0;
    const buyingPower = rows[0]?.buying_power ?? 0;
    const lastUpdated = rows[0]?.updated_at ?? null;
    const dataSource = rows.some((r) => r.source === "robinhood_stale") ? "robinhood_stale" : rows[0]?.source ?? "none";

    res.json({
      total_crypto_value: totalCryptoValue,
      total_unrealized_pnl: totalUnrealizedPnl,
      total_unrealized_pnl_pct: totalUnrealizedPnlPct,
      buying_power: buyingPower,
      holdings: rows,
      last_updated: lastUpdated,
      data_source: dataSource,
      credentials_configured: credentialsConfigured,
    });
  });

  router.get("/aria-take", async (req: Request, res: Response) => {
    const now = Date.now();
    if (ariaTakeCache && now - ariaTakeCacheAt < ARIA_TAKE_CACHE_MS) {
      return res.json(ariaTakeCache);
    }

    const rows = execAll<CryptoPortfolioRow>("SELECT * FROM crypto_portfolio ORDER BY symbol");
    if (!rows.length) {
      return res.json({
        btc: "ARIA doesn't have real position data yet. Add your Robinhood API credentials to .env to see your live crypto portfolio.",
        eth: "",
      });
    }

    const riskMem = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'risk_tolerance' LIMIT 1");
    const riskTolerance = riskMem[0]?.value ?? "moderate";

    const portfolioBlock = rows
      .map(
        (r) =>
          `${r.symbol}: ${r.quantity} @ avg $${r.average_buy_price} | now $${r.current_price} | P&L $${r.unrealized_pnl} (${r.unrealized_pnl_pct}%) | value $${r.market_value}`
      )
      .join("\n");

    const signals = execAll<{ ticker: string; signal: string; reasoning: string | null }>(
      "SELECT ticker, signal, reasoning FROM signals ORDER BY created_at DESC LIMIT 10"
    );
    const signalsBlock = signals.map((s) => `${s.ticker}: ${s.signal} — ${s.reasoning ?? ""}`).join("\n");

    const prompt = `You are ARIA, Nico's trading assistant. Given his real crypto portfolio and current signals, give a 2-3 sentence "ARIA's take" for each asset he owns. Be specific about his P&L and what he might consider. Risk tolerance: ${riskTolerance}.

CRYPTO PORTFOLIO (Robinhood):
${portfolioBlock}

LATEST SIGNALS:
${signalsBlock}

Respond with JSON only: { "btc": "2-3 sentences for BTC", "eth": "2-3 sentences for ETH" }
If he doesn't own an asset, use "" for that key.`;

    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      });
      const textBlock = (response.content as any[]).find((c: any) => c.type === "text");
      const text = textBlock?.text ?? "{}";
      const json = JSON.parse(text.replace(/```json?\s*|\s*```/g, "").trim() || "{}");
      ariaTakeCache = { btc: json.btc ?? "", eth: json.eth ?? "" };
      ariaTakeCacheAt = now;
      res.json(ariaTakeCache);
    } catch (e) {
      console.warn("ARIA take error:", e);
      res.json({
        btc: "Unable to generate ARIA's take right now. Try again in a moment.",
        eth: "",
      });
    }
  });

  router.post("/refresh", async (req: Request, res: Response) => {
    try {
      await refreshCryptoPortfolio();
      const rows = execAll<CryptoPortfolioRow>("SELECT * FROM crypto_portfolio ORDER BY symbol");
      const totalCryptoValue = rows.reduce((s, r) => s + Number(r.market_value || 0), 0);
      const totalUnrealizedPnl = rows.reduce((s, r) => s + Number(r.unrealized_pnl || 0), 0);
      const costTotal = rows.reduce((s, r) => s + Number(r.cost_basis || 0), 0);
      const dataSource = rows.some((r) => r.source === "robinhood_stale") ? "robinhood_stale" : rows[0]?.source ?? "none";
      res.json({
        total_crypto_value: totalCryptoValue,
        total_unrealized_pnl: totalUnrealizedPnl,
        total_unrealized_pnl_pct: costTotal > 0 ? (totalUnrealizedPnl / costTotal) * 100 : 0,
        buying_power: rows[0]?.buying_power ?? 0,
        holdings: rows,
        last_updated: rows[0]?.updated_at ?? new Date().toISOString(),
        data_source: dataSource,
        credentials_configured: !!(process.env.ROBINHOOD_API_KEY?.trim() && process.env.ROBINHOOD_PRIVATE_KEY?.trim()),
      });
    } catch (e) {
      res.status(500).json({ error: "Refresh failed" });
    }
  });

  return router;
}
