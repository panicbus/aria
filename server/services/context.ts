/**
 * Context builders for chat and briefings: live data, memory, risk framing.
 */

export type RiskContext = {
  suggested_position_size_pct: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  risk_reward_ratio: number;
  confidence: "low" | "medium" | "high";
  warning?: string;
};

type ContextDeps = {
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
};

export function createBuildLiveContext(deps: ContextDeps): () => string {
  const { execAll } = deps;

  return function buildLiveContext(): string {
    const prices = execAll<{ symbol: string; price: number; change_24h: number | null }>(
      "SELECT symbol, price, change_24h FROM prices ORDER BY symbol"
    );
    const signals = execAll<{ ticker: string; signal: string; reasoning: string | null }>(
      "SELECT ticker, signal, reasoning FROM signals ORDER BY created_at DESC LIMIT 10"
    );
    const portfolio = execAll<{
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

    const tz = process.env.TZ || "America/Los_Angeles";
    const asOf = new Date().toLocaleString("en-US", { timeZone: tz });

    const portfolioBlock =
      portfolio.length > 0 && !portfolio.every((p) => p.source === "robinhood_stale")
        ? `
CRYPTO PORTFOLIO (Robinhood):
${portfolio
  .map(
    (p) =>
      `${p.symbol}: ${p.quantity} @ avg $${p.average_buy_price} | now $${p.current_price} | P&L $${p.unrealized_pnl} (${p.unrealized_pnl_pct.toFixed(1)}%) | value $${p.market_value}`
  )
  .join("\n")}
Buying Power: $${portfolio[0]?.buying_power ?? 0}`
        : "";

    return `

LIVE DATA (as of ${asOf}):

PRICES:
${prices
  .map(
    (p) =>
      `${p.symbol}: $${p.price} (${
        p.change_24h != null ? (p.change_24h >= 0 ? "+" : "") + Number(p.change_24h).toFixed(1) + "% 24h" : "—"
      })`
  )
  .join("\n")}
${portfolioBlock}

LATEST SIGNALS:
${signals.map((s) => `${s.ticker}: ${s.signal} — ${s.reasoning ?? ""}`).join("\n")}
`;
  };
}

export function createBuildMemoryContext(deps: ContextDeps): () => string {
  const { execAll } = deps;

  return function buildMemoryContext(): string {
    const memories = execAll<{ key: string; value: string; confidence?: number; source?: string | null; updated_at: string }>(
      "SELECT key, value, confidence, source, updated_at FROM memories ORDER BY updated_at DESC"
    );
    if (!memories.length) {
      return `

MEMORY:
No stored memories yet. Claude can call the 'remember' tool to persist important facts about Nico.`;
    }

    const tz = process.env.TZ || "America/Los_Angeles";
    const lines = memories.map((m) => {
      const conf = m.confidence != null ? ` [confidence ${m.confidence}]` : "";
      const src = m.source ? ` (${m.source})` : "";
      const updated = m.updated_at
        ? new Date(m.updated_at).toLocaleString("en-US", { timeZone: tz })
        : "";
      return `${m.key}: ${m.value}${conf}${src} — updated ${updated}`;
    }).join("\n");
    return `

MEMORY:
${lines}`;
  };
}

export function createGetRiskContextForTicker(deps: ContextDeps): (
  ticker: string,
  signal?: string,
  indicatorData?: { score?: number } | null
) => RiskContext {
  const { execAll } = deps;

  return function getRiskContextForTicker(ticker: string, signal?: string, indicatorData?: { score?: number } | null): RiskContext {
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
  };
}
