/**
 * Chat tool definitions and handlers; memory extraction after assistant replies.
 */

import { SchemaType } from "@google/generative-ai";
import { generateText } from "./gemini";

type PriceRow = { symbol: string; price: number; change_24h: number | null; source: string; updated_at: string };
type NewsRow = { id: number; title: string; url: string | null; source: string; created_at: string };
type MemoryRow = { id: number; key: string; value: string; confidence: number; source: string | null; updated_at: string; created_at: string | null };
type RiskContext = { suggested_position_size_pct: number; stop_loss_pct: number; take_profit_pct: number; risk_reward_ratio: number; confidence: string; warning?: string };

export const TOOLS: any[] = [
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
        ticker: { type: "string", description: "Ticker symbol like BTC, UBER, SPY, LTBR, GDX, or GOLD." },
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
    name: "get_portfolio",
    description: "Get Nico's current crypto portfolio from Robinhood: positions (BTC, ETH), quantity, cost basis, average buy price, current price, unrealized P&L, buying power. Use when Nico asks about his positions, how much he's up or down, or buying power.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "scan_market",
    description: "Get ARIA's current top picks from the scanner. Use when Nico asks things like 'anything interesting in the market today?' or 'what should I be looking at beyond my portfolio?'. Returns signal, score, RSI, and ARIA's reasoning per ticker.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
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
  {
    name: "add_to_watchlist",
    description: "Add a ticker to Nico's watchlist. Use when Nico explicitly says 'add [ticker] to my watchlist' or 'watch [ticker]'.",
    input_schema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Ticker symbol to add (e.g. BOTZ, AMD)" },
        list: { type: "string", enum: ["core", "speculative"], description: "Which list: core (main watchlist) or speculative" },
      },
      required: ["ticker", "list"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_from_watchlist",
    description: "Remove a ticker from Nico's watchlist. Use when Nico explicitly says 'remove [ticker] from my watchlist' or 'stop watching [ticker]'.",
    input_schema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Ticker symbol to remove" },
        list: { type: "string", enum: ["core", "speculative"], description: "Which list: core or speculative" },
      },
      required: ["ticker", "list"],
      additionalProperties: false,
    },
  },
  {
    name: "add_position",
    description: "Add or update a stock/equity position in Nico's holdings. Use when Nico says he owns, bought, or is holding shares (e.g. 'I have 100 shares of AMD at $120', 'update my RDDT position: 23 shares at $45'). Always store in ONE position with ticker, quantity, and average_cost.",
    input_schema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Ticker symbol (e.g. RDDT, AMD, BRK.B)" },
        quantity: { type: "number", description: "Number of shares" },
        average_cost: { type: "number", description: "Average cost per share (entry price)" },
      },
      required: ["ticker", "quantity"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_position",
    description: "Remove a stock/equity position from Nico's holdings. Use when Nico says he sold, closed, or wants to remove a position (e.g. 'remove AMD from my holdings', 'I sold my AMD', 'close my AMD position').",
    input_schema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Ticker symbol to remove (e.g. AMD, SPY)" },
      },
      required: ["ticker"],
      additionalProperties: false,
    },
  },
];

// Gemini function declarations for tool calling
export const GEMINI_TOOLS: any[] = [
  {
    functionDeclarations: [
      { name: "get_prices", description: "Fetch the latest prices for tracked tickers from the local database." },
      { name: "get_signals", description: "Fetch the most recent BUY/SELL/HOLD/WATCH signals.", parameters: { type: SchemaType.OBJECT, properties: { limit: { type: SchemaType.INTEGER } }, required: [] } },
      { name: "get_news", description: "Fetch the latest Hacker News headlines.", parameters: { type: SchemaType.OBJECT, properties: { limit: { type: SchemaType.INTEGER } }, required: [] } },
      { name: "generate_signal", description: "Run signal logic for a specific ticker.", parameters: { type: SchemaType.OBJECT, properties: { ticker: { type: SchemaType.STRING } }, required: ["ticker"] } },
      { name: "remember", description: "Persist a fact about Nico (portfolio, preferences, risk tolerance).", parameters: { type: SchemaType.OBJECT, properties: { key: { type: SchemaType.STRING }, value: { type: SchemaType.STRING }, confidence: { type: SchemaType.NUMBER }, source: { type: SchemaType.STRING } }, required: ["key", "value"] } },
      { name: "recall", description: "Retrieve all stored memories about Nico." },
      { name: "get_risk_context", description: "Get risk framing for a ticker.", parameters: { type: SchemaType.OBJECT, properties: { ticker: { type: SchemaType.STRING } }, required: ["ticker"] } },
      { name: "get_portfolio", description: "Get Nico's crypto portfolio from Robinhood." },
      { name: "scan_market", description: "Get ARIA's top picks from the scanner." },
      { name: "web_search", description: "Search the web for current information.", parameters: { type: SchemaType.OBJECT, properties: { query: { type: SchemaType.STRING }, max_results: { type: SchemaType.INTEGER } }, required: ["query"] } },
      { name: "add_to_watchlist", description: "Add a ticker to Nico's watchlist.", parameters: { type: SchemaType.OBJECT, properties: { ticker: { type: SchemaType.STRING }, list: { type: SchemaType.STRING } }, required: ["ticker", "list"] } },
      { name: "remove_from_watchlist", description: "Remove a ticker from Nico's watchlist.", parameters: { type: SchemaType.OBJECT, properties: { ticker: { type: SchemaType.STRING }, list: { type: SchemaType.STRING } }, required: ["ticker", "list"] } },
      { name: "add_position", description: "Add or update a stock position. Use when Nico says he owns, bought, or holds shares. Provide ticker, quantity, and average_cost.", parameters: { type: SchemaType.OBJECT, properties: { ticker: { type: SchemaType.STRING }, quantity: { type: SchemaType.NUMBER }, average_cost: { type: SchemaType.NUMBER } }, required: ["ticker", "quantity"] } },
      { name: "remove_position", description: "Remove a stock position from Nico's holdings. Use when Nico says he sold, closed, or wants to remove a position.", parameters: { type: SchemaType.OBJECT, properties: { ticker: { type: SchemaType.STRING } }, required: ["ticker"] } },
    ],
  },
];

type ChatToolsDeps = {
  db: import("sql.js").Database;
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
  saveDb: () => void;
  getWatchedTickers: () => string[];
  getRiskContextForTicker: (ticker: string, signal?: string, indicatorData?: { score?: number } | null) => RiskContext;
  generateSignalForTicker: (ticker: string) => Promise<{ id: number; ticker: string; signal: string; reasoning: string; price: number; indicator_data: string | null } | null>;
  getScannerTopPicks?: (scoreMin?: number) => Array<{ symbol: string; signal: string; score: number; rsi: number | null; aria_reasoning: string | null; price: number; change_24h: number | null; category: string }>;
};

export function createHandleToolCall(deps: ChatToolsDeps): (name: string, input: any) => Promise<any> {
  const { db, execAll, saveDb, getWatchedTickers, getRiskContextForTicker, generateSignalForTicker, getScannerTopPicks } = deps;

  return async function handleToolCall(name: string, input: any): Promise<any> {
    switch (name) {
      case "get_prices": {
        const prices = execAll<PriceRow>("SELECT symbol, price, change_24h, source, updated_at FROM prices ORDER BY symbol");
        return prices;
      }
      case "get_signals": {
        const limit = typeof input?.limit === "number" && input.limit > 0 && input.limit <= 100 ? input.limit : 20;
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
        const limit = typeof input?.limit === "number" && input.limit > 0 && input.limit <= 50 ? input.limit : 10;
        const news = execAll<NewsRow>("SELECT id, title, url, source, created_at FROM news ORDER BY created_at DESC LIMIT " + limit);
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
        let value: string | undefined = input?.value;
        if (!key || !value) return { error: "key and value are required" };

        // Reject malformed position_* keys (e.g. position_AVERAGE_COST_RDDT, position_QUANTITY_RDDT)
        // Valid: position_RDDT, position_AMD. Use add_position tool for positions.
        if (key.startsWith("position_")) {
          const tickerPart = key.replace(/^position_/i, "");
          if (!/^[A-Z0-9.]{1,6}$/i.test(tickerPart) || tickerPart.includes("_")) {
            return { error: `Invalid position key '${key}'. Use add_position tool for positions (ticker, quantity, average_cost).` };
          }
        }

        const confidence = typeof input?.confidence === "number" ? Math.max(0, Math.min(1, input.confidence)) : 1;
        const source = input?.source === "explicit" || input?.source === "inferred" ? input.source : null;
        const updated_at = new Date().toISOString();
        const created_at = new Date().toISOString();

        // WAYPOINT [remember-merge]: merge array-type watchlist keys instead of overwrite
        const MERGE_ARRAY_KEYS = ["watchlist_core", "watchlist_speculative"];
        if (MERGE_ARRAY_KEYS.includes(key)) {
          const existing = execAll<{ value: string }>(
            `SELECT value FROM memories WHERE key = '${key.replace(/'/g, "''")}' LIMIT 1`
          );
          if (existing.length && existing[0].value) {
            try {
              const currentArray = JSON.parse(existing[0].value);
              const newArray = JSON.parse(value);
              if (Array.isArray(currentArray) && Array.isArray(newArray)) {
                const merged = [...new Set([...currentArray, ...newArray])];
                value = JSON.stringify(merged);
              }
            } catch {
              /* keep existing value if parse fails */
            }
          }
        }

        db.run(
          `INSERT INTO memories (key, value, confidence, source, updated_at, created_at) VALUES (:key, :value, :confidence, :source, :updated_at, :created_at)
           ON CONFLICT(key) DO UPDATE SET value = :value, confidence = :confidence, source = :source, updated_at = :updated_at`,
          { ":key": key, ":value": value, ":confidence": confidence, ":source": source, ":updated_at": updated_at, ":created_at": created_at }
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
        if (!key) {
          console.warn("[web_search] TAVILY_API_KEY not set in .env");
          return { error: "TAVILY_API_KEY not set in .env. Add it to enable web search." };
        }
        const maxResults = typeof input?.max_results === "number" && input.max_results > 0 && input.max_results <= 10 ? input.max_results : 5;
        try {
          const res = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({ query, search_depth: "basic", max_results: maxResults }),
          });
          const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }>; error?: string };
          if (!res.ok) {
            const errMsg = data?.error ?? `Tavily API error ${res.status}`;
            console.warn("[web_search] Tavily API error:", res.status, errMsg);
            return { error: errMsg };
          }
          return { results: data.results ?? [] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn("[web_search] Request failed:", msg);
          return { error: `Web search failed: ${msg}` };
        }
      }
      case "get_portfolio": {
        const rows = execAll<{
          symbol: string;
          quantity: number;
          cost_basis: number;
          average_buy_price: number;
          current_price: number;
          market_value: number;
          unrealized_pnl: number;
          unrealized_pnl_pct: number;
          buying_power: number | null;
          source: string;
        }>("SELECT symbol, quantity, cost_basis, average_buy_price, current_price, market_value, unrealized_pnl, unrealized_pnl_pct, buying_power, source FROM crypto_portfolio ORDER BY symbol");
        if (!rows.length) {
          return { message: "No portfolio data. Add Robinhood API credentials to .env to see live crypto positions.", holdings: [] };
        }
        return { holdings: rows, data_source: rows[0]?.source ?? "robinhood" };
      }
      case "scan_market": {
        const picks = getScannerTopPicks?.(0) ?? [];
        return { picks };
      }
      case "add_to_watchlist": {
        const ticker = String(input?.ticker ?? "").trim().toUpperCase();
        const list = input?.list === "speculative" ? "watchlist_speculative" : "watchlist_core";
        if (!ticker) return { error: "ticker is required" };
        const existing = execAll<{ value: string }>(`SELECT value FROM memories WHERE key = '${list}' LIMIT 1`);
        let arr: string[] = [];
        if (existing.length && existing[0].value) {
          try {
            const parsed = JSON.parse(existing[0].value);
            if (Array.isArray(parsed)) arr = parsed.map((x: unknown) => String(x).toUpperCase()).filter(Boolean);
          } catch (_) {}
        }
        if (arr.includes(ticker)) return { status: "ok", message: `${ticker} already in watchlist`, watchlist: arr };
        arr.push(ticker);
        const now = new Date().toISOString();
        db.run(
          `INSERT INTO memories (key, value, confidence, source, updated_at, created_at) VALUES (:key, :value, :confidence, :source, :updated_at, :created_at)
           ON CONFLICT(key) DO UPDATE SET value = :value, confidence = 1, source = 'explicit', updated_at = :updated_at`,
          { ":key": list, ":value": JSON.stringify(arr), ":confidence": 1, ":source": "explicit", ":updated_at": now, ":created_at": now }
        );
        saveDb();
        return { status: "ok", message: `Added ${ticker} to watchlist`, watchlist: arr };
      }
      case "remove_from_watchlist": {
        const ticker = String(input?.ticker ?? "").trim().toUpperCase();
        const list = input?.list === "speculative" ? "watchlist_speculative" : "watchlist_core";
        if (!ticker) return { error: "ticker is required" };
        const existing = execAll<{ value: string }>(`SELECT value FROM memories WHERE key = '${list}' LIMIT 1`);
        let arr: string[] = [];
        if (existing.length && existing[0].value) {
          try {
            const parsed = JSON.parse(existing[0].value);
            if (Array.isArray(parsed)) arr = parsed.map((x: unknown) => String(x).toUpperCase()).filter(Boolean);
          } catch (_) {}
        }
        const filtered = arr.filter((t) => t !== ticker);
        if (filtered.length === arr.length) return { status: "ok", message: `${ticker} was not in watchlist`, watchlist: arr };
        const now = new Date().toISOString();
        db.run(
          `INSERT INTO memories (key, value, confidence, source, updated_at, created_at) VALUES (:key, :value, :confidence, :source, :updated_at, :created_at)
           ON CONFLICT(key) DO UPDATE SET value = :value, confidence = 1, source = 'explicit', updated_at = :updated_at`,
          { ":key": list, ":value": JSON.stringify(filtered), ":confidence": 1, ":source": "explicit", ":updated_at": now, ":created_at": now }
        );
        saveDb();
        return { status: "ok", message: `Removed ${ticker} from watchlist`, watchlist: filtered };
      }
      case "add_position": {
        const ticker = String(input?.ticker ?? "").trim().toUpperCase();
        if (!ticker) return { error: "ticker is required" };
        const quantity = typeof input?.quantity === "number" ? input.quantity : parseFloat(String(input?.quantity ?? ""));
        if (isNaN(quantity) || quantity <= 0) return { error: "quantity must be a positive number" };
        const average_cost = typeof input?.average_cost === "number" ? input.average_cost : parseFloat(String(input?.average_cost ?? ""));
        const key = `position_${ticker}`;
        const value = JSON.stringify({
          ticker,
          quantity,
          amount: quantity,
          ...(isNaN(average_cost) || average_cost <= 0 ? {} : { entry: average_cost, average_cost }),
        });
        const now = new Date().toISOString();
        db.run(
          `INSERT INTO memories (key, value, confidence, source, updated_at, created_at) VALUES (:key, :value, 1, 'explicit', :updated_at, :created_at)
           ON CONFLICT(key) DO UPDATE SET value = :value, confidence = 1, source = 'explicit', updated_at = :updated_at`,
          { ":key": key, ":value": value, ":updated_at": now, ":created_at": now }
        );
        saveDb();
        return { status: "ok", message: `Updated ${ticker}: ${quantity} shares${!isNaN(average_cost) && average_cost > 0 ? ` @ $${average_cost}` : ""}` };
      }
      case "remove_position": {
        const ticker = String(input?.ticker ?? "").trim().toUpperCase();
        if (!ticker) return { error: "ticker is required" };
        const key = `position_${ticker}`;
        const existed = execAll<{ key: string }>(`SELECT key FROM memories WHERE key = '${key.replace(/'/g, "''")}' LIMIT 1`);
        db.run("DELETE FROM memories WHERE key = :key", { ":key": key });
        saveDb();
        return { status: "ok", message: existed.length ? `Removed ${ticker} from holdings` : `${ticker} was not in holdings`, removed: existed.length > 0 };
      }
      default:
        return { error: `Unknown tool '${name}'` };
    }
  };
}

export function createRunMemoryExtraction(deps: {
  handleToolCall: (name: string, input: any) => Promise<any>;
}): (userContent: string, assistantContent: string) => Promise<void> {
  const { handleToolCall } = deps;

  return async function runMemoryExtraction(userContent: string, assistantContent: string): Promise<void> {
    if (!process.env.GEMINI_API_KEY?.trim()) return;
    const prompt = `You are extracting facts from a conversation to update ARIA's memory. Follow these rules strictly:

WATCHLIST RULES (most important):
- NEVER call remember() for watchlist_core, watchlist_speculative, or watchlist unless Nico EXPLICITLY says one of these things:
  * "add [ticker] to my watchlist"
  * "remove [ticker] from my watchlist"
  * "my watchlist is [list]"
  * "watch [ticker]"
  * "stop watching [ticker]"
- Mentioning a ticker in conversation does NOT mean add it to the watchlist
- Asking about a ticker does NOT mean add it to the watchlist
- If you are not 100% certain Nico is explicitly modifying his watchlist, DO NOT call remember() for watchlist keys

POSITION RULES:
- When Nico says he owns, bought, or holds shares with quantity and/or average price, use add_position (NOT remember). Example: "I have 23 RDDT at $45" → add_position(ticker: "RDDT", quantity: 23, average_cost: 45).
- NEVER call remember() with keys like position_AVERAGE_COST_X, position_QUANTITY_X, or any position_ key that has extra words (AVERAGE_COST, QUANTITY) in it. Only position_TICKER (e.g. position_RDDT) is valid, and that should be done via add_position.
- If Nico explicitly says he sold or closed a position, use remove_position.

SAFE TO EXTRACT:
- risk_tolerance (only if explicitly stated)
- preferences (only if explicitly stated)
- learning_goals (only if explicitly stated)

WHEN IN DOUBT: Do nothing. It is always better to not extract than to overwrite correct data with partial data.

For each valid fact call remember with key, value, confidence 0-1, and source "explicit" or "inferred". If nothing qualifies, do not call tools.

Respond with a JSON array of remember calls, e.g. [{"key":"risk_tolerance","value":"moderate","confidence":1,"source":"explicit"}]. If nothing to extract, respond with [].`;
    try {
      const systemInstruction = "You extract facts from conversations. Return ONLY a JSON array of remember calls. No other text.";
      const fullPrompt = `${prompt}\n\n---\nUser: ${userContent}\n\nAssistant: ${assistantContent}`;
      const response = await generateText(fullPrompt, systemInstruction);
      const clean = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const match = clean.match(/\[[\s\S]*\]/);
      const arr = match ? (JSON.parse(match[0]) as Array<{ key: string; value: string; confidence?: number; source?: string }>) : [];
      for (const item of arr) {
        if (!item?.key || item?.value == null) continue;
        const value = typeof item.value === "object" ? JSON.stringify(item.value) : String(item.value);
        await handleToolCall("remember", { key: item.key, value, confidence: item.confidence ?? 1, source: item.source ?? "inferred" });
      }
    } catch (e) {
      console.warn("Memory extraction failed:", e);
    }
  };
}
