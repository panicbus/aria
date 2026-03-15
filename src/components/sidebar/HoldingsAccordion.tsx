import React, { useState, useEffect } from "react";

import { HoldingsCard } from "../holdings/HoldingsCard";
import { API, DASHBOARD_POLL_MS } from "../../config";
import type { Dashboard, Memory, CryptoPortfolioHolding } from "../../types";

const CARD_H = 130;
const CRYPTO_CARD_H = 72;
const GAP = 7;

export function HoldingsAccordion({
  memories,
  dashboard,
  open,
  onToggle,
  ohlcvRefreshAll,
  onRefreshAll,
}: {
  memories: Memory[];
  dashboard: Dashboard | null;
  open: boolean;
  onToggle: () => void;
  ohlcvRefreshAll: boolean;
  onRefreshAll: () => void;
}) {
  const [cryptoPortfolio, setCryptoPortfolio] = useState<CryptoPortfolioHolding[]>([]);

  useEffect(() => {
    const load = () =>
      fetch(`${API}/portfolio/crypto`)
        .then((r) => r.json())
        .then((data: CryptoPortfolioHolding[]) => setCryptoPortfolio(Array.isArray(data) ? data : []))
        .catch(() => setCryptoPortfolio([]));
    load();
    const t = setInterval(load, DASHBOARD_POLL_MS);
    return () => clearInterval(t);
  }, []);

  const positions = memories.filter((m) => m.key.startsWith("position_"));
  const cryptoSymbols = new Set(cryptoPortfolio.map((c) => c.symbol.toUpperCase()));
  const memoryPositionsFiltered = positions.filter((m) => {
    const ticker = m.key.replace(/^position_/i, "").toUpperCase();
    return !cryptoSymbols.has(ticker);
  });
  const hasCrypto = cryptoPortfolio.length > 0;
  const buyingPower = cryptoPortfolio[0]?.buying_power ?? 0;
  const isStale = cryptoPortfolio.some((c) => c.source === "robinhood_stale");

  const cryptoHeight = hasCrypto ? cryptoPortfolio.length * CRYPTO_CARD_H + (cryptoPortfolio.length - 1) * GAP : 0;
  const memoryHeight = memoryPositionsFiltered.length > 0 ? memoryPositionsFiltered.length * CARD_H + (memoryPositionsFiltered.length - 1) * GAP : 0;
  const totalContentHeight = cryptoHeight + (hasCrypto && memoryHeight > 0 ? 12 + memoryHeight : memoryHeight);
  const maxHeight = open ? (totalContentHeight > 0 ? totalContentHeight + 40 : 80) : 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <button onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
          <span style={{ transform: open ? "rotate(90deg)" : "none", display: "inline-block", fontSize: 10, color: "#555", transition: "transform 0.2s ease" }}>▶</span>
          <span style={{ fontSize: 9, letterSpacing: "0.14em", color: "#444", textTransform: "uppercase", fontFamily: "var(--mono)" }}>Holdings</span>
        </button>
        {open && (positions.length > 0 || hasCrypto) && (
          <button
            onClick={onRefreshAll}
            disabled={ohlcvRefreshAll}
            style={{ fontSize: 8, padding: "3px 6px", background: "rgba(0,255,148,0.08)", border: "1px solid rgba(0,255,148,0.2)", borderRadius: 4, color: "#00ff94", cursor: ohlcvRefreshAll ? "wait" : "pointer", fontFamily: "var(--mono)" }}
          >
            {ohlcvRefreshAll ? "Refreshing…" : "Refresh all charts"}
          </button>
        )}
      </div>
      <div style={{ overflow: "hidden", maxHeight, transition: "max-height 0.3s ease" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {hasCrypto &&
            cryptoPortfolio.map((c) => (
              <div
                key={c.symbol}
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.07)",
                  borderRadius: 8,
                  padding: "8px 10px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 11, color: "#f0f0f0" }}>{c.symbol}</span>
                  {isStale && <span style={{ fontSize: 8, color: "#ffd32a", fontFamily: "var(--mono)" }}>⚠ stale</span>}
                </div>
                <div style={{ fontSize: 10, color: "#888", fontFamily: "var(--mono)", marginBottom: 2 }}>
                  {c.quantity.toFixed(4)} {c.symbol}
                </div>
                <div style={{ fontSize: 11, fontFamily: "var(--mono)", color: "#ccc" }}>
                  ${c.market_value >= 1000 ? c.market_value.toLocaleString("en-US", { maximumFractionDigits: 0 }) : c.market_value.toFixed(2)}
                  {" "}
                  <span style={{ color: c.unrealized_pnl >= 0 ? "#00ff94" : "#ff4757" }}>
                    {c.unrealized_pnl >= 0 ? "↑" : "↓"} ${Math.abs(c.unrealized_pnl).toFixed(2)} ({c.unrealized_pnl >= 0 ? "+" : ""}{c.unrealized_pnl_pct.toFixed(1)}%)
                  </span>
                </div>
                <div style={{ fontSize: 9, color: "#444", fontFamily: "var(--mono)" }}>Avg: ${c.average_buy_price >= 1000 ? c.average_buy_price.toLocaleString("en-US", { maximumFractionDigits: 0 }) : c.average_buy_price.toFixed(2)}</div>
                <div style={{ fontSize: 8, color: "#444", fontFamily: "var(--mono)", marginTop: 2 }}>via Robinhood</div>
              </div>
            ))}
          {hasCrypto && buyingPower > 0 && (
            <div style={{ fontSize: 9, color: "#444", fontFamily: "var(--mono)" }}>Available: ${buyingPower.toLocaleString("en-US", { minimumFractionDigits: 2 })}</div>
          )}
          {!hasCrypto && (
            <div style={{ fontSize: 9, color: "#444", fontFamily: "var(--mono)", padding: 4 }}>
              Connect Robinhood in .env to see live positions
            </div>
          )}
          {memoryPositionsFiltered.length > 0 &&
            memoryPositionsFiltered.map((m) => {
              let pos: { ticker?: string; amount?: string | number; entry?: string | number; quantity?: string | number; average_cost?: string | number };
              try {
                pos = typeof m.value === "string" ? JSON.parse(m.value) : (m.value ?? {});
              } catch {
                pos = {};
              }
              const tickerFromKey = m.key.replace(/^position_/i, "").toUpperCase();
              if (!pos.ticker && tickerFromKey) pos = { ...pos, ticker: tickerFromKey };
              if (pos.quantity != null && pos.amount == null) pos = { ...pos, amount: pos.quantity };
              if (pos.average_cost != null && pos.entry == null) pos = { ...pos, entry: pos.average_cost };
              const ticker = (pos.ticker ?? tickerFromKey ?? "").toUpperCase().trim() || "—";
              const p = dashboard?.prices?.find((r) => r.symbol === ticker);
              return (
                <HoldingsCard
                  key={m.key}
                  memoryKey={m.key}
                  pos={pos}
                  currentPrice={p?.price ?? null}
                  apiBase={API}
                />
              );
            })}
          {!hasCrypto && positions.length === 0 && (
            <span style={{ fontSize: 11, color: "#444", fontFamily: "var(--mono)" }}>Add positions in Memory → Portfolio</span>
          )}
        </div>
      </div>
    </div>
  );
}
