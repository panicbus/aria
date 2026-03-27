/**
 * Memories API routes.
 * GET / — list all; GET /export — JSON download; POST /import — bulk import;
 * POST / — create/update; DELETE / — clear all; DELETE /:key — delete one.
 */

import { Router, Request, Response } from "express";
import { snapshotMemoryGuard } from "../utils/memoryGuard";

type MemoryRow = {
  id: number;
  key: string;
  value: string;
  confidence: number;
  source: string | null;
  updated_at: string;
  created_at: string | null;
};

type DbContext = {
  db: import("sql.js").Database;
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
  saveDb: () => void;
  dataDir: string;
};

export function createMemoriesRouter(ctx: DbContext): Router {
  const router = Router();
  const { db, execAll, saveDb, dataDir } = ctx;

  const persistGuard = () => snapshotMemoryGuard(dataDir, execAll);

  // WAYPOINT [memories-api]
  // WHAT: GET returns all memories; POST create/update; DELETE one by key or clear all; GET /export for JSON.
  // WHY: Lets Nico view, add, edit memories from the Memory tab; supports transparency and manual overrides.

  /** System keys (e.g. db size alert for chat) — surfaced in model context, not in Memory tab. */
  const SYSTEM_KEY_GLOB = "aria_system_*";

  router.get("/", (req: Request, res: Response) => {
    const memories = execAll<MemoryRow>(
      `SELECT id, key, value, confidence, source, updated_at, created_at FROM memories WHERE NOT (key GLOB '${SYSTEM_KEY_GLOB.replace(/'/g, "''")}') ORDER BY updated_at DESC`
    );
    res.json(memories);
  });

  router.get("/export", (req: Request, res: Response) => {
    const memories = execAll<MemoryRow>(
      `SELECT key, value, confidence, source, updated_at FROM memories WHERE NOT (key GLOB '${SYSTEM_KEY_GLOB.replace(/'/g, "''")}') ORDER BY key`
    );
    const exportObj: Record<string, unknown> = {};
    for (const m of memories) {
      try {
        exportObj[m.key] = JSON.parse(m.value);
      } catch {
        exportObj[m.key] = m.value;
      }
    }
    res.setHeader("Content-Disposition", "attachment; filename=aria-memories.json");
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(exportObj, null, 2));
  });

  router.post("/import", (req: Request, res: Response) => {
    const body = req.body;
    if (!body || typeof body !== "object") return res.status(400).json({ error: "JSON object required (from Export)" });
    const now = new Date().toISOString();
    let count = 0;
    for (const [key, val] of Object.entries(body)) {
      if (!key || key.trim() === "") continue;
      const valueStr = typeof val === "object" ? JSON.stringify(val) : String(val ?? "");
      db.run(
        `INSERT INTO memories (key, value, confidence, source, updated_at, created_at) VALUES (:key, :value, :confidence, :source, :updated_at, :created_at)
         ON CONFLICT(key) DO UPDATE SET value = :value, confidence = 1, source = 'explicit', updated_at = :updated_at`,
        { ":key": key.trim(), ":value": valueStr, ":confidence": 1, ":source": "explicit", ":updated_at": now, ":created_at": now }
      );
      count++;
    }
    saveDb();
    persistGuard();
    res.json({ imported: count });
  });

  router.post("/", (req: Request, res: Response) => {
    const { key, value, source, confidence } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: "key and value required" });
    const valueStr = typeof value === "object" ? JSON.stringify(value) : String(value);
    const src = source === "explicit" || source === "inferred" ? source : "explicit";
    const conf = typeof confidence === "number" ? Math.max(0, Math.min(1, confidence)) : 1;
    const updated_at = new Date().toISOString();
    const created_at = new Date().toISOString();
    db.run(
      `INSERT INTO memories (key, value, confidence, source, updated_at, created_at) VALUES (:key, :value, :confidence, :source, :updated_at, :created_at)
       ON CONFLICT(key) DO UPDATE SET value = :value, confidence = :confidence, source = :source, updated_at = :updated_at`,
      { ":key": key, ":value": valueStr, ":confidence": conf, ":source": src, ":updated_at": updated_at, ":created_at": created_at }
    );
    saveDb();
    persistGuard();
    const row = execAll<MemoryRow>(`SELECT id, key, value, confidence, source, updated_at, created_at FROM memories WHERE key = '${String(key).replace(/'/g, "''")}'`);
    res.json(row[0] ?? { key, value: valueStr, confidence: conf, source: src, updated_at, created_at });
  });

  router.delete("/", (req: Request, res: Response) => {
    db.run("DELETE FROM memories");
    saveDb();
    persistGuard();
    res.json({ cleared: true });
  });

  router.delete("/:key", (req: Request, res: Response) => {
    const key = req.params.key;
    if (!key) return res.status(400).json({ error: "key required" });
    db.run("DELETE FROM memories WHERE key = :key", { ":key": key });
    saveDb();
    persistGuard();
    res.json({ deleted: key });
  });

  return router;
}
