import React, { useState, useEffect, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

import { API } from "../../config";
import type { BacktestResult } from "../../types";

const BACKTEST_DAYS = [30, 60, 90, 180] as const;

const TZ = "America/Los_Angeles";
function formatMMDDYY(isoOrStr: string): string {
  const d = new Date(isoOrStr);
  return d.toLocaleDateString("en-US", { timeZone: TZ, month: "2-digit", day: "2-digit", year: "2-digit" });
}

const backtestExplainer = (
  <div style={{ padding: 12, maxWidth: 540 }}>
    <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 10, color: "#00ff94", fontFamily: "var(--mono)" }}>What does this do?</div>
    <p style={{ fontSize: 16, lineHeight: 1.55, color: "#aaa", marginBottom: 10, fontFamily: "var(--body)" }}>
      A <strong style={{ color: "#00ff94" }}>backtest</strong> rewinds time and pretends you traded using our signals over a past period. It shows how a strategy would have performed—handy for learning, but past results don’t guarantee future ones.
    </p>
    <p style={{ fontSize: 16, lineHeight: 1.55, color: "#aaa", marginBottom: 10, fontFamily: "var(--body)" }}>
      <strong style={{ color: "#00ff94" }}>Buy & Hold</strong> — If you’d simply bought at the start and held until the end. A baseline to compare against.
    </p>
    <p style={{ fontSize: 16, lineHeight: 1.55, color: "#aaa", marginBottom: 10, fontFamily: "var(--body)" }}>
      <strong style={{ color: "#00ff94" }}>Win rate</strong> — The share of trades that made money. 70% means 7 out of 10 trades were profitable.
    </p>
    <p style={{ fontSize: 16, lineHeight: 1.55, color: "#aaa", marginBottom: 10, fontFamily: "var(--body)" }}>
      <strong style={{ color: "#00ff94" }}>Trades</strong> — How many times the strategy bought and sold in that period.
    </p>
    <p style={{ fontSize: 16, lineHeight: 1.55, color: "#aaa", marginBottom: 10, fontFamily: "var(--body)" }}>
      <strong style={{ color: "#00ff94" }}>Max drawdown</strong> — The biggest peak‑to‑valley drop in your account. If it’s 15%, your equity once fell 15% from a high before recovering.
    </p>
    <p style={{ fontSize: 16, lineHeight: 1.55, color: "#aaa", marginBottom: 10, fontFamily: "var(--body)" }}>
      <strong style={{ color: "#00ff94" }}>The graph</strong> — The line is your account equity over time. The Y‑axis (vertical) is dollar value: higher = more money. It grows when trades win and dips when they lose.
    </p>
    <p style={{ fontSize: 16, lineHeight: 1.55, color: "#aaa", marginBottom: 0, fontFamily: "var(--body)" }}>
      <strong style={{ color: "#00ff94" }}>Entry</strong> — When we bought. <strong style={{ color: "#00ff94" }}>Exit</strong> — When we sold. <strong style={{ color: "#00ff94" }}>Return</strong> — Profit or loss for that trade (%). <strong style={{ color: "#00ff94" }}>Outcome</strong> — Win or loss.
    </p>
  </div>
);

export function BacktestTab({
  tickers,
  preselectedTicker,
}: {
  tickers: string[];
  preselectedTicker?: string | null;
}) {
  const allTickers = preselectedTicker && !tickers.includes(preselectedTicker)
    ? [preselectedTicker, ...tickers]
    : tickers;
  const [ticker, setTicker] = useState<string>(preselectedTicker ?? allTickers[0] ?? "BTC");
  useEffect(() => {
    if (preselectedTicker) setTicker(preselectedTicker);
  }, [preselectedTicker]);
  useEffect(() => {
    if (allTickers.length && !allTickers.includes(ticker)) setTicker(allTickers[0]);
  }, [allTickers, ticker]);
  const [days, setDays] = useState<number>(90);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!infoOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (infoRef.current && !infoRef.current.contains(e.target as Node)) {
        setInfoOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [infoOpen]);

  const runBacktest = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API}/backtest?ticker=${encodeURIComponent(ticker)}&days=${days}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Request failed");
        return;
      }
      setResult(data);
      if (data.error) setError(data.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16, position: "relative" }}>
      <div ref={infoRef} style={{ position: "relative" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 16, letterSpacing: "0.12em", color: "#555", fontFamily: "var(--mono)", marginBottom: 24 }}>BACKTEST</div>
            <div style={{ fontSize: 11, color: "#666", fontFamily: "var(--mono)", marginBottom: 8 }}>
              Historical simulation — not a guarantee. Uses same composite indicator logic as live signals.
            </div>
          </div>
          <button
            onClick={() => setInfoOpen((o) => !o)}
            style={{
              flexShrink: 0,
              width: 24,
              height: 24,
              borderRadius: "50%",
              border: "1px solid rgba(255,255,255,0.2)",
              background: "rgba(255,255,255,0.04)",
              color: "#666",
              fontSize: 18,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="What does the backtest show?"
          >
            ⓘ
          </button>
        </div>
        {infoOpen && (
          <div
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              zIndex: 20,
              background: "#141414",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 12,
              boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            }}
          >
            {backtestExplainer}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <select value={ticker} onChange={(e) => setTicker(e.target.value)} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "8px 12px", color: "#f0f0f0", fontFamily: "var(--mono)", fontSize: 12 }}>
          {allTickers.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "8px 12px", color: "#f0f0f0", fontFamily: "var(--mono)", fontSize: 12 }}>
          {BACKTEST_DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}
        </select>
        <button onClick={runBacktest} disabled={loading} style={{ background: "linear-gradient(135deg, #00ff94, #00d4aa)", border: "none", borderRadius: 8, padding: "8px 16px", color: "#0a0a0a", fontSize: 12, fontWeight: 700, fontFamily: "var(--display)", cursor: "pointer", opacity: loading ? 0.6 : 1 }}>
          {loading ? "Running…" : "Run Backtest"}
        </button>
      </div>
      {error && (
        <div style={{ padding: "10px 14px", background: "rgba(255,71,87,0.1)", border: "1px solid rgba(255,71,87,0.3)", borderRadius: 8, fontSize: 12, color: "#ff6b6b", fontFamily: "var(--mono)" }}>
          {error}
        </div>
      )}
      {result && !result.error && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10 }}>
            {[
              { label: "Total Return", value: `${result.summary.total_return_pct >= 0 ? "+" : ""}${result.summary.total_return_pct.toFixed(1)}%`, color: result.summary.total_return_pct >= 0 ? "#00ff94" : "#ff4757" },
              { label: "Buy & Hold", value: `${result.summary.buy_and_hold_pct >= 0 ? "+" : ""}${result.summary.buy_and_hold_pct.toFixed(1)}%`, color: "#888" },
              { label: "Win Rate", value: `${result.summary.win_rate.toFixed(0)}%`, color: "#00ff94" },
              { label: "Trades", value: String(result.summary.num_trades), color: "#888" },
              { label: "Max Drawdown", value: `-${result.summary.max_drawdown_pct.toFixed(1)}%`, color: "#ff4757" },
            ].map((m) => (
              <div key={m.label} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 12 }}>
                <div style={{ fontSize: 9, color: "#555", fontFamily: "var(--mono)", marginBottom: 4 }}>{m.label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: m.color, fontFamily: "var(--display)" }}>{m.value}</div>
              </div>
            ))}
          </div>
          {result.equity_curve.length > 0 && (
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 16, height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={result.equity_curve}>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#666" }} stroke="#333" tickFormatter={formatMMDDYY} />
                  <YAxis tick={{ fontSize: 10, fill: "#666" }} stroke="#333" tickFormatter={(v) => `$${v}`} />
                  <Tooltip contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8 }} labelStyle={{ color: "#00ff94" }} labelFormatter={formatMMDDYY} formatter={(v: number) => [`$${v.toFixed(0)}`, "Equity"]} />
                  <Line type="monotone" dataKey="value" stroke="#00ff94" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          {result.trades.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: "#555", fontFamily: "var(--mono)", marginBottom: 6 }}>TRADES</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "var(--mono)" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.15)" }}>
                      <th style={{ textAlign: "left", padding: "6px 10px", color: "#00ff94" }}>Entry</th>
                      <th style={{ textAlign: "left", padding: "6px 10px", color: "#00ff94" }}>Exit</th>
                      <th style={{ textAlign: "left", padding: "6px 10px", color: "#00ff94" }}>Return</th>
                      <th style={{ textAlign: "left", padding: "6px 10px", color: "#00ff94" }}>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((t, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                        <td style={{ padding: "6px 10px", color: "#ccc" }}>{formatMMDDYY(t.entry_date)}</td>
                        <td style={{ padding: "6px 10px", color: "#ccc" }}>{formatMMDDYY(t.exit_date)}</td>
                        <td style={{ padding: "6px 10px", color: t.return_pct >= 0 ? "#00ff94" : "#ff4757" }}>{t.return_pct >= 0 ? "+" : ""}{t.return_pct.toFixed(2)}%</td>
                        <td style={{ padding: "6px 10px" }}>
                          <span style={{ padding: "2px 6px", borderRadius: 4, background: t.outcome === "win" ? "rgba(0,255,148,0.15)" : "rgba(255,71,87,0.15)", color: t.outcome === "win" ? "#00ff94" : "#ff4757", fontSize: 10 }}>{t.outcome}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
