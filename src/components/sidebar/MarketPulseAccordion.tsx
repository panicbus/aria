import React, { useState, useEffect } from "react";

import { MetricCard } from "../ui/MetricCard";
import { API, DASHBOARD_POLL_MS } from "../../config";

type MarketHealthItem = {
  symbol: string;
  price: number | null;
  change_24h: number | null;
  signal: string | null;
  score: number | null;
  rsi: number | null;
  updated_at: string | null;
};

type ScannerPick = {
  symbol: string;
  signal: string;
  score: number;
  rsi: number | null;
  aria_reasoning: string | null;
  category: string;
  price: number | null;
  change_24h: number | null;
};

type MarketHealthResponse = {
  marketHealth: MarketHealthItem[];
  scannerPicks: ScannerPick[];
};

const ACCORDION_HEADER: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: "0.1em",
  color: "#ccc",
  textTransform: "uppercase",
  fontFamily: "var(--mono)",
  fontWeight: 500,
};

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.1em",
  color: "#888",
  textTransform: "uppercase",
  fontFamily: "var(--mono)",
  fontWeight: 500,
};

const TICKER_INFO: Record<string, string> = {
  SPY: "Tracks the S&P 500 — the 500 largest US companies. The single best read on overall US stock market health.",
  QQQ: "Tracks the Nasdaq 100 — the top 100 tech companies. Shows specifically how the tech sector is performing.",
  BTC: "Bitcoin — the leading indicator for all of crypto. When BTC moves, crypto follows.",
  VIX: "The fear index. Measures market volatility. Below 20 = calm. Above 20 = nervous. Above 30 = fear.",
};

export function MarketPulseAccordion({
  refreshTrigger = 0,
}: {
  refreshTrigger?: number;
}) {
  const [health, setHealth] = useState<MarketHealthItem[]>([]);
  const [picks, setPicks] = useState<ScannerPick[]>([]);
  const [loading, setLoading] = useState(true);
  const [healthOpen, setHealthOpen] = useState(true);
  const [picksOpen, setPicksOpen] = useState(true);

  useEffect(() => {
    const fetchData = () => {
      fetch(`${API}/dashboard/market-pulse`)
        .then((r) => r.json())
        .then((data: MarketHealthResponse) => {
          setHealth(Array.isArray(data.marketHealth) ? data.marketHealth : []);
          setPicks(Array.isArray(data.scannerPicks) ? data.scannerPicks : []);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    };
    fetchData();
    const t = setInterval(fetchData, DASHBOARD_POLL_MS);
    return () => clearInterval(t);
  }, [refreshTrigger]);

  const formatValue = (item: { symbol: string; price: number | null }) => {
    if (item.price == null) return "—";
    if (item.symbol === "VIX") return item.price.toFixed(1);
    return item.price >= 1000
      ? `$${item.price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
      : `$${Number(item.price).toFixed(2)}`;
  };

  const formatChange = (change: number | null) => {
    if (change == null) return "";
    return `${change >= 0 ? "↑" : "↓"} ${Math.abs(change).toFixed(1)}% 24h`;
  };

  return (
    <>
      {/* ── Market Health accordion ── */}
      <div style={{ marginTop: 24 }}>
        <button
          onClick={() => setHealthOpen((o) => !o)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            textAlign: "left",
            marginBottom: 8,
          }}
        >
          <span style={{ transform: healthOpen ? "rotate(90deg)" : "none", display: "inline-block", fontSize: 10, color: "#ccc", transition: "transform 0.2s ease" }}>▶</span>
          <span style={ACCORDION_HEADER}>Market Health</span>
        </button>
        <div style={{ overflow: "hidden", maxHeight: healthOpen ? 9999 : 0, transition: "max-height 0.3s ease" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {loading && health.length === 0
              ? ["SPY", "QQQ", "BTC", "VIX"].map((s) => (
                  <MetricCard key={s} label={s} value="—" sub="loading" />
                ))
              : health.map((item) => (
                  <MetricCard
                    key={item.symbol}
                    label={item.symbol}
                    value={formatValue(item)}
                    sub={formatChange(item.change_24h) || undefined}
                    signal={item.signal ?? undefined}
                    rsi={item.rsi ?? undefined}
                    infoTip={TICKER_INFO[item.symbol]}
                  />
                ))}
          </div>
        </div>
      </div>

      {/* ── Scanner Picks accordion ── */}
      <div style={{ marginTop: 16 }}>
        <button
          onClick={() => setPicksOpen((o) => !o)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            textAlign: "left",
            marginBottom: 8,
          }}
        >
          <span style={{ transform: picksOpen ? "rotate(90deg)" : "none", display: "inline-block", fontSize: 10, color: "#ccc", transition: "transform 0.2s ease" }}>▶</span>
          <span style={ACCORDION_HEADER}>Scanner Picks</span>
        </button>
        <div style={{ overflow: "hidden", maxHeight: picksOpen ? 9999 : 0, transition: "max-height 0.3s ease" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {picks.length === 0 ? (
              <div style={{ fontSize: 10, color: "#444", fontFamily: "var(--mono)", padding: "4px 0" }}>
                Scanner runs at 07:30 daily
              </div>
            ) : (
              picks.map((pick) => (
                <div key={pick.symbol}>
                  <MetricCard
                    label={pick.symbol}
                    value={formatValue(pick)}
                    sub={formatChange(pick.change_24h) || undefined}
                    signal={pick.signal}
                    rsi={pick.rsi ?? undefined}
                  />
                  {pick.aria_reasoning && (
                    <div
                      style={{
                        fontSize: 9,
                        color: "#888",
                        lineHeight: 1.4,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        marginTop: 3,
                        fontFamily: "var(--mono)",
                        padding: "0 16px",
                      }}
                    >
                      {pick.aria_reasoning}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
