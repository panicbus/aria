/**
 * Signals API routes.
 * POST / — save a signal; GET / — list recent signals with indicator_data and risk_context.
 */

import { Router, Request, Response } from "express";

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
  run: (sql: string, params?: Record<string, string | number | null>) => { lastInsertRowid: number };
  saveDb: () => void;
  getRiskContextForTicker: (ticker: string, signal?: string, indicatorData?: { score?: number } | null) => RiskContext;
  generateSignals?: () => void;
};

export function createSignalsRouter(ctx: DbContext): Router {
  const router = Router();
  const { execAll, run, saveDb, getRiskContextForTicker, generateSignals } = ctx;

  router.post("/", (req: Request, res: Response) => {
    const { ticker, signal, reasoning, price } = req.body;
    const result = run(
      "INSERT INTO signals (ticker, signal, reasoning, price) VALUES (:ticker, :signal, :reasoning, :price)",
      {
        ":ticker": ticker,
        ":signal": signal,
        ":reasoning": reasoning ?? null,
        ":price": price ?? null,
      }
    );
    saveDb();
    res.json({ id: result.lastInsertRowid });
  });

  router.get("/", (req: Request, res: Response) => {
    const rows = execAll<{ id: number; ticker: string; signal: string; reasoning: string; price: number; created_at: string; indicator_data: string | null }>(
      "SELECT id, ticker, signal, reasoning, price, created_at, indicator_data FROM signals ORDER BY created_at DESC LIMIT 20"
    );
    const signals = rows.map((s) => {
      let ind: { score?: number } | null = null;
      if (s.indicator_data) {
        try {
          ind = JSON.parse(s.indicator_data);
        } catch (_) {}
      }
      return {
        ...s,
        indicator_data: ind,
        risk_context: getRiskContextForTicker(s.ticker, s.signal, ind),
      };
    });
    res.json(signals);
  });

  router.post("/generate", (_req: Request, res: Response) => {
    if (!generateSignals) {
      return res.status(501).json({ error: "Signal generation not configured" });
    }
    generateSignals();
    res.json({ ok: true, message: "Signals generated from watched tickers" });
  });

  return router;
}
