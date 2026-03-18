/**
 * Health and connectivity API routes.
 * GET /health — liveness; GET /gemini-test — Gemini API connectivity.
 */

import { Router, Request, Response } from "express";
import { generateText } from "../services/gemini";

export function createHealthRouter(): Router {
  const router = Router();

  router.get("/health", (req: Request, res: Response) => {
    res.json({ status: "ARIA online", timestamp: new Date().toISOString() });
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

  return router;
}
