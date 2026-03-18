/**
 * Briefings API routes.
 * GET / — list recent; POST /generate — morning briefing; POST /generate-evening — evening briefing.
 */

import { Router, Request, Response } from "express";

type BriefingRow = { id: number; content: string; created_at: string; type: "morning" | "evening" };

type DbContext = {
  db: import("sql.js").Database;
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
  saveDb: () => void;
  generateBriefing: () => Promise<BriefingRow | null>;
  generateEveningBriefing: () => Promise<BriefingRow | null>;
  sendBriefingEmail: (content: string, subject: string) => Promise<boolean>;
};

export function createBriefingsRouter(ctx: DbContext): Router {
  const router = Router();
  const { db, execAll, saveDb, generateBriefing, generateEveningBriefing, sendBriefingEmail } = ctx;

  router.get("/", (req: Request, res: Response) => {
    const briefings = execAll<BriefingRow>(
      "SELECT id, content, created_at, type FROM briefings ORDER BY created_at DESC LIMIT 30"
    );
    res.json(briefings);
  });

  router.delete("/", (req: Request, res: Response) => {
    db.run("DELETE FROM briefings");
    saveDb();
    res.json({ cleared: true });
  });

  router.post("/generate", async (req: Request, res: Response) => {
    try {
      const briefing = await generateBriefing();
      if (!briefing) {
        return res.status(500).json({ error: "Failed to generate briefing" });
      }
      res.json(briefing);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Briefing generation error:", message);
      const hint =
        message.toLowerCase().includes("connection") || message.toLowerCase().includes("econnrefused")
          ? " — Check your network, firewall, or proxy. If behind a VPN/corporate proxy, it may be blocking the Gemini API."
          : "";
      res.status(500).json({ error: "Briefing generation error", detail: message + hint });
    }
  });

  router.post("/generate-evening", async (req: Request, res: Response) => {
    try {
      const briefing = await generateEveningBriefing();
      if (!briefing) {
        return res.status(500).json({ error: "Failed to generate evening briefing" });
      }
      const sent = await sendBriefingEmail(briefing.content, `ARIA Evening Briefing — ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}`);
      res.json({ ...briefing, email_sent: sent });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Evening briefing error:", message);
      res.status(500).json({ error: "Evening briefing failed", detail: message });
    }
  });

  return router;
}
