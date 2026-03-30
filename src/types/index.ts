export type Message = {
  id?: number;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  ts?: string;
};

export type RiskContext = {
  suggested_position_size_pct: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  risk_reward_ratio: number;
  confidence: string;
  warning?: string;
};

export type IndicatorData =
  | {
      rsi?: number;
      macd?: { macd: number; signal: number; histogram: number };
      ma20?: number;
      ma50?: number;
      score?: number;
      methodology?: string;
    }
  | null;

export type Signal = {
  id: number;
  ticker: string;
  signal: string;
  reasoning: string;
  price: number;
  created_at: string;
  indicator_data?: IndicatorData;
  risk_context?: RiskContext;
};

export type PriceRow = {
  symbol: string;
  price: number;
  change_24h: number | null;
  source: string;
  updated_at: string;
};

export type NewsRow = {
  id: number;
  title: string;
  url: string | null;
  source: string;
  created_at: string;
  summary?: string | null;
};

export type Briefing = {
  id: number;
  content: string;
  created_at: string;
  type?: "morning" | "evening";
};

export type Memory = {
  id: number;
  key: string;
  value: string;
  confidence: number;
  source: string | null;
  updated_at: string;
  created_at: string | null;
};

export type Dashboard = {
  prices: PriceRow[];
  news: NewsRow[];
  tickers?: string[];
  signalsByTicker: Record<
    string,
    {
      signal: string;
      reasoning: string;
      price: number;
      indicator_data?: IndicatorData;
      risk_context?: RiskContext;
    }
  >;
};

export type ScannerResult = {
  id: number;
  symbol: string;
  signal: string;
  score: number;
  rsi: number | null;
  macd_histogram: number | null;
  price: number;
  change_24h: number | null;
  indicator_data: string | null;
  aria_reasoning: string | null;
  category: string;
  scanned_at: string;
};

export type ScannerStatus = {
  lastScan: string | null;
  tickersScanned: number;
  scanning: boolean;
  apiCallsRemaining: number;
  universeSize: number;
  pendingCount: number;
};

export type ScannerCandidate = {
  symbol: string;
  category: string;
  tier: string;
  ohlcv_days: number;
  has_sufficient_data: number;
  status: "pending" | "active" | "rejected";
  nominated_at: string;
  activated_at?: string | null;
};

export type UniverseStats = {
  total_active: number;
  total_pending: number;
  by_tier: Record<string, number>;
  by_category: Record<string, number>;
  graduating_soon: string[];
  calls_used_today: number;
  calls_remaining: number;
};

export type CryptoPortfolioHolding = {
  symbol: string;
  quantity: number;
  cost_basis: number;
  average_buy_price: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  buying_power?: number | null;
  portfolio_value?: number | null;
  source: string;
  updated_at: string;
};

export type BacktestResult = {
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
  trades: Array<{
    entry_date: string;
    exit_date: string;
    entry_price: number;
    exit_price: number;
    return_pct: number;
    signal: string;
    outcome: string;
  }>;
  equity_curve: Array<{ date: string; value: number }>;
  error?: string;
};

export interface StockNewsArticle {
  id: number;
  ticker: string;
  title: string;
  url: string;
  summary: string | null;
  source: string;
  published_at: string;
  created_at: string;
}
