import React, { useState, useEffect, useRef } from "react";
import { signalColors } from "../../config";
import type { Signal } from "../../types";

const signalsExplainer = (
  <div style={{ padding: 12, maxWidth: 520 }}>
    <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 10, color: "#00ff94", fontFamily: "var(--mono)" }}>What does this show?</div>
    <p style={{ fontSize: 15, lineHeight: 1.55, color: "#aaa", marginBottom: 10, fontFamily: "var(--body)" }}>
      Live technical signals for your tracked tickers. ARIA combines RSI, MACD, and moving averages to suggest BUY/SELL/HOLD/WATCH—helping you spot opportunities and manage risk. Prices refresh every 5 minutes.
    </p>
    <div style={{ fontSize: 14, fontWeight: 600, color: "#888", marginBottom: 6, fontFamily: "var(--mono)" }}>Indicators</div>
    <p style={{ fontSize: 15, lineHeight: 1.55, color: "#aaa", marginBottom: 8, fontFamily: "var(--body)" }}>
      <strong style={{ color: "#00ff94" }}>MACD bullish</strong> — Momentum is turning positive (histogram &gt; 0). Often suggests upward momentum. <strong style={{ color: "#ff4757" }}>Bearish</strong> — Momentum turning negative; may indicate a pullback or downtrend.
    </p>
    <p style={{ fontSize: 15, lineHeight: 1.55, color: "#aaa", marginBottom: 8, fontFamily: "var(--body)" }}>
      <strong style={{ color: "#00ff94" }}>MA</strong> — Where price sits vs 20‑day and 50‑day moving averages. “Above both” = price above both averages (often bullish). “Below both” = price below both (often bearish).
    </p>
    <p style={{ fontSize: 15, lineHeight: 1.55, color: "#aaa", marginBottom: 8, fontFamily: "var(--body)" }}>
      <strong style={{ color: "#00ff94" }}>Score</strong> — Composite signal strength from −6 to +6. Positive = more bullish indicators agree; negative = more bearish. Helps you gauge conviction.
    </p>
    <div style={{ fontSize: 14, fontWeight: 600, color: "#888", marginBottom: 6, fontFamily: "var(--mono)" }}>Risk management</div>
    <p style={{ fontSize: 15, lineHeight: 1.55, color: "#aaa", marginBottom: 8, fontFamily: "var(--body)" }}>
      <strong style={{ color: "#00ff94" }}>Risk</strong> — Suggested position size as % of portfolio. Higher conviction = larger size; lower = smaller.
    </p>
    <p style={{ fontSize: 15, lineHeight: 1.55, color: "#aaa", marginBottom: 8, fontFamily: "var(--body)" }}>
      <strong style={{ color: "#00ff94" }}>Stop</strong> — Stop‑loss %. Exit if price falls this much below entry to limit downside.
    </p>
    <p style={{ fontSize: 15, lineHeight: 1.55, color: "#aaa", marginBottom: 0, fontFamily: "var(--body)" }}>
      <strong style={{ color: "#00ff94" }}>Take Profit</strong> — Target % gain. Consider taking profits when price rises this much above entry.
    </p>
  </div>
);

export function SignalsTab({
  signals,
  formatTs,
}: {
  signals: Signal[];
  formatTs: (iso: string) => string;
}) {
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

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
      <div ref={infoRef} style={{ position: "relative" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div style={{ fontSize: 16, letterSpacing: "0.12em", color: "#555", fontFamily: "var(--mono)" }}>LIVE SIGNALS</div>
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
            title="What do these signals mean?"
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
            {signalsExplainer}
          </div>
        )}
      </div>
      {signals.length === 0 ? (
        <div style={{ color: "#555", fontSize: 13, fontFamily: "var(--mono)" }}>No signals yet. Prices refresh every 5m; signals use technical composite (RSI/MACD/MAs) or 24h fallback.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {signals.map((s) => {
            const ind = s.indicator_data;
            const rc = s.risk_context;
            const rsiColor = ind?.rsi != null ? (ind.rsi > 70 ? "#ff4757" : ind.rsi < 30 ? "#00ff94" : "#ffd32a") : "#888";
            const macdDir = ind?.macd ? (ind.macd.histogram > 0 ? "bullish" : "bearish") : null;
            const maPos = ind?.ma20 != null && ind?.ma50 != null && s.price
              ? (s.price > ind.ma20 && s.price > ind.ma50 ? "above both" : s.price > ind.ma20 ? "above 20 only" : s.price < ind.ma20 && s.price < ind.ma50 ? "below both" : "below 20 only")
              : null;
            return (
              <div key={s.id} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "14px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
                  <span style={{ fontFamily: "var(--display)", fontWeight: 700, color: "#f0f0f0" }}>{s.ticker}</span>
                  <span style={{ fontSize: 11, fontFamily: "var(--mono)", padding: "2px 8px", borderRadius: 20, background: `${(signalColors[s.signal] ?? "#888")}18`, border: `1px solid ${(signalColors[s.signal] ?? "#888")}40`, color: signalColors[s.signal] ?? "#888" }}>{s.signal}</span>
                </div>
                <div style={{ fontSize: 12, color: "#888", fontFamily: "var(--body)", marginBottom: 6 }}>{s.reasoning}</div>
                {ind && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 6, fontSize: 11, fontFamily: "var(--mono)" }}>
                    {ind.rsi != null && <span style={{ color: rsiColor }}>RSI {ind.rsi.toFixed(0)} {ind.rsi > 70 ? "(overbought)" : ind.rsi < 30 ? "(oversold)" : "(neutral)"}</span>}
                    {macdDir && <span style={{ color: macdDir === "bullish" ? "#00ff94" : "#ff4757" }}>MACD {macdDir}</span>}
                    {maPos && <span style={{ color: "#888" }}>MA {maPos}</span>}
                    {ind.score != null && <span style={{ color: "#00ff94" }}>Score {ind.score > 0 ? "+" : ""}{ind.score}/6</span>}
                  </div>
                )}
                {rc && (
                  <div style={{ fontSize: 11, color: "#666", fontFamily: "var(--mono)", marginBottom: 4 }}>
                    Risk: {rc.suggested_position_size_pct}% size · stop {rc.stop_loss_pct}% · take-profit {rc.take_profit_pct}%
                    {rc.warning && <span style={{ color: "#ffd32a", marginLeft: 8 }}>⚠ {rc.warning}</span>}
                  </div>
                )}
                <div style={{ fontSize: 11, color: "#555", fontFamily: "var(--mono)" }}>${Number(s.price).toLocaleString()} · {s.created_at ? formatTs(s.created_at) : ""}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
