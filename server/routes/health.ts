/**
 * Health and connectivity API routes.
 * GET /health — liveness; GET /gemini-test — Gemini API connectivity;
 * GET /debug — persistence debug (DATA_DIR, message count, db exists).
 */

import { Router, Request, Response } from "express";
import * as fs from "fs";
import { generateText } from "../services/gemini";

type HealthDeps = {
  dataDir: string;
  dbPath: string;
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
};

export function createHealthRouter(deps?: HealthDeps): Router {
  const router = Router();

  router.get("/health", (req: Request, res: Response) => {
    res.json({ status: "ARIA online", timestamp: new Date().toISOString() });
  });

  router.get("/debug", (req: Request, res: Response) => {
    if (!deps) return res.json({ error: "Debug not configured" });
    const { dataDir, dbPath, execAll } = deps;
    const dbExists = fs.existsSync(dbPath);
    let messageCount = 0;
    try {
      const rows = execAll<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM messages");
      messageCount = rows[0]?.cnt ?? 0;
    } catch (_) {}
    const dataDirExists = fs.existsSync(dataDir);
    let ohlcvSymbols: Record<string, number> = {};
    try {
      const rows = execAll<{ symbol: string; cnt: number }>(
        "SELECT symbol, COUNT(*) AS cnt FROM ohlcv GROUP BY symbol"
      );
      for (const r of rows) ohlcvSymbols[r.symbol] = r.cnt;
    } catch (_) {}

    res.json({
      dataDir,
      dbPath,
      dataDirExists,
      dbExists,
      messageCount,
      alphavantageConfigured: !!process.env.ALPHAVANTAGE_API_KEY?.trim(),
      ohlcvSymbols,
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/gemini-test", async (req: Request, res: Response) => {
    if (!process.env.GEMINI_API_KEY?.trim()) {
      return res.status(500).json({ ok: false, error: "GEMINI_API_KEY not set" });
    }
    try {
      const text = await generateText("Say 'ok' only.");
      res.json({ ok: true, reply: text.trim() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Gemini test error:", msg);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // Web search (Tavily) status — helps debug "web search encountering an issue"
  router.get("/web-search-status", async (req: Request, res: Response) => {
    const key = process.env.TAVILY_API_KEY?.trim();
    const configured = !!key;
    const keyPreview = configured ? `${key.slice(0, 8)}...${key.slice(-4)}` : null;

    if (!configured) {
      return res.json({
        configured: false,
        error: "TAVILY_API_KEY not set. Add to .env (local) or flyctl secrets set TAVILY_API_KEY=... (production).",
        keyPreview: null,
      });
    }

    try {
      const resTavily = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ query: "test", search_depth: "basic", max_results: 1 }),
      });
      const data = (await resTavily.json()) as { results?: unknown[]; error?: string };
      if (!resTavily.ok) {
        const errMsg = data?.error ?? `Tavily API ${resTavily.status}`;
        return res.json({
          configured: true,
          keyPreview,
          testOk: false,
          error: errMsg,
          hint: resTavily.status === 401 ? "Invalid or expired API key. Check https://tavily.com" : resTavily.status === 429 ? "Rate limit exceeded. Free tier: 1K searches/month." : undefined,
        });
      }
      res.json({
        configured: true,
        keyPreview,
        testOk: true,
        resultsCount: (data.results ?? []).length,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return res.json({
        configured: true,
        keyPreview,
        testOk: false,
        error: msg,
        hint: "Network error — check connectivity or firewall.",
      });
    }
  });

  return router;
}
