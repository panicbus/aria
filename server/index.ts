import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import initSqlJs from "sql.js";
import path from "path";
import fs from "fs";
import cron from "node-cron";

import { createFetchAndStoreOHLCV } from "./services/ohlcv";
import { createRunBacktest } from "./services/backtest";
import { createLiveDataFetchers } from "./services/liveData";
import { createGenerateSignals, createGenerateSignalForTicker } from "./services/signals";
import { createBuildLiveContext, createBuildMemoryContext, createGetRiskContextForTicker } from "./services/context";
import { createBriefingGenerators, sendBriefingEmail } from "./services/briefings";
import { createScannerService } from "./services/scanner";
import { TOOLS, createHandleToolCall, createRunMemoryExtraction } from "./services/chatTools";
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

dotenv.config();

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// WAYPOINT [database]
// WHAT: sql.js in-memory DB persisted to aria.db; execAll for SELECTs, run() for writes, saveDb() after every write.
// WHY: Pure JS SQLite so the app runs on Node >=18 with no native addons (see BUILD-ERRORS-AND-FIXES.md).
// HOW IT HELPS NICO: Persistent storage for OHLCV, indicators, and signals — the foundation for technical analysis and backtesting.

// ── Database (sql.js: no native build, runs everywhere) ────────────────────────
const DB_PATH = path.join(__dirname, "../aria.db");
const BACKUP_DIR = path.join(__dirname, "../backups");
const BACKUP_RETAIN = 6; // Keep last 6 backups (~3 months at 14-day interval)
let db: import("sql.js").Database;

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

// ── Anthropic ──────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
ACTION: [specific next step if applicable]`;

// ── Live data (prices, news, signals) ──────────────────────────────────────────
// Base tickers always fetched. Memory watchlist (Portfolio tab) adds more — no code change needed.
const BASE_TICKERS = ["BTC", "ETH", "AMD", "AMZN", "CLS"];
const CRYPTO_COINGECKO_IDS: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum" };

// WAYPOINT [getWatchedTickers]
// WHAT: Merges BASE_TICKERS with tickers from memory (watchlist_core, watchlist_speculative, position_*).
// WHY: Signals, OHLCV, and live data must reflect Nico's current holdings + watchlist — not a hardcoded list.
// HOW IT HELPS NICO: Add BOTZ via chat → next signal cycle generates a signal. Exit LTBR → position removed → signals stop.
function getWatchedTickers(): string[] {
  if (!db) return [...BASE_TICKERS];
  const tickers = new Set<string>(BASE_TICKERS);

  // Read watchlist_core from memories table
  const coreRow = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist_core' LIMIT 1");
  if (coreRow.length && coreRow[0].value) {
    try {
      const core = JSON.parse(coreRow[0].value);
      if (Array.isArray(core)) core.forEach((t: string) => tickers.add(String(t).toUpperCase()));
    } catch (_) {}
  }

  // Read watchlist_speculative from memories table
  const specRow = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist_speculative' LIMIT 1");
  if (specRow.length && specRow[0].value) {
    try {
      const spec = JSON.parse(specRow[0].value);
      if (Array.isArray(spec)) spec.forEach((t: string) => tickers.add(String(t).toUpperCase()));
    } catch (_) {}
  }

  // Fallback: legacy watchlist (comma-separated) for backward compatibility with Memory tab
  const watchRow = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist' LIMIT 1");
  const watchRaw = watchRow[0]?.value?.trim();
  if (watchRaw) {
    watchRaw.split(/[\s,]+/).map((s) => s.toUpperCase()).filter((s) => s.length > 0).forEach((t) => tickers.add(t));
  }

  // Read all position_* keys from memories table
  const posRows = execAll<{ key: string; value: string }>("SELECT key, value FROM memories WHERE key LIKE 'position_%'");
  for (const row of posRows) {
    try {
      const pos = JSON.parse(row.value) as { ticker?: string };
      if (pos?.ticker) tickers.add(String(pos.ticker).toUpperCase());
    } catch (_) {}
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
let fetchHN: () => Promise<void>;

// ── Start (async: load sql.js and DB file) ─────────────────────────────────────
async function start() {
  const SQL = await initSqlJs();
  const fileBuffer = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : undefined;
  db = new SQL.Database(fileBuffer);

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
      created_at TEXT NOT NULL
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
  fetchHN = liveData.fetchHN;

  const runBacktest = createRunBacktest({ db, execAll, getWatchedTickers });

  const scannerService = createScannerService({
    db,
    execAll,
    run,
    saveDb,
    getWatchedTickers,
    anthropic,
    cryptoIds: CRYPTO_COINGECKO_IDS,
  });

  const { generateBriefing, generateEveningBriefing } = createBriefingGenerators({
    db,
    anthropic,
    execAll,
    run,
    saveDb,
    fetchCoinGecko: fetchCryptoPrices,
    fetchStocks,
    fetchHN,
    generateSignals,
    buildLiveContext,
    buildMemoryContext,
    getScannerTopPicks: () => scannerService.getTopPicks(3),
  });

  const handleToolCall = createHandleToolCall({
    db,
    execAll,
    saveDb,
    getWatchedTickers,
    getRiskContextForTicker,
    generateSignalForTicker,
    getScannerTopPicks: (min) => scannerService.getTopPicks(min ?? 0),
  });
  const runMemoryExtraction = createRunMemoryExtraction({ anthropic, handleToolCall });

  fetchAndStoreOHLCV = createFetchAndStoreOHLCV({
    getWatchedTickers,
    db,
    saveDb,
    cryptoIds: CRYPTO_COINGECKO_IDS,
  });

  app.use("/api", createHealthRouter(anthropic));
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
    anthropic,
    tools: TOOLS,
    handleToolCall,
    runMemoryExtraction,
  }));
  app.use("/api/memories", createMemoriesRouter({ db, execAll, saveDb }));
  app.use("/api/scanner", createScannerRouter({
    getActiveUniverse: scannerService.getActiveUniverse,
    triggerScan: scannerService.triggerScan,
    getResults: scannerService.getResults,
    getStatus: scannerService.getStatus,
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
  const hasKey = !!process.env.ANTHROPIC_API_KEY?.trim();
  console.log(`  Claude API key: ${hasKey ? "present" : "MISSING — add ANTHROPIC_API_KEY to .env"}`);
  logRobinhoodStatus();

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
    anthropic,
  }));

  app.listen(PORT, () => {
    console.log(`
  ╔═══════════════════════════════════╗
  ║   ARIA Server — Port ${PORT}         ║
  ║   Status: ONLINE                  ║
  ╚═══════════════════════════════════╝
  `);
  });

  // Initial fetch + scheduled live data (runs in background after server is up)
  Promise.resolve().then(async () => {
    await fetchCryptoPrices();
    await fetchStocks();
    await fetchHN();
    await refreshCryptoPortfolio();
    await fetchAndStoreOHLCV();
    generateSignals();
  }).catch((err) => console.error("Initial fetch failed:", err));

  setInterval(fetchCryptoPrices, PRICE_INTERVAL_MS);
  setInterval(fetchStocks, PRICE_INTERVAL_MS);
  setInterval(refreshCryptoPortfolio, PRICE_INTERVAL_MS);
  setInterval(fetchHN, NEWS_INTERVAL_MS);
  setInterval(generateSignals, SIGNAL_INTERVAL_MS);

  // DB backup — 3am on 1st and 15th of each month (~every 14 days)
  cron.schedule("0 3 1,15 * *", () => {
    backupDb();
  });

  // OHLCV refresh — daily at 06:00, before 8am briefing (Alphavantage free tier: 25 req/day)
  cron.schedule("0 6 * * *", () => {
    fetchAndStoreOHLCV().catch((err) => console.error("OHLCV refresh failed:", err));
  });

  // Scanner — daily at 07:00, before 8am briefing (scans universe, runs ARIA filter)
  cron.schedule("0 7 * * *", () => {
    scannerService.runScan().catch((err) => console.error("Scanner failed:", err));
  });

  // Morning briefing — every weekday at 08:00 local time
  cron.schedule("0 8 * * 1-5", () => {
    generateBriefing().catch((err) => {
      console.error("Scheduled briefing failed:", err);
    });
  });

  // Evening briefing — every weekday at 18:00 (6pm). Delivered by email if SMTP configured.
  cron.schedule("0 18 * * 1-5", async () => {
    try {
      const briefing = await generateEveningBriefing();
      if (briefing?.content) {
        const sent = await sendBriefingEmail(briefing.content, `ARIA Evening Briefing — ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}`);
        if (sent) console.log("Evening briefing sent by email");
        else console.log("Evening briefing stored (email not configured)");
      }
    } catch (err) {
      console.error("Evening briefing failed:", err);
    }
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
