/**
 * Persists a small JSON snapshot of watchlists + equity positions next to aria.db.
 * If those rows vanish from SQLite without going through a normal delete/import,
 * restore runs once at startup before default watchlist seeding.
 */

import fs from "fs";
import path from "path";
import { parseWatchlistValue } from "./watchlist";

export const MEMORY_GUARD_VERSION = 1;

export type MemoryGuardFile = {
  v: number;
  savedAt: string;
  watchlist_core?: string;
  watchlist_speculative?: string;
  positions: Array<{ key: string; value: string }>;
};

function guardPath(dataDir: string): string {
  return path.join(dataDir, "memory_guard.json");
}

function isValidPositionKey(key: string): boolean {
  const ticker = key.replace(/^position_/i, "").toUpperCase();
  return /^[A-Z0-9.]{1,6}$/.test(ticker) && !ticker.includes("_");
}

function listLen(val: string | undefined): number {
  return parseWatchlistValue(val).length;
}

export function snapshotMemoryGuard(dataDir: string, execAll: <T extends Record<string, unknown>>(sql: string) => T[]): void {
  if (process.env.MEMORY_GUARD_DISABLE === "1") return;
  try {
    const core = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist_core' LIMIT 1");
    const spec = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist_speculative' LIMIT 1");
    const posRows = execAll<{ key: string; value: string }>(
      "SELECT key, value FROM memories WHERE key LIKE 'position_%' ORDER BY key"
    );
    const positions = posRows.filter((r) => isValidPositionKey(r.key));
    const payload: MemoryGuardFile = {
      v: MEMORY_GUARD_VERSION,
      savedAt: new Date().toISOString(),
      watchlist_core: core[0]?.value,
      watchlist_speculative: spec[0]?.value,
      positions: positions.map((p) => ({ key: p.key, value: p.value })),
    };
    fs.writeFileSync(guardPath(dataDir), JSON.stringify(payload), "utf8");
  } catch (e) {
    console.warn("[memory_guard] snapshot failed:", e);
  }
}

type RunFn = (sql: string, params?: Record<string, string | number | null | undefined>) => { lastInsertRowid: number };

export function restoreMemoryGuardIfNeeded(
  dataDir: string,
  execAll: <T extends Record<string, unknown>>(sql: string) => T[],
  run: RunFn,
  saveDb: () => void
): boolean {
  if (process.env.MEMORY_GUARD_DISABLE === "1") return false;
  const p = guardPath(dataDir);
  if (!fs.existsSync(p)) return false;
  let guard: MemoryGuardFile;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as MemoryGuardFile & { v?: number };
    if (!raw || typeof raw !== "object") return false;
    const v = raw.v ?? MEMORY_GUARD_VERSION;
    if (v !== MEMORY_GUARD_VERSION) return false;
    guard = { ...raw, v: MEMORY_GUARD_VERSION, positions: Array.isArray(raw.positions) ? raw.positions : [] };
  } catch {
    return false;
  }

  const coreRow = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist_core' LIMIT 1");
  const specRow = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist_speculative' LIMIT 1");
  const posRows = execAll<{ key: string; value: string }>("SELECT key, value FROM memories WHERE key LIKE 'position_%'");
  const validPosCount = posRows.filter((r) => isValidPositionKey(r.key)).length;

  const coreLen = listLen(coreRow[0]?.value);
  const specLen = listLen(specRow[0]?.value);
  const guardCoreLen = listLen(guard.watchlist_core);
  const guardSpecLen = listLen(guard.watchlist_speculative);
  const guardPosEntries = guard.positions.filter((p) => isValidPositionKey(p.key) && p.value?.trim());
  const guardPosLen = guardPosEntries.length;

  let restored = false;
  const now = new Date().toISOString();

  const upsert = (key: string, value: string) => {
    run(
      `INSERT INTO memories (key, value, confidence, source, updated_at, created_at) VALUES (:key, :value, 1, 'memory_guard', :u, :u)
       ON CONFLICT(key) DO UPDATE SET value = :value, confidence = 1, source = 'memory_guard', updated_at = :u`,
      { ":key": key, ":value": value, ":u": now }
    );
  };

  if (guardCoreLen > 0 && coreLen === 0 && guard.watchlist_core?.trim()) {
    upsert("watchlist_core", guard.watchlist_core);
    restored = true;
    console.log("[memory_guard] Restored watchlist_core from disk guard");
  }
  if (guardSpecLen > 0 && specLen === 0 && guard.watchlist_speculative?.trim()) {
    upsert("watchlist_speculative", guard.watchlist_speculative);
    restored = true;
    console.log("[memory_guard] Restored watchlist_speculative from disk guard");
  }
  if (guardPosLen > 0 && validPosCount === 0) {
    for (const row of guardPosEntries) {
      upsert(row.key, row.value);
    }
    restored = true;
    console.log(`[memory_guard] Restored ${guardPosLen} position row(s) from disk guard`);
  }

  if (restored) saveDb();
  return restored;
}
