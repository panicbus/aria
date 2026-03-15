/**
 * Chat tool definitions and handlers; memory extraction after assistant replies.
 */

type PriceRow = { symbol: string; price: number; change_24h: number | null; source: string; updated_at: string };
type NewsRow = { id: number; title: string; url: string | null; source: string; created_at: string };
type MemoryRow = { id: number; key: string; value: string; confidence: number; source: string | null; updated_at: string; created_at: string | null };
type RiskContext = { suggested_position_size_pct: number; stop_loss_pct: number; take_profit_pct: number; risk_reward_ratio: number; confidence: string; warning?: string };

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
        const value: string | undefined = input?.value;
        if (!key || !value) return { error: "key and value are required" };
        const confidence = typeof input?.confidence === "number" ? Math.max(0, Math.min(1, input.confidence)) : 1;
        const source = input?.source === "explicit" || input?.source === "inferred" ? input.source : null;
        const updated_at = new Date().toISOString();
        const created_at = new Date().toISOString();
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
      default:
        return { error: `Unknown tool '${name}'` };
    }
  };
}

export function createRunMemoryExtraction(deps: {
  anthropic: import("@anthropic-ai/sdk").default;
  handleToolCall: (name: string, input: any) => Promise<any>;
}): (userContent: string, assistantContent: string) => Promise<void> {
  const { anthropic, handleToolCall } = deps;

  return async function runMemoryExtraction(userContent: string, assistantContent: string): Promise<void> {
    if (!process.env.ANTHROPIC_API_KEY?.trim()) return;
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
  };
}
