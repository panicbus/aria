import React, { useState, useEffect, useRef } from "react";

import { API, DASHBOARD_POLL_MS, signalColors } from "../../config";
import type { CryptoPortfolioHolding, Dashboard } from "../../types";

const TZ = "America/Los_Angeles";
const formatTs = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const ASSET_NAMES: Record<string, string> = { BTC: "Bitcoin", ETH: "Ethereum" };

export function PortfolioTab({
  dashboard,
  onViewBacktest,
}: {
  dashboard: Dashboard | null;
  onViewBacktest?: (ticker: string) => void;
}) {
  const [summary, setSummary] = useState<{
    total_crypto_value: number;
    total_unrealized_pnl: number;
    total_unrealized_pnl_pct: number;
    buying_power: number;
    holdings: CryptoPortfolioHolding[];
    last_updated: string | null;
    data_source: string;
    credentials_configured?: boolean;
  } | null>(null);
  const [ariaTake, setAriaTake] = useState<{ btc: string; eth: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [ariaTakeLoading, setAriaTakeLoading] = useState(false);
  const ariaTakeFetchedAt = useRef(0);
  const ARIA_CACHE_MS = 15 * 60 * 1000;

  const loadSummary = () => {
    fetch(`${API}/portfolio/summary`)
      .then((r) => r.json())
      .then(setSummary)
      .catch(() => setSummary(null));
  };

  const loadAriaTake = (force = false) => {
    const now = Date.now();
    if (!force && ariaTake && now - ariaTakeFetchedAt.current < ARIA_CACHE_MS) return;
    setAriaTakeLoading(true);
    fetch(`${API}/portfolio/aria-take`)
      .then((r) => r.json())
      .then((data) => {
        setAriaTake(data);
        ariaTakeFetchedAt.current = now;
      })
      .catch(() => setAriaTake(null))
      .finally(() => setAriaTakeLoading(false));
  };

  useEffect(() => {
    loadSummary();
    const t = setInterval(loadSummary, DASHBOARD_POLL_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (summary?.holdings?.length) loadAriaTake();
  }, [summary?.holdings?.length]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`${API}/portfolio/refresh`, { method: "POST" });
      const data = await res.json();
      if (res.ok) setSummary(data);
    } catch (_) {}
    setRefreshing(false);
  };

  const holdings = summary?.holdings ?? [];
  const hasData = holdings.length > 0;
  const isStale = summary?.data_source === "robinhood_stale";
  const credentialsConfigured = summary?.credentials_configured ?? false;

  if (!hasData) {
    const message = credentialsConfigured
      ? "Could not load portfolio from Robinhood. Check the server console for API errors. Possible causes: wrong endpoint format, invalid signing, or no BTC/ETH positions in your account."
      : "Add your Robinhood API credentials to .env to see your live crypto portfolio here. Until then, ARIA is watching BTC and ETH market prices via CoinGecko.";
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ fontSize: 16, letterSpacing: "0.12em", color: "#555", fontFamily: "var(--mono)", marginBottom: 4 }}>PORTFOLIO</div>
        <div
          style={{
            padding: 32,
            textAlign: "center",
            color: "#555",
            fontSize: 15,
            fontFamily: "var(--body)",
            background: "rgba(255,255,255,0.02)",
            border: "1px dashed rgba(255,255,255,0.08)",
            borderRadius: 12,
          }}
        >
          {message}
        </div>
        {credentialsConfigured && (
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            style={{
              alignSelf: "center",
              fontSize: 12,
              fontFamily: "var(--mono)",
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid rgba(0,255,148,0.4)",
              background: refreshing ? "rgba(0,255,148,0.1)" : "transparent",
              color: "#00ff94",
              cursor: refreshing ? "wait" : "pointer",
            }}
          >
            {refreshing ? "Refreshing…" : "Try again"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 16, letterSpacing: "0.12em", color: "#555", fontFamily: "var(--mono)", marginBottom: 4 }}>PORTFOLIO</div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, marginBottom: 8 }}>
        <div style={{ fontSize: 14, fontFamily: "var(--mono)", color: "#888" }}>
          Total Crypto Value: <span style={{ color: "#00ff94", fontWeight: 700 }}>${(summary?.total_crypto_value ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
        </div>
        <div style={{ fontSize: 14, fontFamily: "var(--mono)", color: "#888" }}>
          Unrealized P&L:{" "}
          <span style={{ color: (summary?.total_unrealized_pnl ?? 0) >= 0 ? "#00ff94" : "#ff4757", fontWeight: 700 }}>
            ${(summary?.total_unrealized_pnl ?? 0).toFixed(2)} ({(summary?.total_unrealized_pnl_pct ?? 0) >= 0 ? "+" : ""}
            {(summary?.total_unrealized_pnl_pct ?? 0).toFixed(1)}%)
          </span>
        </div>
        <div style={{ fontSize: 14, fontFamily: "var(--mono)", color: "#888" }}>
          Buying Power: <span style={{ color: "#ccc" }}>${(summary?.buying_power ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
        </div>
        <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "#444" }}>
          Last updated: {summary?.last_updated ? formatTs(summary.last_updated) : "—"}
          {isStale && <span style={{ color: "#ffd32a", marginLeft: 8 }}>⚠ Last known data</span>}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          style={{
            fontSize: 12,
            fontFamily: "var(--mono)",
            padding: "5px 12px",
            borderRadius: 8,
            border: "1px solid rgba(0,255,148,0.4)",
            background: refreshing ? "rgba(0,255,148,0.1)" : "transparent",
            color: "#00ff94",
            cursor: refreshing ? "wait" : "pointer",
          }}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {holdings.map((h) => {
          const change24h = dashboard?.prices?.find((p) => p.symbol === h.symbol)?.change_24h ?? null;
          const signal = dashboard?.signalsByTicker?.[h.symbol];
          return (
            <div
              key={h.symbol}
              style={{
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: 12,
                padding: "16px 18px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                <div>
                  <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 18, color: "#f0f0f0" }}>{h.symbol}</span>
                  <span style={{ fontSize: 14, color: "#666", marginLeft: 8 }}>{ASSET_NAMES[h.symbol] ?? h.symbol}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {signal?.indicator_data?.rsi != null && (
                    <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: signal.indicator_data.rsi > 70 ? "#ff4757" : signal.indicator_data.rsi < 30 ? "#00ff94" : "#888" }}>
                      RSI {signal.indicator_data.rsi.toFixed(0)}
                    </span>
                  )}
                  {signal && (
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: "var(--mono)",
                      padding: "2px 8px",
                      borderRadius: 20,
                      background: `${(signalColors[signal.signal] ?? "#888")}18`,
                      border: `1px solid ${(signalColors[signal.signal] ?? "#888")}40`,
                      color: signalColors[signal.signal] ?? "#888",
                    }}
                  >
                    {signal.signal}
                  </span>
                )}
                </div>
              </div>
              <div style={{ fontSize: 24, fontWeight: 700, color: "#00ff94", fontFamily: "var(--display)", marginBottom: 8 }}>
                ${h.current_price >= 1000 ? h.current_price.toLocaleString("en-US", { maximumFractionDigits: 0 }) : h.current_price.toFixed(2)}
                {change24h != null && (
                  <span style={{ fontSize: 14, marginLeft: 8, color: change24h >= 0 ? "#00ff94" : "#ff4757" }}>
                    ({change24h >= 0 ? "+" : ""}{change24h.toFixed(1)}% 24h)
                  </span>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12, marginBottom: 12, fontSize: 12, fontFamily: "var(--mono)" }}>
                <div><span style={{ color: "#666" }}>Quantity:</span> {h.quantity.toFixed(4)}</div>
                <div><span style={{ color: "#666" }}>Avg buy:</span> ${h.average_buy_price.toFixed(2)}</div>
                <div><span style={{ color: "#666" }}>Market value:</span> ${h.market_value.toLocaleString("en-US", { minimumFractionDigits: 2 })}</div>
                <div>
                  <span style={{ color: "#666" }}>Unrealized P&L:</span>{" "}
                  <span style={{ color: h.unrealized_pnl >= 0 ? "#00ff94" : "#ff4757" }}>
                    ${h.unrealized_pnl.toFixed(2)} ({h.unrealized_pnl >= 0 ? "+" : ""}{h.unrealized_pnl_pct.toFixed(1)}%)
                  </span>
                </div>
              </div>
              {onViewBacktest && (
                <button
                  onClick={() => onViewBacktest(h.symbol)}
                  style={{
                    fontSize: 11,
                    fontFamily: "var(--mono)",
                    padding: "5px 12px",
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "transparent",
                    color: "#888",
                    cursor: "pointer",
                  }}
                >
                  View Backtest
                </button>
              )}
            </div>
          );
        })}
      </div>

      {holdings.length > 0 && (
        <div style={{ marginTop: 8, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#00ff94", fontFamily: "var(--mono)", marginBottom: 8 }}>ARIA&apos;S TAKE</div>
          {ariaTakeLoading ? (
            <div style={{ color: "#666", fontSize: 13 }}>Loading…</div>
          ) : ariaTake ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {ariaTake.btc ? <div style={{ fontSize: 14, lineHeight: 1.6, color: "#ccc" }}>{ariaTake.btc}</div> : null}
              {ariaTake.eth ? <div style={{ fontSize: 14, lineHeight: 1.6, color: "#ccc" }}>{ariaTake.eth}</div> : null}
              <button
                onClick={() => loadAriaTake(true)}
                style={{
                  fontSize: 11,
                  fontFamily: "var(--mono)",
                  color: "#00ff94",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  textDecoration: "underline",
                }}
              >
                Refresh
              </button>
            </div>
          ) : (
            <div style={{ color: "#666", fontSize: 13 }}>Unable to load ARIA&apos;s take.</div>
          )}
        </div>
      )}
    </div>
  );
}
