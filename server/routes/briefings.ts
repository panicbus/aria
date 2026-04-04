/**
 * Briefings API routes.
 * GET / — list recent; POST /generate — morning briefing; POST /generate-evening — evening briefing.
 */

import { Router, Request, Response } from "express";
import { sendBriefingLayoutPreviewEmail, type BriefingGenerationResult } from "../services/briefings";

type BriefingRow = { id: number; content: string; created_at: string; type: "morning" | "evening" };

type DbContext = {
  db: import("sql.js").Database;
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
  saveDb: () => void;
  generateBriefing: () => Promise<BriefingGenerationResult | null>;
  generateEveningBriefing: () => Promise<BriefingGenerationResult | null>;
  sendBriefingEmail: (
    content: string,
    subject: string,
    portfolioHtml?: string,
    stocksNewsHtml?: string,
    plainTextBody?: string,
  ) => Promise<boolean>;
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

  // GET /api/briefings/status — debug: cron schedule, last runs, email config, server time
  router.get("/status", (req: Request, res: Response) => {
    const TZ = "America/Los_Angeles";
    const now = new Date();
    const nowPacific = now.toLocaleString("en-US", { timeZone: TZ });
    const hour24 = now.toLocaleString("en-US", { timeZone: TZ, hour: "2-digit", hour12: false });
    const weekday = now.toLocaleString("en-US", { timeZone: TZ, weekday: "short" });

    const lastMorning = execAll<{ created_at: string }>("SELECT created_at FROM briefings WHERE type = 'morning' ORDER BY id DESC LIMIT 1");
    const lastEvening = execAll<{ created_at: string }>("SELECT created_at FROM briefings WHERE type = 'evening' ORDER BY id DESC LIMIT 1");

    const to = !!process.env.BRIEFING_EMAIL_TO?.trim();
    const smtpOk = !!process.env.SMTP_HOST?.trim() && !!process.env.SMTP_USER?.trim() && !!process.env.SMTP_PASS?.trim();
    const emailConfigured = to && smtpOk;

    res.json({
      schedule: {
        morning: "7:00 Pacific, Mon–Fri",
        evening: "20:00 (8pm) Pacific, Mon–Fri",
      },
      serverTime: {
        utc: now.toISOString(),
        pacific: nowPacific,
        pacificHour: hour24,
        weekday,
      },
      lastMorning: lastMorning[0]?.created_at ?? null,
      lastEvening: lastEvening[0]?.created_at ?? null,
      email: {
        configured: emailConfigured,
        to: to ? "set" : "missing BRIEFING_EMAIL_TO",
        smtp: smtpOk ? "ok" : "missing SMTP_HOST/USER/PASS",
      },
      hint: !emailConfigured
        ? "Briefings generate but won't email. Set BRIEFING_EMAIL_TO + SMTP_* via flyctl secrets."
        : undefined,
    });
  });

  // GET /api/briefings/email-test — send a test email to verify SMTP config
  router.get("/email-test", async (req: Request, res: Response) => {
    const to = process.env.BRIEFING_EMAIL_TO?.trim();
    const host = process.env.SMTP_HOST?.trim();
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASS?.trim();
    const missing = [];
    if (!to) missing.push("BRIEFING_EMAIL_TO");
    if (!host) missing.push("SMTP_HOST");
    if (!user) missing.push("SMTP_USER");
    if (!pass) missing.push("SMTP_PASS");
    if (missing.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "SMTP not configured",
        missing,
        hint: "Add these to .env (see .env.example). Restart the server after changing.",
      });
    }
    try {
      const useLayout = req.query.layout === "1" || req.query.layout === "true";
      if (useLayout) {
        const sent = await sendBriefingLayoutPreviewEmail();
        if (sent) {
          return res.json({ ok: true, message: "Layout preview email sent to " + to, kind: "layout_preview" });
        }
        return res.status(500).json({ ok: false, error: "sendBriefingLayoutPreviewEmail returned false (check server logs)" });
      }
      const subject = `ARIA Test Email — ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}`;
      const content = "This is a test email from ARIA. If you received this, briefing email delivery is working.";
      const sent = await sendBriefingEmail(content, subject);
      if (sent) {
        res.json({ ok: true, message: "Test email sent to " + to });
      } else {
        res.status(500).json({ ok: false, error: "sendBriefingEmail returned false (check server logs)" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Email test failed:", e);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  router.delete("/", (req: Request, res: Response) => {
    db.run("DELETE FROM briefings");
    saveDb();
    res.json({ cleared: true });
  });

  router.post("/generate", async (req: Request, res: Response) => {
    try {
      const out = await generateBriefing();
      if (!out?.briefing) {
        return res.status(500).json({ error: "Failed to generate briefing" });
      }
      const { briefing, portfolioHtml, stocksNewsHtml, plainTextBody } = out;
      const sent = await sendBriefingEmail(
        briefing.content,
        `ARIA Morning Briefing — ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}`,
        portfolioHtml,
        stocksNewsHtml,
        plainTextBody,
      );
      res.json({ ...briefing, email_sent: sent });
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
      const out = await generateEveningBriefing();
      if (!out?.briefing) {
        return res.status(500).json({ error: "Failed to generate evening briefing" });
      }
      const { briefing, portfolioHtml, stocksNewsHtml, plainTextBody } = out;
      const sent = await sendBriefingEmail(
        briefing.content,
        `ARIA Evening Briefing — ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}`,
        portfolioHtml,
        stocksNewsHtml,
        plainTextBody,
      );
      res.json({ ...briefing, email_sent: sent });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Evening briefing error:", message);
      res.status(500).json({ error: "Evening briefing failed", detail: message });
    }
  });

  return router;
}
