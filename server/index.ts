import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import Anthropic from "@anthropic-ai/sdk";
import initSqlJs from "sql.js";
import path from "path";
import fs from "fs";
import cron from "node-cron";

import { computeIndicatorsForCloses, scoreToSignal } from "./services/indicators";
import { fetchOHLCVForTicker, createFetchAndStoreOHLCV } from "./services/ohlcv";

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
const BASE_TICKERS = ["BTC", "AMD", "AMZN", "CLS"];
const CRYPTO_COINGECKO_IDS: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum" };

function getWatchedTickers(): string[] {
  if (!db) return [...BASE_TICKERS];
  const combined = [...BASE_TICKERS];

  // Watchlist (comma-separated)
  const watchRow = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'watchlist' LIMIT 1");
  const watchRaw = watchRow[0]?.value?.trim();
  if (watchRaw) {
    const fromWatch = watchRaw.split(/[\s,]+/).map((s) => s.toUpperCase()).filter((s) => s.length > 0);
    for (const t of fromWatch) {
      if (!combined.includes(t)) combined.push(t);
    }
  }

  // Position tickers (from position_XXX memories) — auto-include so holdings charts work
  const positions = execAll<{ value: string }>("SELECT value FROM memories WHERE key LIKE 'position_%'");
  for (const p of positions) {
    try {
      const parsed = JSON.parse(p.value) as { ticker?: string };
      const t = (parsed.ticker ?? "").toUpperCase().trim();
      if (t.length > 0 && !combined.includes(t)) combined.push(t);
    } catch (_) {}
  }
  return combined;
}
const HN_TOP = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_ITEM = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const PRICE_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const NEWS_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const SIGNAL_INTERVAL_MS = 5 * 60 * 1000; // 5 min (after prices)

// OHLCV: fetchAndStoreOHLCV created in start() after db init; see server/services/ohlcv.ts
let fetchAndStoreOHLCV: () => Promise<void>;

type PriceRow = {
  symbol: string;
  price: number;
  change_24h: number | null;
  source: string;
  updated_at: string;
};

type NewsRow = {
  id: number;
  title: string;
  url: string | null;
  source: string;
  created_at: string;
};

type MemoryRow = {
  id: number;
  key: string;
  value: string;
  confidence: number;
  source: string | null;
  updated_at: string;
  created_at: string | null;
};

type BriefingRow = {
  id: number;
  content: string;
  created_at: string;
};

const COINGECKO_ID_TO_SYMBOL: Record<string, string> = { bitcoin: "BTC", ethereum: "ETH" };

async function fetchCoinGecko(): Promise<void> {
  if (!db) return;
  const tickers = getWatchedTickers();
  const crypto = tickers.filter((s) => s in CRYPTO_COINGECKO_IDS);
  if (crypto.length === 0) return;
  const ids = crypto.map((s) => CRYPTO_COINGECKO_IDS[s]).filter(Boolean).join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  try {
    const res = await fetch(url);
    const data = (await res.json()) as Record<string, { usd: number; usd_24h_change?: number }>;
    const now = new Date().toISOString();
    for (const [id, v] of Object.entries(data)) {
      const symbol = COINGECKO_ID_TO_SYMBOL[id] ?? id.toUpperCase();
      const price = v.usd;
      const change = v.usd_24h_change ?? null;
      db.run(
        "INSERT OR REPLACE INTO prices (symbol, price, change_24h, source, updated_at) VALUES (:symbol, :price, :change_24h, :source, :updated_at)",
        { ":symbol": symbol, ":price": price, ":change_24h": change, ":source": "coingecko", ":updated_at": now }
      );
    }
    saveDb();
  } catch (e) {
    console.error("CoinGecko fetch error:", e);
  }
}

// Finnhub: free tier, 60 calls/min. Get key at https://finnhub.io
const FINNHUB_QUOTE = (symbol: string) =>
  `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY || ""}`;

async function fetchStocks(): Promise<void> {
  if (!db) return;
  const key = process.env.FINNHUB_API_KEY?.trim();
  if (!key) {
    console.warn("Stocks: Add FINNHUB_API_KEY to .env for UBER, SPY, LTBR, GDX, GOLD (free at finnhub.io).");
    return;
  }
  const symbols = getWatchedTickers().filter((s) => s !== "BTC"); // BTC from CoinGecko
  const now = new Date().toISOString();
  for (const symbol of symbols) {
    try {
      const res = await fetch(FINNHUB_QUOTE(symbol));
      const text = await res.text();
      if (!res.ok) {
        console.warn(`Finnhub ${symbol}: ${res.status} ${text.slice(0, 80)}`);
        continue;
      }
      const data = JSON.parse(text) as { c?: number; dp?: number };
      const price = data?.c;
      if (price == null || typeof price !== "number") continue;
      const pct = typeof data?.dp === "number" ? data.dp : null;
      db.run(
        "INSERT OR REPLACE INTO prices (symbol, price, change_24h, source, updated_at) VALUES (:symbol, :price, :change_24h, :source, :updated_at)",
        { ":symbol": symbol, ":price": price, ":change_24h": pct, ":source": "finnhub", ":updated_at": now }
      );
    } catch (e) {
      console.warn(`Finnhub ${symbol} fetch error:`, e);
    }
  }
  saveDb();
}

async function fetchHN(): Promise<void> {
  if (!db) return;
  try {
    const ids = (await (await fetch(HN_TOP)).json()) as number[];
    const top = ids.slice(0, 10);
    for (const id of top) {
      const item = (await (await fetch(HN_ITEM(id))).json()) as { title?: string; url?: string } | null;
      if (!item?.title) continue;
      const title = String(item.title).slice(0, 200);
      const url = item.url ?? null;
      db.run(
        "INSERT OR IGNORE INTO news (id, title, url, source, created_at) VALUES (:id, :title, :url, :source, :created_at)",
        { ":id": id, ":title": title, ":url": url, ":source": "hackernews", ":created_at": new Date().toISOString() }
      );
    }
    saveDb();
  } catch (e) {
    console.error("HN fetch error:", e);
  }
}

function buildLiveContext(): string {
  const prices = execAll<{ symbol: string; price: number; change_24h: number | null }>(
    "SELECT symbol, price, change_24h FROM prices ORDER BY symbol"
  );
  const signals = execAll<{ ticker: string; signal: string; reasoning: string | null }>(
    "SELECT ticker, signal, reasoning FROM signals ORDER BY created_at DESC LIMIT 10"
  );

  return `

LIVE DATA (as of ${new Date().toISOString()}):

PRICES:
${prices
  .map(
    (p) =>
      `${p.symbol}: $${p.price} (${
        p.change_24h != null ? (p.change_24h >= 0 ? "+" : "") + Number(p.change_24h).toFixed(1) + "% 24h" : "—"
      })`
  )
  .join("\n")}

LATEST SIGNALS:
${signals.map((s) => `${s.ticker}: ${s.signal} — ${s.reasoning ?? ""}`).join("\n")}
`;
}

// WAYPOINT [memory-context]
// WHAT: Loads all memories from DB and formats them for the system prompt so ARIA has Nico's context every turn.
// WHY: Persistent memory (positions, risk tolerance, preferences) grounds recommendations without vector/embedding deps.
// PHASE 4 HOOK: Same MEMORY section will include risk_tolerance and positions when we add backtesting and sizing.

function buildMemoryContext(): string {
  const memories = execAll<{ key: string; value: string; confidence?: number; source?: string | null; updated_at: string }>(
    "SELECT key, value, confidence, source, updated_at FROM memories ORDER BY updated_at DESC"
  );
  if (!memories.length) {
    return `

MEMORY:
No stored memories yet. Claude can call the 'remember' tool to persist important facts about Nico.`;
  }

  const lines = memories.map((m) => {
    const conf = m.confidence != null ? ` [confidence ${m.confidence}]` : "";
    const src = m.source ? ` (${m.source})` : "";
    return `${m.key}: ${m.value}${conf}${src} — updated ${m.updated_at}`;
  }).join("\n");
  return `

MEMORY:
${lines}`;
}

// WAYPOINT [signal-generation]
// WHAT: Derives BUY/SELL/HOLD from technical composite (RSI+MACD+MAs) when ≥50 days OHLCV; else 24h momentum fallback.
// WHY: Real indicators give Nico evidence-based signals; fallback ensures signals even with limited data.
// HOW IT HELPS NICO: Every signal comes with RSI, MACD, MAs in indicator_data — ARIA can explain the WHY.

function generateSignals(): void {
  if (!db) return;
  const priceRows = execAll<PriceRow>("SELECT symbol, price, change_24h, source FROM prices ORDER BY updated_at DESC");
  const bySymbol = new Map<string, PriceRow>();
  for (const r of priceRows) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, r);
  }

  for (const [symbol, r] of bySymbol) {
    const price = Number(r.price);
    const ohlcvRows = execAll<{ close: number }>(
      `SELECT close FROM ohlcv WHERE symbol = '${symbol}' ORDER BY date ASC`
    );
    const closes = ohlcvRows.map((row) => Number(row.close));

    let signal: string;
    let reasoning: string;
    let indicatorDataJson: string | null = null;

    const ind = computeIndicatorsForCloses(closes);
    if (ind && closes.length >= 50) {
      const res = scoreToSignal(ind.score);
      signal = res.signal;
      reasoning = res.reasoning;
      indicatorDataJson = JSON.stringify(ind);
    } else {
      const change = r.change_24h ?? 0;
      if (change >= 5) {
        signal = "WATCH";
        reasoning = `24h up ${change.toFixed(1)}%; momentum. Limited OHLCV data — using 24h fallback.`;
      } else if (change <= -5) {
        signal = "WATCH";
        reasoning = `24h down ${Math.abs(change).toFixed(1)}%; potential dip. Limited OHLCV data — using 24h fallback.`;
      } else if (change >= 2) {
        signal = "BUY";
        reasoning = `Up ${change.toFixed(1)}% 24h; trend positive. Limited OHLCV data — using 24h fallback.`;
      } else if (change <= -2) {
        signal = "SELL";
        reasoning = `Down ${Math.abs(change).toFixed(1)}% 24h; consider trimming. Limited OHLCV data — using 24h fallback.`;
      } else {
        signal = "HOLD";
        reasoning = `Flat 24h (${change.toFixed(1)}%). Limited OHLCV data — using 24h fallback.`;
      }
    }

    run(
      "INSERT INTO signals (ticker, signal, reasoning, price, indicator_data) VALUES (:ticker, :signal, :reasoning, :price, :indicator_data)",
      {
        ":ticker": symbol,
        ":signal": signal,
        ":reasoning": reasoning,
        ":price": price,
        ":indicator_data": indicatorDataJson,
      }
    );
  }
  if (bySymbol.size) saveDb();
}

async function generateSignalForTicker(ticker: string) {
  if (!db) return null;
  const symbol = ticker.toUpperCase();
  const all = execAll<PriceRow>(
    "SELECT symbol, price, change_24h, source, updated_at FROM prices ORDER BY updated_at DESC"
  );
  const target = all.find((p) => p.symbol.toUpperCase() === symbol);
  if (!target) return null;

  const price = Number(target.price);
  const ohlcvRows = execAll<{ close: number }>(
    `SELECT close FROM ohlcv WHERE symbol = '${symbol}' ORDER BY date ASC`
  );
  const closes = ohlcvRows.map((row) => Number(row.close));

  let signal: string;
  let reasoning: string;
  let indicatorDataJson: string | null = null;

  const ind = computeIndicatorsForCloses(closes);
  if (ind && closes.length >= 50) {
    const res = scoreToSignal(ind.score);
    signal = res.signal;
    reasoning = res.reasoning;
    indicatorDataJson = JSON.stringify(ind);
  } else {
    const change = target.change_24h ?? 0;
    if (change >= 5) {
      signal = "WATCH";
      reasoning = `24h up ${change.toFixed(1)}%; momentum. Limited OHLCV data — using 24h fallback.`;
    } else if (change <= -5) {
      signal = "WATCH";
      reasoning = `24h down ${Math.abs(change).toFixed(1)}%; potential dip. Limited OHLCV data — using 24h fallback.`;
    } else if (change >= 2) {
      signal = "BUY";
      reasoning = `Up ${change.toFixed(1)}% 24h; trend positive. Limited OHLCV data — using 24h fallback.`;
    } else if (change <= -2) {
      signal = "SELL";
      reasoning = `Down ${Math.abs(change).toFixed(1)}% 24h; consider trimming. Limited OHLCV data — using 24h fallback.`;
    } else {
      signal = "HOLD";
      reasoning = `Flat 24h (${change.toFixed(1)}%). Limited OHLCV data — using 24h fallback.`;
    }
  }

  const result = run(
    "INSERT INTO signals (ticker, signal, reasoning, price, indicator_data) VALUES (:ticker, :signal, :reasoning, :price, :indicator_data)",
    {
      ":ticker": symbol,
      ":signal": signal,
      ":reasoning": reasoning,
      ":price": price,
      ":indicator_data": indicatorDataJson,
    }
  );
  saveDb();

  return { id: result.lastInsertRowid, ticker: symbol, signal, reasoning, price, indicator_data: indicatorDataJson };
}

// WAYPOINT [risk-context]
// WHAT: Builds risk_context (position size, stop-loss, take-profit, R:R) from risk_tolerance memory; per-ticker for ARIA to surface in chat.
// WHY: Every signal should come with risk framing — Nico needs to know how much to risk and where to cut losses.
// HOW IT HELPS NICO: Suggested size %, stop-loss %, take-profit — personalized by risk_tolerance (conservative/moderate/aggressive).

type RiskContext = {
  suggested_position_size_pct: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  risk_reward_ratio: number;
  confidence: "low" | "medium" | "high";
  warning?: string;
};

function getRiskContextForTicker(ticker: string, signal?: string, indicatorData?: { score?: number } | null): RiskContext {
  const mem = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'risk_tolerance' LIMIT 1");
  const tol = mem[0]?.value?.toLowerCase() ?? "moderate";
  let maxPosition: number, stopLoss: number;
  if (tol.includes("conservative")) {
    maxPosition = 5;
    stopLoss = 3;
  } else if (tol.includes("aggressive")) {
    maxPosition = 20;
    stopLoss = 8;
  } else {
    maxPosition = 10;
    stopLoss = 5;
  }
  const takeProfit = stopLoss * 2;
  const rr = 2;

  let confidence: "low" | "medium" | "high" = "medium";
  if (indicatorData?.score != null) {
    const abs = Math.abs(indicatorData.score);
    if (abs >= 4) confidence = "high";
    else if (abs <= 1) confidence = "low";
  }

  let warning: string | undefined;
  const sig = (signal ?? "").toUpperCase();
  if (sig === "HOLD" || sig === "WATCH") warning = "No clear entry — consider waiting for a stronger signal.";

  return {
    suggested_position_size_pct: maxPosition,
    stop_loss_pct: stopLoss,
    take_profit_pct: takeProfit,
    risk_reward_ratio: rr,
    confidence,
    warning,
  };
}

// WAYPOINT [morning-briefing]
// WHAT: Fetches fresh prices/news, generates signals, then asks Claude for a structured briefing (market summary, signals with risk framing, HN news, one actionable recommendation).
// WHY: Gives Nico a daily digest without opening the app; stored in briefings for the Briefing tab.
// HOW IT HELPS NICO: Each recommendation includes suggested size, stop-loss, and plain-English risk statement.

async function generateBriefing(): Promise<BriefingRow | null> {
  if (!db) return null;
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env");
  }

  // Ensure fresh data
  await fetchCoinGecko();
  await fetchStocks();
  await fetchHN();
  generateSignals();

  const liveContext = buildLiveContext();
  const memoryContext = buildMemoryContext();

  const userPrompt = `Write a concise morning briefing for Nico based on the live market data, signals, news, and memory below.

Include:
- Market summary for watched tickers (BTC, UBER, SPY, LTBR, GDX, GOLD)
- Top signals with plain-English reasoning (not just BUY/SELL labels — explain why, reference RSI/MACD/MAs when available)
- For each signal recommendation: suggested position size %, stop-loss level %, and a one-sentence plain-English risk statement (e.g. "Risk 5% of portfolio, cut losses at -3%")
- Notable tech news from HN
- One specific actionable recommendation for Nico with a brief explanation of why
- 2–3 concrete action items for today

Keep it under 400 words. Frame every recommendation with risk context (suggested size, stop-loss); never overstate certainty. Use "indicators suggest" not "you should".

Risk sizing guide (from Nico's risk_tolerance in memory): conservative = max 5% per position, stop -3%; moderate = 10%, stop -5%; aggressive = 20%, stop -8%. Default to moderate if not specified.

${liveContext}
${memoryContext}
`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 800,
    system:
      "You are ARIA writing a sharp, no-fluff morning briefing for Nico. Be direct, structured, and concrete. Use short sections and bullets.",
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((c: any) => c.type === "text") as { text: string } | undefined;
  const content = textBlock?.text?.trim();
  if (!content) return null;

  const created_at = new Date().toISOString();
  const result = run("INSERT INTO briefings (content, created_at) VALUES (:content, :created_at)", {
    ":content": content,
    ":created_at": created_at,
  });
  saveDb();

  const rows = execAll<BriefingRow>(
    `SELECT id, content, created_at FROM briefings WHERE id = ${result.lastInsertRowid} LIMIT 1`
  );
  return rows[0] ?? null;
}

// Helper: call Tavily search (used by web_search tool and evening briefing)
async function tavilySearch(query: string, maxResults = 5): Promise<Array<{ title: string; url: string; content: string }>> {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key) return [];
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, search_depth: "basic", max_results: maxResults }),
    });
    const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> };
    return res.ok ? (data.results ?? []) : [];
  } catch (_) {
    return [];
  }
}

// WAYPOINT [evening-briefing]
// WHAT: 6pm weekday briefing — upside tickers, market-moving news, portfolio snapshot, tech/AI pulse. Delivered by email if configured.
async function generateEveningBriefing(): Promise<BriefingRow | null> {
  if (!db) return null;
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return null;

  await fetchCoinGecko();
  await fetchStocks();
  await fetchHN();
  generateSignals();

  const liveContext = buildLiveContext();
  const memoryContext = buildMemoryContext();

  // Web search for evening-specific content
  const [upsideSearch, newsSearch, techSearch] = await Promise.all([
    tavilySearch("stocks to watch tomorrow analyst picks momentum upgrades", 5),
    tavilySearch("earnings calendar this week Fed meeting economic data releases market moving events", 5),
    tavilySearch("tech stocks AI industry news today", 4),
  ]);

  const formatResults = (results: Array<{ title: string; url: string; content: string }>) =>
    results.length === 0
      ? "(No web results — use your knowledge if relevant)"
      : results.map((r) => `• ${r.title}\n  ${(r.content ?? "").slice(0, 250)}${(r.content ?? "").length > 250 ? "…" : ""}`).join("\n\n");

  const userPrompt = `Write a concise evening briefing for Nico (6pm). Include these four sections:

## 1. Tickers with upside potential tomorrow
Use the web search results below. Pick 2–4 tickers that could move up (analyst upgrades, momentum, catalysts). They don't have to be in Nico's watchlist. For each: ticker, brief reason, and one-line risk note.

## 2. Big news with money-making implications
From the web search: earnings, Fed, economic data, or other events that could move markets. What's coming up and why it matters. Be specific (dates, names).

## 3. Your portfolio snapshot
From Nico's positions and watchlist in memory: quick take on each holding. Reference our signals and risk context. Any alerts or suggested tweaks. Keep it tight.

## 4. Tech & AI pulse
From the web search: notable moves in tech/AI that could affect Nico's work or investments. He's a frontend dev in the Bay Area; surface what's relevant.

Keep total under 500 words. Be direct. Use bullets. Frame every recommendation with "indicators suggest" or similar; never guarantee. Risk sizing guide from memory: conservative 5%/-3%, moderate 10%/-5%, aggressive 20%/-8%.

--- Web search: upside tickers ---
${formatResults(upsideSearch)}
--- Web search: market-moving news ---
${formatResults(newsSearch)}
--- Web search: tech/AI ---
${formatResults(techSearch)}

--- Live market data ---
${liveContext}
--- Memory ---
${memoryContext}
`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1200,
    system:
      "You are ARIA writing a sharp evening briefing for Nico. Four sections. Direct, concrete, no fluff. Use short bullets.",
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((c: any) => c.type === "text") as { text: string } | undefined;
  const content = textBlock?.text?.trim();
  if (!content) return null;

  const created_at = new Date().toISOString();
  const result = run("INSERT INTO briefings (content, created_at) VALUES (:content, :created_at)", {
    ":content": content,
    ":created_at": created_at,
  });
  saveDb();

  const rows = execAll<BriefingRow>(
    `SELECT id, content, created_at FROM briefings WHERE id = ${result.lastInsertRowid} LIMIT 1`
  );
  return rows[0] ?? null;
}

async function sendBriefingEmail(content: string, subject: string): Promise<boolean> {
  const to = process.env.BRIEFING_EMAIL_TO?.trim();
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  if (!to || !host || !user || !pass) return false;

  try {
    const transporter = nodemailer.createTransport({
      host,
      port: parseInt(process.env.SMTP_PORT ?? "587", 10),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user, pass },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM?.trim() || user,
      to,
      subject,
      text: content,
      html: content.replace(/\n/g, "<br>"),
    });
    return true;
  } catch (e) {
    console.error("Briefing email failed:", e);
    return false;
  }
}

const tools: any[] = [
  {
    name: "get_prices",
    description: "Fetch the latest prices for tracked tickers (BTC, UBER, SPY, LTBR, GDX, GOLD) from the local database.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_signals",
    description: "Fetch the most recent BUY/SELL/HOLD/WATCH signals from the local database.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", description: "Max number of signals to return", default: 20 } },
      additionalProperties: false,
    },
  },
  {
    name: "get_news",
    description: "Fetch the latest Hacker News headlines that have already been stored in the database.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", description: "Max number of headlines to return", default: 10 } },
      additionalProperties: false,
    },
  },
  {
    name: "generate_signal",
    description: "Run ARIA's signal logic for a specific ticker using the latest price and 24h change in the DB.",
    input_schema: {
      type: "object",
      properties: {
        ticker: {
          type: "string",
          description: "Ticker symbol like BTC, UBER, SPY, LTBR, GDX, or GOLD.",
        },
      },
      required: ["ticker"],
      additionalProperties: false,
    },
  },
  {
    name: "remember",
    description:
      "Persist an important fact about Nico (portfolio, positions, preferences, risk tolerance, goals, patterns). Value should be a JSON string when storing structured data.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "A short key, e.g. risk_tolerance, watchlist, positions." },
        value: { type: "string", description: "The fact to remember (plain string or JSON)." },
        confidence: { type: "number", description: "How certain ARIA is, 0-1. Default 1." },
        source: { type: "string", description: "Either 'explicit' (Nico said it) or 'inferred'." },
      },
      required: ["key", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "recall",
    description: "Retrieve all stored memories about Nico to ground recommendations and reasoning.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_risk_context",
    description: "Get risk framing for a ticker: suggested position size %, stop-loss %, take-profit %, risk:reward, confidence. Use when Nico asks about risk or position sizing for a specific ticker.",
    input_schema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Ticker symbol (BTC, UBER, SPY, LTBR, GDX, GOLD)." },
      },
      required: ["ticker"],
      additionalProperties: false,
    },
  },
  {
    name: "web_search",
    description: "Search the web for current information. Use when Nico asks about recent events, news, facts, or topics you don't have in your database (e.g. 'what's the latest on X?', 'why did Y move?', 'what are developers saying about Z?'). Prefer get_news and get_prices for data you already have.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (e.g. 'NVDA earnings March 2025', 'AI agents 2026')" },
        max_results: { type: "integer", description: "Max number of results to return", default: 5 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

async function handleToolCall(name: string, input: any): Promise<any> {
  switch (name) {
    case "get_prices": {
      const prices = execAll<PriceRow>("SELECT symbol, price, change_24h, source, updated_at FROM prices ORDER BY symbol");
      return prices;
    }
    case "get_signals": {
      const limit =
        typeof input?.limit === "number" && input.limit > 0 && input.limit <= 100 ? input.limit : 20;
      const signals = execAll<{ ticker: string; signal: string; reasoning: string; price: number; created_at: string; indicator_data: string | null }>(
        "SELECT ticker, signal, reasoning, price, created_at, indicator_data FROM signals ORDER BY created_at DESC LIMIT " + limit
      );
      let methodology = "24h_momentum";
      if (signals.length && signals[0].indicator_data) {
        try {
          const parsed = JSON.parse(signals[0].indicator_data) as { methodology?: string };
          if (parsed?.methodology) methodology = parsed.methodology;
        } catch (_) {}
      }
      return { methodology, signals };
    }
    case "get_news": {
      const limit =
        typeof input?.limit === "number" && input.limit > 0 && input.limit <= 50 ? input.limit : 10;
      const news = execAll<NewsRow>(
        "SELECT id, title, url, source, created_at FROM news ORDER BY created_at DESC LIMIT " + limit
      );
      return news;
    }
    case "generate_signal": {
      const ticker: string | undefined = input?.ticker;
      if (!ticker) return { error: "ticker is required" };
      const result = await generateSignalForTicker(ticker);
      return result ?? { error: `No price data found for ${ticker}` };
    }
    case "remember": {
      const key: string | undefined = input?.key;
      const value: string | undefined = input?.value;
      if (!key || !value) return { error: "key and value are required" };
      const confidence = typeof input?.confidence === "number" ? Math.max(0, Math.min(1, input.confidence)) : 1;
      const source = input?.source === "explicit" || input?.source === "inferred" ? input.source : null;
      const updated_at = new Date().toISOString();
      const created_at = new Date().toISOString();
      db.run(
        `INSERT INTO memories (key, value, confidence, source, updated_at, created_at) VALUES (:key, :value, :confidence, :source, :updated_at, :created_at)
         ON CONFLICT(key) DO UPDATE SET value = :value, confidence = :confidence, source = :source, updated_at = :updated_at`,
        {
          ":key": key,
          ":value": value,
          ":confidence": confidence,
          ":source": source,
          ":updated_at": updated_at,
          ":created_at": created_at,
        }
      );
      saveDb();
      return { status: "ok" };
    }
    case "recall": {
      const memories = execAll<MemoryRow>(
        "SELECT id, key, value, confidence, source, updated_at, created_at FROM memories ORDER BY updated_at DESC"
      );
      return memories;
    }
    case "get_risk_context": {
      const ticker: string | undefined = input?.ticker;
      if (!ticker) return { error: "ticker is required" };
      const sym = ticker.toUpperCase();
      if (!getWatchedTickers().includes(sym)) return { error: `Unknown ticker. Watched: ${getWatchedTickers().join(", ")}` };
      const latest = execAll<{ signal: string; indicator_data: string | null }>(
        `SELECT signal, indicator_data FROM signals WHERE ticker = '${sym}' ORDER BY created_at DESC LIMIT 1`
      );
      const sig = latest[0]?.signal;
      let ind: { score?: number } | null = null;
      if (latest[0]?.indicator_data) {
        try {
          ind = JSON.parse(latest[0].indicator_data);
        } catch (_) {}
      }
      return getRiskContextForTicker(sym, sig, ind);
    }
    case "web_search": {
      const query = String(input?.query ?? "").trim();
      if (!query) return { error: "query is required" };
      const key = process.env.TAVILY_API_KEY?.trim();
      if (!key) return { error: "TAVILY_API_KEY not set in .env. Add it to enable web search." };
      const maxResults = typeof input?.max_results === "number" && input.max_results > 0 && input.max_results <= 10 ? input.max_results : 5;
      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ query, search_depth: "basic", max_results: maxResults }),
        });
        const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }>; error?: string };
        if (!res.ok) return { error: data?.error ?? `Tavily API error ${res.status}` };
        return { results: data.results ?? [] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { error: `Web search failed: ${msg}` };
      }
    }
    default:
      return { error: `Unknown tool '${name}'` };
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ARIA online", timestamp: new Date().toISOString() });
});

// Claude connectivity test (curl http://localhost:3001/api/claude-test)
app.get("/api/claude-test", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    return res.status(500).json({ ok: false, error: "ANTHROPIC_API_KEY not set" });
  }
  try {
    const r = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 20,
      messages: [{ role: "user", content: "Say 'ok' only." }],
    });
    const text = (r.content[0] as { type: string; text?: string })?.text ?? "";
    res.json({ ok: true, reply: text.trim() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Claude test error:", msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

// WAYPOINT [tool-calling]
// WHAT: Sends tools to Claude; on tool_use, runs handlers and sends tool_result back; repeats until Claude returns only text.
// WHY: ARIA can fetch prices/signals/news and generate_signal on demand; remember/recall for persistent context.
// PHASE 4 HOOK: generate_signal will call richer indicator logic; get_signals returns methodology and indicator_data.

// WAYPOINT [memory-extraction]
// WHAT: After each assistant reply, a lightweight Claude call reviews the last user+assistant exchange and calls remember() for new facts.
// WHY: ARIA accumulates positions, risk tolerance, preferences without Nico saying "remember this."
// PHASE 4 HOOK: Extracted risk_tolerance and positions drive backtest and sizing in Phase 4.

const REMEMBER_TOOL = {
  name: "remember",
  description: "Persist a fact about Nico (portfolio, preferences, risk tolerance, goals). Key e.g. risk_tolerance, watchlist. Value string or JSON. confidence 0-1, source 'explicit' or 'inferred'.",
  input_schema: {
    type: "object",
    properties: { key: { type: "string" }, value: { type: "string" }, confidence: { type: "number" }, source: { type: "string", enum: ["explicit", "inferred"] } },
    required: ["key", "value"],
    additionalProperties: false,
  },
};

async function runMemoryExtraction(userContent: string, assistantContent: string): Promise<void> {
  if (!db || !process.env.ANTHROPIC_API_KEY?.trim()) return;
  const prompt = `Review this exchange. Extract any new facts about Nico (portfolio, positions, preferences, goals, risk tolerance, decisions, patterns). For each fact call remember with key, value, confidence 0-1, and source "explicit" or "inferred". If nothing new, do not call tools.`;
  try {
    const r = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 500,
      tools: [REMEMBER_TOOL],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: `${prompt}\n\n---\nUser: ${userContent}\n\nAssistant: ${assistantContent}` }],
    } as any);
    const toolUses = (r.content as any[]).filter((c: any) => c.type === "tool_use");
    for (const tu of toolUses as Array<{ name: string; input: any }>) {
      if (tu.name === "remember") await handleToolCall("remember", tu.input);
    }
  } catch (e) {
    console.warn("Memory extraction failed:", e);
  }
}

// Chat
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  db.run("INSERT INTO messages (role, content) VALUES (:role, :content)", {
    ":role": "user",
    ":content": message,
  });
  saveDb();

  const rows = execAll<{ role: string; content: string }>(
    "SELECT role, content FROM messages ORDER BY created_at DESC LIMIT 20"
  );
  const history = rows.reverse();

  const liveContext = buildLiveContext();
  const memoryContext = buildMemoryContext();
  const systemPrompt = SYSTEM_PROMPT + memoryContext + liveContext;

  try {
    const baseMessages = history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    let currentMessages: any[] = [...baseMessages];
    let finalResponse: any = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      system: systemPrompt,
      tools,
      tool_choice: { type: "auto" },
      messages: currentMessages,
    } as any);

    while (true) {
      const toolUses = (finalResponse.content as any[]).filter((c: any) => c.type === "tool_use");
      if (toolUses.length === 0) break;

      const toolResultBlocks: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
      for (const tu of toolUses as Array<{ id: string; name: string; input: any }>) {
        const result = await handleToolCall(tu.name, tu.input);
        toolResultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      currentMessages = [
        ...currentMessages,
        { role: "assistant", content: finalResponse.content },
        { role: "user", content: toolResultBlocks },
      ];
      finalResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        system: systemPrompt,
        tools,
        tool_choice: { type: "auto" },
        messages: currentMessages,
      } as any);
    }

    const textBlock = (finalResponse.content as any[]).find((c: any) => c.type === "text") as { text: string } | undefined;
    const reply = textBlock?.text ?? "";

    db.run("INSERT INTO messages (role, content) VALUES (:role, :content)", {
      ":role": "assistant",
      ":content": reply,
    });
    saveDb();

    runMemoryExtraction(message, reply).catch((e) => console.warn("Memory extraction:", e));

    res.json({ reply });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Claude API error:", msg);
    res.status(500).json({ error: "Claude API error", detail: msg });
  }
});

// Get chat history
app.get("/api/history", (req, res) => {
  const messages = execAll("SELECT * FROM messages ORDER BY created_at ASC LIMIT 100");
  res.json(messages);
});

// Save a signal
app.post("/api/signals", (req, res) => {
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

// Get recent signals (with indicator_data and risk_context)
app.get("/api/signals", (req, res) => {
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

// Briefings
app.get("/api/briefings", (req, res) => {
  const briefings = execAll<BriefingRow>(
    "SELECT id, content, created_at FROM briefings ORDER BY created_at DESC LIMIT 5"
  );
  res.json(briefings);
});

app.post("/api/briefings/generate", async (req, res) => {
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
        ? " — Check your network, firewall, or proxy. If behind a VPN/corporate proxy, it may be blocking api.anthropic.com."
        : "";
    res.status(500).json({ error: "Briefing generation error", detail: message + hint });
  }
});

app.post("/api/briefings/generate-evening", async (req, res) => {
  try {
    const briefing = await generateEveningBriefing();
    if (!briefing) {
      return res.status(500).json({ error: "Failed to generate evening briefing" });
    }
    const sent = await sendBriefingEmail(briefing.content, `ARIA Evening Briefing — ${new Date().toLocaleDateString()}`);
    res.json({ ...briefing, email_sent: sent });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Evening briefing error:", message);
    res.status(500).json({ error: "Evening briefing failed", detail: message });
  }
});

// Get latest prices (for sidebar)
app.get("/api/prices", (req, res) => {
  const prices = execAll<PriceRow>("SELECT symbol, price, change_24h, source, updated_at FROM prices ORDER BY symbol");
  res.json(prices);
});

// Get tech news (HN)
app.get("/api/news", (req, res) => {
  const news = execAll<NewsRow>("SELECT id, title, url, source, created_at FROM news ORDER BY created_at DESC LIMIT 15");
  res.json(news);
});

// Dashboard aggregate (prices + news + latest signals with indicator_data and risk_context)
app.get("/api/dashboard", (req, res) => {
  const prices = execAll<PriceRow>("SELECT symbol, price, change_24h, source, updated_at FROM prices ORDER BY symbol");
  const news = execAll<NewsRow>("SELECT id, title, url, source, created_at FROM news ORDER BY created_at DESC LIMIT 10");
  const signals = execAll<{ ticker: string; signal: string; reasoning: string; price: number; created_at: string; indicator_data: string | null }>(
    "SELECT ticker, signal, reasoning, price, created_at, indicator_data FROM signals ORDER BY created_at DESC LIMIT 10"
  );
  const byTicker = new Map<string, { signal: string; reasoning: string; price: number; indicator_data?: unknown; risk_context: RiskContext }>();
  for (const s of signals) {
    if (!byTicker.has(s.ticker)) {
      let ind: { score?: number } | null = null;
      if (s.indicator_data) {
        try {
          ind = JSON.parse(s.indicator_data);
        } catch (_) {}
      }
      byTicker.set(s.ticker, {
        signal: s.signal,
        reasoning: s.reasoning,
        price: s.price,
        indicator_data: ind,
        risk_context: getRiskContextForTicker(s.ticker, s.signal, ind),
      });
    }
  }
  res.json({ prices, news, tickers: getWatchedTickers(), signalsByTicker: Object.fromEntries(byTicker) });
});

// Clear history (useful during dev)
app.delete("/api/history", (req, res) => {
  db.run("DELETE FROM messages");
  saveDb();
  res.json({ cleared: true });
});

// WAYPOINT [memories-api]
// WHAT: GET returns all memories; POST create/update; DELETE one by key or clear all; GET /export for JSON.
// WHY: Lets Nico view, add, edit memories from the Memory tab; supports transparency and manual overrides.
// HOW IT HELPS NICO: Add positions, set preferences, export for backup — full control over what ARIA knows.

app.get("/api/memories", (req, res) => {
  const memories = execAll<MemoryRow>(
    "SELECT id, key, value, confidence, source, updated_at, created_at FROM memories ORDER BY updated_at DESC"
  );
  res.json(memories);
});

app.get("/api/memories/export", (req, res) => {
  const memories = execAll<MemoryRow>(
    "SELECT key, value, confidence, source, updated_at FROM memories ORDER BY key"
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

app.post("/api/memories/import", (req, res) => {
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
  res.json({ imported: count });
});

app.post("/api/memories", (req, res) => {
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
  const row = execAll<MemoryRow>(`SELECT id, key, value, confidence, source, updated_at, created_at FROM memories WHERE key = '${String(key).replace(/'/g, "''")}'`);
  res.json(row[0] ?? { key, value: valueStr, confidence: conf, source: src, updated_at, created_at });
});

app.delete("/api/memories", (req, res) => {
  db.run("DELETE FROM memories");
  saveDb();
  res.json({ cleared: true });
});

app.delete("/api/memories/:key", (req, res) => {
  const key = req.params.key;
  if (!key) return res.status(400).json({ error: "key required" });
  db.run("DELETE FROM memories WHERE key = :key", { ":key": key });
  saveDb();
  res.json({ deleted: key });
});

// WAYPOINT [ohlcv-api]
// WHAT: GET /api/ohlcv/:symbol?days=90 returns historical OHLCV for a ticker, sorted by date desc.
// WHY: Frontend chart and backtest need historical bars; this serves them from the local DB.
// HOW IT HELPS NICO: Enables price charts and equity curve visualization without hitting Alphavantage on every request.

app.get("/api/ohlcv/status", (req, res) => {
  if (!db) return res.json({ tickers: {} });
  const rows = execAll<{ symbol: string; cnt: number }>(
    "SELECT symbol, COUNT(*) AS cnt FROM ohlcv GROUP BY symbol"
  );
  const tickers: Record<string, number> = {};
  for (const r of rows) tickers[r.symbol] = r.cnt;
  res.json({ tickers, watched: getWatchedTickers() });
});

app.get("/api/ohlcv/:symbol", (req, res) => {
  const symbol = String(req.params.symbol || "").toUpperCase();
  const days = Math.min(365, Math.max(1, parseInt(String(req.query.days || 90), 10) || 90));
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  const watched = getWatchedTickers();
  if (!watched.includes(symbol)) {
    return res.status(400).json({ error: `Unknown symbol. Watched: ${watched.join(", ")}` });
  }
  const rows = execAll<{ date: string; open: number; high: number; low: number; close: number; volume: number }>(
    `SELECT date, open, high, low, close, volume FROM ohlcv WHERE symbol = '${symbol}' ORDER BY date DESC LIMIT ${days}`
  );
  res.json(rows.reverse()); // Chronological for charts
});

app.post("/api/ohlcv/refresh-all", (_req, res) => {
  res.status(202).json({ message: "OHLCV refresh started in background (takes ~13s per ticker)" });
  fetchAndStoreOHLCV().catch((err) => console.error("OHLCV refresh-all failed:", err));
});

app.post("/api/ohlcv/refresh/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol || "").toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  const watched = getWatchedTickers();
  if (!watched.includes(symbol)) {
    return res.status(400).json({ error: `Symbol ${symbol} not in watched list. Add to Memory watchlist or as a position.` });
  }
  try {
    const result = await fetchOHLCVForTicker(symbol, { cryptoIds: CRYPTO_COINGECKO_IDS });
    if (!result || !result.rows?.length) {
      let detail = "No data returned";
      if (result?.raw) {
        try {
          const parsed = JSON.parse(result.raw) as Record<string, string>;
          detail = parsed.Note ?? parsed["Error Message"] ?? detail;
        } catch (_) {}
      }
      return res.status(502).json({ error: "Alphavantage returned no data", detail });
    }
    for (const r of result.rows) {
      db.run(
        `INSERT OR IGNORE INTO ohlcv (symbol, date, open, high, low, close, volume, source, created_at)
         VALUES (:symbol, :date, :open, :high, :low, :close, :volume, :source, :created_at)`,
        {
          ":symbol": r.symbol,
          ":date": r.date,
          ":open": r.open,
          ":high": r.high,
          ":low": r.low,
          ":close": r.close,
          ":volume": r.volume,
          ":source": "alphavantage",
          ":created_at": new Date().toISOString(),
        }
      );
    }
    saveDb();
    res.json({ ok: true, symbol, rows: result.rows.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: "Refresh failed", detail: msg });
  }
});

// WAYPOINT [backtest-engine]
// WHAT: Simulates trading on historical OHLCV using the same composite indicator logic; returns trades, summary stats, equity curve.
// WHY: Nico needs evidence for whether ARIA's signals would have worked historically — backtest provides that proof.
// HOW IT HELPS NICO: Total return vs buy-and-hold, win rate, max drawdown — clear metrics to trust (or question) a signal.

type BacktestTrade = {
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  return_pct: number;
  signal: string;
  outcome: "win" | "loss";
};

function runBacktest(ticker: string, days: number): {
  ticker: string;
  days: number;
  summary: {
    total_return_pct: number;
    buy_and_hold_pct: number;
    win_rate: number;
    num_trades: number;
    best_trade_pct: number;
    worst_trade_pct: number;
    max_drawdown_pct: number;
  };
  trades: BacktestTrade[];
  equity_curve: { date: string; value: number }[];
  error?: string;
} | null {
  if (!db) return null;
  if (!getWatchedTickers().includes(ticker)) return null;

  const rows = execAll<{ date: string; open: number; high: number; low: number; close: number; volume: number }>(
    `SELECT date, open, high, low, close, volume FROM ohlcv WHERE symbol = '${ticker}' ORDER BY date ASC LIMIT ${days + 100}`
  );
  if (rows.length < 50) {
    return {
      ticker,
      days,
      summary: { total_return_pct: 0, buy_and_hold_pct: 0, win_rate: 0, num_trades: 0, best_trade_pct: 0, worst_trade_pct: 0, max_drawdown_pct: 0 },
      trades: [],
      equity_curve: [],
      error: `Insufficient OHLCV data: need at least 50 days, got ${rows.length}`,
    };
  }

  const closes = rows.map((r) => Number(r.close));
  const trades: BacktestTrade[] = [];
  const equityCurve: { date: string; value: number }[] = [];
  const startCapital = 1000;
  let capital = startCapital;
  let position: { shares: number; entryPrice: number; entryDate: string } | null = null;
  let peak = startCapital;
  let maxDrawdown = 0;

  for (let i = 49; i < rows.length; i++) {
    const slice = closes.slice(0, i + 1);
    const ind = computeIndicatorsForCloses(slice);
    const signal = ind ? scoreToSignal(ind.score).signal : "HOLD";
    const row = rows[i];
    const date = row.date;
    const nextRow = rows[i + 1];
    const execOpen = nextRow ? Number(nextRow.open) : Number(row.close);
    const execDate = nextRow ? nextRow.date : date;

    if (position && (signal === "SELL" || signal === "STRONG SELL")) {
      const exitPrice = execOpen;
      const returnPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
      capital += position.shares * exitPrice;
      trades.push({
        entry_date: position.entryDate,
        exit_date: execDate,
        entry_price: position.entryPrice,
        exit_price: exitPrice,
        return_pct: returnPct,
        signal,
        outcome: returnPct > 0 ? "win" : "loss",
      });
      position = null;
    } else if (!position && (signal === "BUY" || signal === "STRONG BUY") && capital > 0 && nextRow) {
      const shares = capital / execOpen;
      position = { shares, entryPrice: execOpen, entryDate: execDate };
      capital = 0;
    }

    const close = Number(row.close);
    const portfolioValue = position ? position.shares * close : capital;
    equityCurve.push({ date, value: portfolioValue });
    if (portfolioValue > peak) peak = portfolioValue;
    const dd = ((peak - portfolioValue) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  if (position) {
    const lastRow = rows[rows.length - 1];
    const exitPrice = Number(lastRow.close);
    const returnPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
    capital += position.shares * exitPrice;
    trades.push({
      entry_date: position.entryDate,
      exit_date: lastRow.date,
      entry_price: position.entryPrice,
      exit_price: exitPrice,
      return_pct: returnPct,
      signal: "HOLD",
      outcome: returnPct > 0 ? "win" : "loss",
    });
  }

  const finalValue = capital;
  const totalReturnPct = ((finalValue - startCapital) / startCapital) * 100;
  const firstClose = Number(rows[0].close);
  const lastClose = Number(rows[rows.length - 1].close);
  const buyAndHoldPct = ((lastClose - firstClose) / firstClose) * 100;
  const winRate = trades.length ? (trades.filter((t) => t.outcome === "win").length / trades.length) * 100 : 0;
  const bestTrade = trades.length ? Math.max(...trades.map((t) => t.return_pct)) : 0;
  const worstTrade = trades.length ? Math.min(...trades.map((t) => t.return_pct)) : 0;

  return {
    ticker,
    days,
    summary: {
      total_return_pct: totalReturnPct,
      buy_and_hold_pct: buyAndHoldPct,
      win_rate: winRate,
      num_trades: trades.length,
      best_trade_pct: bestTrade,
      worst_trade_pct: worstTrade,
      max_drawdown_pct: maxDrawdown,
    },
    trades,
    equity_curve: equityCurve,
  };
}

app.get("/api/backtest", (req, res) => {
  const ticker = String(req.query.ticker || "").toUpperCase();
  const days = Math.min(365, Math.max(30, parseInt(String(req.query.days || 90), 10) || 90));
  if (!ticker) return res.status(400).json({ error: "ticker required" });
  const watched = getWatchedTickers();
  if (!watched.includes(ticker)) {
    return res.status(400).json({ error: `Unknown ticker. Watched: ${watched.join(", ")}` });
  }
  const result = runBacktest(ticker, days);
  if (!result) return res.status(500).json({ error: "Backtest failed" });
  if (result.error) return res.status(400).json({ error: result.error, ...result });
  res.json(result);
});

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
      created_at TEXT NOT NULL
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
  saveDb();

  fetchAndStoreOHLCV = createFetchAndStoreOHLCV({
    getWatchedTickers,
    db,
    saveDb,
    cryptoIds: CRYPTO_COINGECKO_IDS,
  });

  // Start server immediately so the app is reachable. Run initial fetches in background.
  const hasKey = !!process.env.ANTHROPIC_API_KEY?.trim();
  console.log(`  Claude API key: ${hasKey ? "present" : "MISSING — add ANTHROPIC_API_KEY to .env"}`);

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
    await fetchCoinGecko();
    await fetchStocks();
    await fetchHN();
    await fetchAndStoreOHLCV();
    generateSignals();
  }).catch((err) => console.error("Initial fetch failed:", err));

  setInterval(fetchCoinGecko, PRICE_INTERVAL_MS);
  setInterval(fetchStocks, PRICE_INTERVAL_MS);
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
        const sent = await sendBriefingEmail(briefing.content, `ARIA Evening Briefing — ${new Date().toLocaleDateString()}`);
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
