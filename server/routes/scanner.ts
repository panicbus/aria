/**
 * Scanner API routes.
 * GET /universe — active universe; GET /results — scan results;
 * GET /status — last scan, scanning state; POST /run — trigger scan (async);
 * GET /company/:symbol — company name from Finnhub (for any ticker).
 */

import { Router, Request, Response } from "express";

type ScannerRouterDeps = {
  getActiveUniverse: () => Promise<Array<{ symbol: string; category: string }>>;
  triggerScan: () => void;
  getResults: () => Array<Record<string, unknown>>;
  getStatus: () => { lastScan: string | null; tickersScanned: number; scanning: boolean; apiCallsRemaining: number; universeSize: number };
};

export function createScannerRouter(deps: ScannerRouterDeps): Router {
  const router = Router();
  const { getActiveUniverse, triggerScan, getResults, getStatus } = deps;

  router.get("/company/:symbol", async (req: Request, res: Response) => {
    const symbol = (req.params.symbol ?? "").toUpperCase();
    if (!symbol) return res.status(400).json({ error: "Symbol required" });
    const key = process.env.FINNHUB_API_KEY?.trim();
    if (!key) return res.json({ name: symbol });
    try {
      const r = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${key}`);
      const data = (await r.json()) as { name?: string };
      res.json({ name: data?.name ?? symbol });
    } catch {
      res.json({ name: symbol });
    }
  });

  router.get("/universe", async (req: Request, res: Response) => {
    try {
      const universe = await getActiveUniverse();
      res.json(universe);
    } catch (e) {
      console.error("Scanner universe error:", e);
      res.status(500).json({ error: "Failed to get scanner universe" });
    }
  });

  router.get("/results", (req: Request, res: Response) => {
    const results = getResults();
    res.json(results);
  });

  router.get("/status", (req: Request, res: Response) => {
    const status = getStatus();
    res.json(status);
  });

  router.post("/run", (req: Request, res: Response) => {
    triggerScan();
    res.json({ status: "scanning" });
  });

  return router;
}
