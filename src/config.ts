export const API = "http://localhost:3001/api";

export const SYSTEM_NOTE =
  "ARIA is running locally. Connected to your Express server with SQLite memory.";

export const SUGGESTED_PROMPTS = [
  {
    label: "📊 Signal Summary",
    text: "Summarize my current signals and what I should do next",
  },
  {
    label: "🤖 AI Agents 2026",
    text: "What's the state of AI agents and agentic workflows in 2026?",
  },
  {
    label: "📈 Ticker Check",
    text: "Give me a signal check on the tickers in my dashboard",
  },
];

export const FALLBACK_TICKERS = ["BTC", "AMD", "AMZN", "CLS"];
export const ROBINHOOD_CRYPTO_SYMBOLS = ["BTC-USD", "ETH-USD"] as const;

export const DASHBOARD_POLL_MS = 60 * 1000; // 1 min

export const MEMORY_SECTIONS = ["portfolio", "preferences", "context"] as const;

export const RISK_OPTIONS = ["conservative", "moderate", "aggressive"];

export const SIGNALS_OPTIONS = ["daily", "weekly", "on_demand"];

export const signalColors: Record<string, string> = {
  "STRONG BUY": "#00ff94",
  BUY: "#00ff94",
  "STRONG SELL": "#ff4757",
  SELL: "#ff4757",
  HOLD: "#ffd32a",
  WATCH: "#a29bfe",
};
