import "dotenv/config";
import express from "express";
import cors from "cors";
import initSqlJs from "sql.js";
import path from "path";
import fs from "fs";
import { Cron } from "croner";

import { createFetchAndStoreOHLCV } from "./services/ohlcv";
import { createRunBacktest } from "./services/backtest";
import { createLiveDataFetchers } from "./services/liveData";
import { createGenerateSignals, createGenerateSignalForTicker } from "./services/signals";
import { createBuildLiveContext, createBuildBriefingLiveContext, createBuildMemoryContext, createGetRiskContextForTicker } from "./services/context";
import { createBriefingGenerators, sendBriefingEmail } from "./services/briefings";
import { createScannerService } from "./services/scanner";
import { createHandleToolCall, createRunMemoryExtraction } from "./services/chatTools";
import { createMemoriesRouter } from "./routes/memories";
import { createHealthRouter } from "./routes/health";
import { createOhlcvRouter } from "./routes/ohlcv";
import { createDashboardRouter } from "./routes/dashboard";
import { createSignalsRouter } from "./routes/signals";
import { createBriefingsRouter } from "./routes/briefings";
import { createBacktestRouter } from "./routes/backtest";
import { createChatRouter } from "./routes/chat";
import { createScannerRouter } from "./routes/scanner";
import { createPortfolioRouter } from "./routes/portfolio";
import { fetchCryptoPortfolioSummary, logRobinhoodStatus } from "./services/robinhood";
import { createPruneStorage } from "./services/prune";
import { parseWatchlistValue } from "./utils/watchlist";
import { restoreMemoryGuardIfNeeded, snapshotMemoryGuard } from "./utils/memoryGuard";

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");

app.use(cors());
app.use(express.json());

// Fly.io / load balancer health check (root path for simplicity)
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

// WAYPOINT [database]
// WHAT: sql.js in-memory DB persisted to aria.db; execAll for SELECTs, run() for writes, saveDb() after every write.
// WHY: Pure JS SQLite so the app runs on Node >=18 with no native addons (see BUILD-ERRORS-AND-FIXES.md).
// HOW IT HELPS NICO: Persistent storage for OHLCV, indicators, and signals — the foundation for technical analysis and backtesting.

// ── Database (sql.js: no native build, runs everywhere) ────────────────────────
const DB_PATH = path.join(DATA_DIR, "aria.db");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_RETAIN = 6; // Keep last 6 backups (~18 days at 3-day cadence)
/** sql.js keeps the full DB in WASM memory; file size is a rough lower bound for steady-state RAM. Tunable via env (MB). */
const SQLJS_DB_WARN_MB = Number(process.env.SQLJS_DB_WARN_MB) || 48;
const SQLJS_DB_CRITICAL_MB = Number(process.env.SQLJS_DB_CRITICAL_MB) || 96;
const DB_SIZE_CHECK_INTERVAL_MS = Number(process.env.DB_SIZE_CHECK_INTERVAL_MS) || 6 * 60 * 60 * 1000;
const BYTES_PER_MB = 1024 * 1024;
/** Synced to memories for chat context; hidden from Memory tab API (aria_system% prefix). */
const ARIA_SYSTEM_DB_SIZE_KEY = "aria_system_db_size";
let db: import("sql.js").Database;

/** Logs when aria.db on disk is large enough that sql.js + export/save spikes risk OOM on a small VM (e.g. 512MB). */
function checkAriaDbSize(): void {
  try {
    if (!fs.existsSync(DB_PATH)) {
      syncAriaDbSizeChatAlert(0, "ok");
      return;
    }
    const bytes = fs.statSync(DB_PATH).size;
    const mb = bytes / BYTES_PER_MB;
    let level: "ok" | "warn" | "critical" = "ok";
    if (mb >= SQLJS_DB_CRITICAL_MB) {
      level = "critical";
      console.warn(
        `[aria.db] CRITICAL: on-disk ${mb.toFixed(1)} MB (threshold ${SQLJS_DB_CRITICAL_MB} MB). sql.js loads the whole file into memory; export/save duplicates work — high OOM risk. Prune OHLCV/messages/history, add RAM, or migrate off sql.js. (${DB_PATH})`
      );
    } else if (mb >= SQLJS_DB_WARN_MB) {
      level = "warn";
      console.warn(
        `[aria.db] WARN: on-disk ${mb.toFixed(1)} MB (threshold ${SQLJS_DB_WARN_MB} MB). Memory pressure likely; plan pruning or more RAM before next big job. (${DB_PATH})`
      );
    }
    syncAriaDbSizeChatAlert(mb, level);
  } catch (e) {
    console.error("[aria.db] size check failed:", e);
  }
}

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function backupDb(): void {
  if (!fs.existsSync(DB_PATH)) return;
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const dest = path.join(BACKUP_DIR, `aria-${date}.db`);
    fs.copyFileSync(DB_PATH, dest);
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("aria-") && f.endsWith(".db")).sort().reverse();
    while (files.length > BACKUP_RETAIN) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.pop()!));
    }
    console.log(`DB backup: ${dest}`);
    snapshotMemoryGuard(DATA_DIR, execAll);
  } catch (e) {
    console.error("Backup failed:", e);
  }
}

function execAll<T extends Record<string, unknown>>(sql: string): T[] {
  const results = db.exec(sql);
  if (results.length === 0) return [];
  const { columns, values } = results[0];
  return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]]))) as T[];
}

type DbParams = Record<string, string | number | null | undefined>;
function run(sql: string, params?: DbParams): { lastInsertRowid: number } {
  db.run(sql, params as import("sql.js").ParamsObject | undefined);
  const rows = db.exec("SELECT last_insert_rowid() AS id");
  const id = rows.length && rows[0].values[0] ? (rows[0].values[0][0] as number) : 0;
  return { lastInsertRowid: id };
}

/** Writes/removes a synthetic memory so chat MEMORY block surfaces DB size risk to the model; cleared when size is OK. */
function syncAriaDbSizeChatAlert(mb: number, level: "ok" | "warn" | "critical"): void {
  try {
    if (!db) return;
    if (level === "ok") {
      const rows = execAll<{ key: string }>(
        `SELECT key FROM memories WHERE key = '${ARIA_SYSTEM_DB_SIZE_KEY.replace(/'/g, "''")}' LIMIT 1`
      );
      if (!rows.length) return;
      db.run("DELETE FROM memories WHERE key = :k", { ":k": ARIA_SYSTEM_DB_SIZE_KEY });
      saveDb();
      return;
    }
    const now = new Date().toISOString();
    const value =
      level === "critical"
        ? `[AUTO — tell Nico if they open chat] aria.db is ${mb.toFixed(1)} MB on disk (CRITICAL vs ${SQLJS_DB_CRITICAL_MB} MB). sql.js loads the entire DB into RAM; export/save doubles memory briefly — OOM risk on the Fly VM. Suggest pruning old OHLCV/messages or increasing memory.`
        : `[AUTO — tell Nico if they open chat] aria.db is ${mb.toFixed(1)} MB on disk (warn threshold ${SQLJS_DB_WARN_MB} MB). sql.js holds the full DB in memory; plan pruning or more RAM before the next heavy job.`;
    db.run(
      `INSERT INTO memories (key, value, confidence, source, updated_at, created_at) VALUES (:key, :value, 1, 'system', :u, :u)
       ON CONFLICT(key) DO UPDATE SET value = :value, confidence = 1, source = 'system', updated_at = :u`,
      { ":key": ARIA_SYSTEM_DB_SIZE_KEY, ":value": value, ":u": now }
    );
    saveDb();
  } catch (e) {
    console.error("[aria.db] chat alert sync failed:", e);
  }
}

const SYSTEM_PROMPT = `You are ARIA — Autonomous Research & Intelligence Assistant — a personal intelligence layer built for Nico, a senior frontend developer in the Bay Area with 12 years of tech experience.

Your three core domains:
1. TECH & AI INDUSTRY — Monitor the state of AI agents, frontend tooling, industry shifts, and emerging opportunities. Nico uses React, TypeScript, and AI tools like Cursor and Copilot daily.
2. FINANCIAL INTELLIGENCE — Track stocks and crypto signals. Nico trades a mix of US equities and crypto. Give clear BUY/SELL/HOLD/WATCH signals with reasoning. Nico makes the final call.
3. DEVELOPER GROWTH — Help Nico learn, build, and evolve — especially around autonomous agents, which is exactly what he's building right now.

Personality: Sharp, direct, warm. No padding. Surface what matters. Use → for signals or action items.

When Nico asks about recent news, events, or facts you don't have in your database, use web_search to find current information. Prefer get_news and get_prices for data you already track.

When giving financial signals, format them like:
TICKER: [symbol]
SIGNAL: [BUY | SELL | HOLD | WATCH]
REASONING: [1-2 sentences max]
ACTION: [specific next step if applicable]

When Nico says he owns, bought, or holds shares (e.g. "I have 23 RDDT at $45", "update my AMD position: 100 shares, avg $120"), use add_position with ticker, quantity, and average_cost. Do NOT use remember for positions.

If MEMORY includes key aria_system_db_size, it is an automatic capacity warning (SQLite/sql.js on Fly). When Nico chats, briefly mention it and what it means (OOM risk, pruning, or more RAM) if the message is still current.`;

// ── Live data (prices, news, signals) ──────────────────────────────────────────
// Base tickers always fetched. Memory watchlist (Portfolio tab) adds more — no code change needed.
const BASE_TICKERS = ["SPY", "QQQ", "BTC", "ETH", "AMD", "AMZN", "CLS"];
const CRYPTO_COINGECKO_IDS: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum" };

// WAYPOINT [getWatchedTickers]
// WHAT: Merges BASE_TICKERS with tickers from memory (watchlist_core, watchlist_speculative, position_*).
// WHY: Signals, OHLCV, and live data must reflect Nico's current holdings + watchlist — not a hardcoded list.
// HOW IT HELPS NICO: Add BOTZ via chat → next signal cycle generates a signal. Exit LTBR → position removed → signals stop.
function getWatchedTickers(): string[] {
  if (!db) return [...BASE_TICKERS];
  const tickers = new Set<string>(BASE_TICKERS);

  // Read watchlist_core and watchlist_speculative — use parseWatchlistValue for robust parsing (handles malformed JSON)
  const coreRow = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist_core' LIMIT 1");
  parseWatchlistValue(coreRow[0]?.value).forEach((t) => tickers.add(t));

  const specRow = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist_speculative' LIMIT 1");
  parseWatchlistValue(specRow[0]?.value).forEach((t) => tickers.add(t));

  // Fallback: legacy watchlist (comma-separated) for backward compatibility
  const watchRow = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist' LIMIT 1");
  parseWatchlistValue(watchRow[0]?.value).forEach((t) => tickers.add(t));

  // Read valid position_* keys only (reject position_AVERAGE_COST_X, position_QUANTITY_X)
  const posRows = execAll<{ key: string; value: string }>("SELECT key, value FROM memories WHERE key LIKE 'position_%'");
  for (const row of posRows) {
    const tickerFromKey = row.key.replace(/^position_/i, "").toUpperCase();
    if (!/^[A-Z0-9.]{1,6}$/.test(tickerFromKey) || tickerFromKey.includes("_")) continue;
    try {
      const pos = JSON.parse(row.value) as { ticker?: string };
      tickers.add((pos?.ticker ?? tickerFromKey).toUpperCase());
    } catch (_) {
      tickers.add(tickerFromKey);
    }
  }

  return Array.from(tickers);
}
const PRICE_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const NEWS_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const SIGNAL_INTERVAL_MS = 5 * 60 * 1000; // 5 min (after prices)

// OHLCV: fetchAndStoreOHLCV created in start() after db init; see server/services/ohlcv.ts
let fetchAndStoreOHLCV: () => Promise<void>;

const COINGECKO_ID_TO_SYMBOL: Record<string, string> = { bitcoin: "BTC", ethereum: "ETH" };

// Live data fetchers created in start() after db init
let fetchCoinGecko: () => Promise<void>;
let fetchStocks: () => Promise<void>;
let fetchVIX: () => Promise<void>;
let fetchHN: () => Promise<void>;
let fetchStockNews: () => Promise<void>;

// ── Start (async: load sql.js and DB file) ─────────────────────────────────────
async function start() {
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  const SQL = await initSqlJs();
  let fileBuffer: Buffer | undefined = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : undefined;

  function runSchema(): void {
    db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      signal TEXT NOT NULL,
      reasoning TEXT,
      price REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      indicator_data TEXT
    );

    CREATE TABLE IF NOT EXISTS prices (
      symbol TEXT PRIMARY KEY,
      price REAL NOT NULL,
      change_24h REAL,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_raw TEXT
    );

    CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'morning'
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 1,
      source TEXT,
      updated_at TEXT NOT NULL,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ohlcv (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      source TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(symbol, date)
    );

    CREATE TABLE IF NOT EXISTS scanner_universe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scanner_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL,
      tier TEXT NOT NULL,
      ohlcv_days INTEGER DEFAULT 0,
      has_sufficient_data INTEGER DEFAULT 0,
      nominated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      activated_at DATETIME,
      status TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS scanner_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      signal TEXT NOT NULL,
      score INTEGER NOT NULL,
      rsi REAL,
      macd_histogram REAL,
      price REAL,
      change_24h REAL,
      indicator_data TEXT,
      aria_reasoning TEXT,
      category TEXT,
      scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stock_news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT UNIQUE NOT NULL,
      summary TEXT,
      source TEXT,
      published_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_stock_news_published
    ON stock_news(published_at DESC);

    CREATE TABLE IF NOT EXISTS signal_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      signal TEXT NOT NULL,
      score INTEGER,
      price_at_signal REAL NOT NULL,
      signal_date TEXT NOT NULL,
      price_3d REAL,
      outcome_3d TEXT,
      checked_3d INTEGER DEFAULT 0,
      price_7d REAL,
      outcome_7d TEXT,
      checked_7d INTEGER DEFAULT 0,
      pct_change_3d REAL,
      pct_change_7d REAL,
      source TEXT DEFAULT 'scanner',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(ticker, signal_date)
    );

    CREATE INDEX IF NOT EXISTS idx_signal_outcomes_date
    ON signal_outcomes(signal_date, checked_3d, checked_7d);

    CREATE TABLE IF NOT EXISTS crypto_portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL UNIQUE,
      quantity REAL NOT NULL,
      cost_basis REAL NOT NULL,
      average_buy_price REAL NOT NULL,
      current_price REAL NOT NULL,
      market_value REAL NOT NULL,
      unrealized_pnl REAL NOT NULL,
      unrealized_pnl_pct REAL NOT NULL,
      buying_power REAL,
      portfolio_value REAL,
      source TEXT DEFAULT 'robinhood',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migrations: add new columns to existing tables (no-op if column exists)
  const alter = (sql: string) => {
    try {
      db.run(sql);
    } catch (_) {
      /* column or table already has it */
    }
  };
  alter("ALTER TABLE signals ADD COLUMN indicator_data TEXT");
  alter("ALTER TABLE prices ADD COLUMN source_raw TEXT");
  alter("ALTER TABLE memories ADD COLUMN confidence REAL DEFAULT 1");
  alter("ALTER TABLE memories ADD COLUMN source TEXT");
  alter("ALTER TABLE memories ADD COLUMN created_at TEXT");
  alter("ALTER TABLE briefings ADD COLUMN type TEXT NOT NULL DEFAULT 'morning'");
  alter("ALTER TABLE news ADD COLUMN summary TEXT");
  alter("ALTER TABLE scanner_universe ADD COLUMN tier TEXT DEFAULT 'moderate'");
  // Backfill type from created_at (Pacific: hour < 12 = morning, else evening)
  const pacificHour = (iso: string) =>
    parseInt(new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }), 10);
  try {
    const rows = execAll<{ id: number; created_at: string }>("SELECT id, created_at FROM briefings");
    for (const r of rows) {
      const hour = pacificHour(r.created_at);
      const typ = hour < 12 ? "morning" : "evening";
      db.run("UPDATE briefings SET type = :t WHERE id = :id", { ":t": typ, ":id": r.id });
    }
    if (rows.length) saveDb();
  } catch (_) {}
  saveDb();

  // Restore watchlists / positions from memory_guard.json when DB rows are empty but the guard still has data (survives silent wipes).
  restoreMemoryGuardIfNeeded(DATA_DIR, execAll, run, saveDb);

  // WAYPOINT [seed-watchlist]: If watchlist_core is empty or missing, seed with Nico's known watchlist so it survives fresh deploys
  const existingWatchlist = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist_core' LIMIT 1");
  const watchlistVal = existingWatchlist[0]?.value?.trim();
  const watchlistEmpty = !watchlistVal || watchlistVal === "[]";
  if (!existingWatchlist.length || watchlistEmpty) {
    const defaultWatchlist = ["AMD", "NET", "APP", "AMZN", "NEE", "LEN", "OKLO", "CLS", "PGY", "ETH"];
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO memories (key, value, confidence, source, updated_at, created_at) VALUES (:key, :value, :confidence, :source, :updated_at, :created_at)
       ON CONFLICT(key) DO UPDATE SET value = :value, confidence = 1, source = 'seed', updated_at = :updated_at`,
      { ":key": "watchlist_core", ":value": JSON.stringify(defaultWatchlist), ":confidence": 1, ":source": "seed", ":updated_at": now, ":created_at": now }
    );
    saveDb();
    console.log("Seeded watchlist_core with default tickers");
  }

  snapshotMemoryGuard(DATA_DIR, execAll);

  }

  function loadDb(): void {
    db = new SQL.Database(fileBuffer);
    runSchema();
  }

  try {
    loadDb();
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.warn("DB load failed (possibly corrupted). Attempting restore:", msg);
    if (fs.existsSync(DB_PATH)) {
      try {
        fs.unlinkSync(DB_PATH);
      } catch (_) {}
    }
    const backupDir = path.join(DATA_DIR, "backups");
    if (fs.existsSync(backupDir)) {
      const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith("aria-") && f.endsWith(".db")).sort().reverse();
      if (backups.length > 0) {
        const latest = path.join(backupDir, backups[0]);
        console.log(`Restoring from ${backups[0]}...`);
        fs.copyFileSync(latest, DB_PATH);
        fileBuffer = fs.readFileSync(DB_PATH);
        try {
          loadDb();
          console.log("DB restored from backup.");
        } catch (_) {
          console.warn("Backup malformed. Starting fresh.");
          fileBuffer = undefined;
          db = new SQL.Database();
          runSchema();
        }
      } else {
        console.warn("No backups. Starting fresh.");
        fileBuffer = undefined;
        db = new SQL.Database();
        runSchema();
      }
    } else {
      console.warn("No backup dir. Starting fresh.");
      fileBuffer = undefined;
      db = new SQL.Database();
      runSchema();
    }
  }

  const startupMem = process.memoryUsage();
  console.log(`Startup memory: ${Math.round(startupMem.heapUsed / 1024 / 1024)}MB heap, ${Math.round(startupMem.rss / 1024 / 1024)}MB rss`);

  const buildLiveContext = createBuildLiveContext({ execAll });
  const buildMemoryContext = createBuildMemoryContext({ execAll });
  const getRiskContextForTicker = createGetRiskContextForTicker({ execAll });

  const generateSignals = createGenerateSignals({ db, execAll, run, saveDb, getWatchedTickers });
  const generateSignalForTicker = createGenerateSignalForTicker({ db, execAll, run, saveDb, getWatchedTickers });

  const liveData = createLiveDataFetchers({
    db,
    execAll,
    saveDb,
    getWatchedTickers,
    cryptoIds: CRYPTO_COINGECKO_IDS,
    coingeckoIdToSymbol: COINGECKO_ID_TO_SYMBOL,
  });
  const fetchCryptoPrices = liveData.fetchCryptoPrices;
  fetchCoinGecko = liveData.fetchCoinGecko;
  fetchStocks = liveData.fetchStocks;
  fetchVIX = liveData.fetchVIX;
  fetchHN = liveData.fetchHN;
  fetchStockNews = liveData.fetchStockNews;

  const runBacktest = createRunBacktest({ db, execAll, getWatchedTickers });

  const scannerService = createScannerService({
    db,
    execAll,
    run,
    saveDb,
    getWatchedTickers,
    cryptoIds: CRYPTO_COINGECKO_IDS,
  });

  const buildBriefingLiveContext = createBuildBriefingLiveContext({
    execAll,
    getWatchedTickers,
    getScannerSymbols: () => scannerService.getTopPicks(0).map((p) => p.symbol),
  });

  const { generateBriefing, generateEveningBriefing } = createBriefingGenerators({
    db,
    execAll,
    run,
    saveDb,
    fetchCoinGecko: fetchCryptoPrices,
    fetchStocks,
    fetchHN,
    generateSignals,
    buildLiveContext: buildBriefingLiveContext,
    buildMemoryContext,
    getWatchedTickers,
    getScannerTopPicks: () => scannerService.getTopPicks(3),
  });

  const persistMemoryGuard = () => snapshotMemoryGuard(DATA_DIR, execAll);

  const handleToolCall = createHandleToolCall({
    db,
    execAll,
    saveDb,
    getWatchedTickers,
    getRiskContextForTicker,
    generateSignalForTicker,
    getScannerTopPicks: (min) => scannerService.getTopPicks(min ?? 0),
    onMemoriesPersist: persistMemoryGuard,
  });
  const runMemoryExtraction = createRunMemoryExtraction({ handleToolCall });

  fetchAndStoreOHLCV = createFetchAndStoreOHLCV({
    getWatchedTickers,
    db,
    saveDb,
    cryptoIds: CRYPTO_COINGECKO_IDS,
    execAll,
    run,
    onGraduationCheck: () => scannerService.runGraduationCheck(),
  });

  const pruneStorage = createPruneStorage({ execAll, run, saveDb });

  app.use("/api", createHealthRouter({ dataDir: DATA_DIR, dbPath: DB_PATH, execAll }));
  app.use("/api", createDashboardRouter({ execAll, getWatchedTickers, getRiskContextForTicker }));
  app.use("/api/signals", createSignalsRouter({ execAll, run, saveDb, getRiskContextForTicker, generateSignals }));
  app.use("/api/briefings", createBriefingsRouter({ db, execAll, saveDb, generateBriefing, generateEveningBriefing, sendBriefingEmail }));
  app.use("/api/backtest", createBacktestRouter({ getWatchedTickers, runBacktest }));
  app.use("/api", createChatRouter({
    db,
    execAll,
    saveDb,
    buildLiveContext,
    buildMemoryContext,
    systemPrompt: SYSTEM_PROMPT,
    handleToolCall,
    runMemoryExtraction,
  }));
  app.use("/api/memories", createMemoriesRouter({ db, execAll, saveDb, dataDir: DATA_DIR }));
  scannerService.seedCandidatesAndUniverse();

  app.use("/api/scanner", createScannerRouter({
    getActiveUniverse: scannerService.getActiveUniverse,
    triggerScan: scannerService.triggerScan,
    getResults: scannerService.getResults,
    getStatus: scannerService.getStatus,
    getCandidates: scannerService.getCandidates,
    getUniverseStats: scannerService.getUniverseStats,
    runWeeklyNomination: scannerService.runWeeklyNomination,
  }));

  app.use("/api/ohlcv", createOhlcvRouter({
    db,
    execAll,
    saveDb,
    getWatchedTickers,
    fetchAndStoreOHLCV,
    cryptoIds: CRYPTO_COINGECKO_IDS,
  }));

  // Start server immediately so the app is reachable. Run initial fetches in background.
  const hasKey = !!process.env.GEMINI_API_KEY?.trim();
  if (!hasKey) {
    console.warn("  GEMINI_API_KEY not set — AI features disabled. Get a free key at aistudio.google.com");
  } else {
    const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
    console.log(`  Gemini API key: present (model: ${model})`);
  }
  logRobinhoodStatus();
  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  if (!tavilyKey) {
    console.warn("  TAVILY_API_KEY not set — web search disabled. Add to .env or flyctl secrets set TAVILY_API_KEY=...");
  } else {
    console.log(`  Tavily (web search): configured (${tavilyKey.slice(0, 8)}...)`);
  }

  async function refreshCryptoPortfolio(): Promise<void> {
    const summary = await fetchCryptoPortfolioSummary();
    if (!summary) {
      const existing = execAll<{ symbol: string }>("SELECT symbol FROM crypto_portfolio");
      if (existing.length > 0) {
        const now = new Date().toISOString();
        db.run("UPDATE crypto_portfolio SET source = 'robinhood_stale', updated_at = :now", { ":now": now } as any);
        saveDb();
      }
      return;
    }
    const now = new Date().toISOString();
    const { account, holdings } = summary;
    for (const h of holdings) {
      db.run(
        `INSERT OR REPLACE INTO crypto_portfolio (symbol, quantity, cost_basis, average_buy_price, current_price, market_value, unrealized_pnl, unrealized_pnl_pct, buying_power, portfolio_value, source, updated_at)
         VALUES (:symbol, :quantity, :cost_basis, :avg, :current, :market_value, :pnl, :pnl_pct, :buying_power, :portfolio_value, 'robinhood', :now)`,
        {
          ":symbol": h.symbol,
          ":quantity": h.quantity,
          ":cost_basis": h.cost_basis,
          ":avg": h.average_buy_price,
          ":current": h.current_price,
          ":market_value": h.market_value,
          ":pnl": h.unrealized_pnl,
          ":pnl_pct": h.unrealized_pnl_pct,
          ":buying_power": account.buying_power,
          ":portfolio_value": account.portfolio_value,
          ":now": now,
        } as any
      );
    }
    saveDb();
  }

  app.use("/api/portfolio", createPortfolioRouter({
    execAll,
    refreshCryptoPortfolio,
  }));

  // Serve built frontend in production (cwd for Docker, __dirname for dev)
  const distPath = fs.existsSync(path.join(process.cwd(), "dist"))
    ? path.join(process.cwd(), "dist")
    : path.join(__dirname, "../dist");
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  checkAriaDbSize();
  setInterval(checkAriaDbSize, DB_SIZE_CHECK_INTERVAL_MS);

  app.listen(PORT, () => {
    const used = process.memoryUsage();
    console.log(`
  ╔═══════════════════════════════════╗
  ║   ARIA Server — Port ${PORT}         ║
  ║   Status: ONLINE                  ║
  ╚═══════════════════════════════════╝
  Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB heap, ${Math.round(used.rss / 1024 / 1024)}MB rss
  `);
  });

  // Initial fetch + scheduled live data (runs in background after server is up)
  Promise.resolve().then(async () => {
    await fetchCryptoPrices();
    await fetchStocks();
    await fetchVIX();
    await fetchHN();
    await fetchStockNews();
    await refreshCryptoPortfolio();
    await fetchAndStoreOHLCV();
    scannerService.checkSignalOutcomes();
    generateSignals();
  }).catch((err) => console.error("Initial fetch failed:", err));

  setInterval(fetchCryptoPrices, PRICE_INTERVAL_MS);
  setInterval(fetchStocks, PRICE_INTERVAL_MS);
  setInterval(fetchVIX, PRICE_INTERVAL_MS);
  setInterval(refreshCryptoPortfolio, PRICE_INTERVAL_MS);
  setInterval(fetchHN, NEWS_INTERVAL_MS);
  setInterval(fetchStockNews, NEWS_INTERVAL_MS);
  setInterval(generateSignals, SIGNAL_INTERVAL_MS);

  const TZ = "America/Los_Angeles";

  // DB backup — 3am Pacific every 3 days (days 1, 4, 7, 10, …)
  new Cron("0 3 */3 * *", { timezone: TZ }, () => {
    backupDb();
  });

  // Prune old OHLCV + chat history — 04:00 Pacific daily
  new Cron("0 4 * * *", { timezone: TZ }, () => {
    try {
      pruneStorage();
    } catch (err) {
      console.error("[cron] Prune failed:", err);
    }
  });

  // Weekly nomination — Sunday at 05:00 Pacific
  new Cron("0 5 * * 0", { timezone: TZ }, () => {
    scannerService.runWeeklyNomination().catch((err) => console.error("[cron] Nomination failed:", err));
  });

  // OHLCV refresh + graduation + signal outcome checking — daily at 06:00 Pacific
  new Cron("0 6 * * *", { timezone: TZ }, () => {
    fetchAndStoreOHLCV()
      .then(() => scannerService.checkSignalOutcomes())
      .catch((err) => console.error("OHLCV refresh failed:", err));
  });

  // Morning briefing — every weekday at 07:00 Pacific
  new Cron("0 7 * * 1-5", { timezone: TZ }, async () => {
    const now = new Date().toLocaleString("en-US", { timeZone: TZ });
    console.log("[cron] Morning briefing triggered at", now);
    try {
      const out = await generateBriefing();
      if (out?.briefing?.content) {
        const sent = await sendBriefingEmail(
          out.briefing.content,
          `ARIA Morning Briefing — ${new Date().toLocaleDateString("en-US", { timeZone: TZ })}`,
          out.portfolioHtml,
          out.stocksNewsHtml,
          out.plainTextBody,
        );
        if (sent) console.log("[cron] Morning briefing sent by email");
        else console.log("[cron] Morning briefing stored (email not configured)");
      }
    } catch (err) {
      console.error("[cron] Morning briefing failed:", err);
    }
  });

  // Scanner — daily at 08:00 Pacific (60 min after morning briefing)
  new Cron("0 8 * * *", { timezone: TZ }, () => {
    scannerService.runScan().catch((err) => console.error("Scanner failed:", err));
  });

  // Evening briefing — every weekday at 20:00 Pacific
  new Cron("0 20 * * 1-5", { timezone: TZ }, async () => {
    const now = new Date().toLocaleString("en-US", { timeZone: TZ });
    console.log("[cron] Evening briefing triggered at", now);
    try {
      const out = await generateEveningBriefing();
      if (out?.briefing?.content) {
        const sent = await sendBriefingEmail(
          out.briefing.content,
          `ARIA Evening Briefing — ${new Date().toLocaleDateString("en-US", { timeZone: TZ })}`,
          out.portfolioHtml,
          out.stocksNewsHtml,
          out.plainTextBody,
        );
        if (sent) console.log("[cron] Evening briefing sent by email");
        else console.log("[cron] Evening briefing stored (email not configured)");
      }
    } catch (err) {
      console.error("[cron] Evening briefing failed:", err);
    }
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
