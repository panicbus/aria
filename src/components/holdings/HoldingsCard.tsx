import React, { useState, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

type OHLCVRow = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type HoldingsCardProps = {
  memoryKey: string;
  pos: { ticker?: string; amount?: string | number; entry?: string | number };
  currentPrice: number | null;
  apiBase: string;
};

export function HoldingsCard({ memoryKey, pos, currentPrice, apiBase }: HoldingsCardProps) {
  const [tab, setTab] = useState<"summary" | "chart">("summary");
  const [ohlcv, setOhlcv] = useState<OHLCVRow[] | null>(null);
  const [ohlcvLoading, setOhlcvLoading] = useState(false);
  const [ohlcvError, setOhlcvError] = useState<string | null>(null);

  const ticker = (pos.ticker ?? "").toUpperCase().trim() || "—";
  const amountDisplay = pos.amount != null && pos.amount !== "" ? String(pos.amount) : null;
  const entryNum =
    typeof pos.entry === "number"
      ? pos.entry
      : typeof pos.entry === "string" && pos.entry
        ? parseFloat(pos.entry)
        : null;
  const entryDisplay =
    entryNum != null && !isNaN(entryNum)
      ? `@ $${entryNum >= 1000 ? entryNum.toLocaleString("en-US", { maximumFractionDigits: 0 }) : entryNum.toFixed(2)}`
      : "";
  const val =
    currentPrice != null
      ? currentPrice >= 1000
        ? `$${currentPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
        : `$${Number(currentPrice).toFixed(2)}`
      : "—";
  const pnlPct =
    currentPrice != null && entryNum != null && !isNaN(entryNum) && entryNum > 0
      ? (((currentPrice - entryNum) / entryNum) * 100).toFixed(1)
      : null;

  useEffect(() => {
    if (tab !== "chart" || ticker === "—") return;
    setOhlcvError(null);
    setOhlcvLoading(true);
    const ctrl = new AbortController();
    fetch(`${apiBase}/ohlcv/${ticker}?days=30`, { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok)
          return r.json().then((err: { error?: string; detail?: string }) => {
            throw new Error(err?.detail ?? err?.error ?? `HTTP ${r.status}`);
          });
        return r.json();
      })
      .then((data: unknown) => {
        const arr = Array.isArray(data) ? data : null;
        if (!arr?.length) {
          setOhlcv(null);
          return;
        }
        const rows = (arr as OHLCVRow[])
          .map((r) => ({
            date: String(r?.date ?? ""),
            open: Number(r?.open) || 0,
            high: Number(r?.high) || 0,
            low: Number(r?.low) || 0,
            close: Number(r?.close) || 0,
            volume: Number(r?.volume) || 0,
          }))
          .filter((r) => r.date && r.close > 0);
        setOhlcv(rows.length > 0 ? rows : null);
        setOhlcvError(null);
      })
      .catch((e) => {
        if (e?.name !== "AbortError") {
          setOhlcv(null);
          setOhlcvError(e?.message ?? "Failed to load chart data");
        }
      })
      .finally(() => setOhlcvLoading(false));
    return () => ctrl.abort();
  }, [tab, ticker, apiBase]);

  const chartData =
    ohlcv?.map((r) => ({ date: r.date, value: r.close })).filter((d) => d.value > 0) ?? [];

  return (
    <div
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 10,
        overflow: "hidden",
        position: "relative",
        cursor: "default",
      }}
    >
      <div style={{ display: "flex" }}>
        <button
          onClick={() => setTab("summary")}
          style={{
            flex: 1,
            padding: "6px 8px",
            fontSize: 9,
            fontFamily: "var(--mono)",
            cursor: "pointer",
            border: "none",
            borderBottom: tab === "summary" ? "none" : "1px solid rgba(255,255,255,0.07)",
            borderRight: tab === "summary" ? "1px solid rgba(255,255,255,0.07)" : "none",
            background: tab === "summary" ? "transparent" : "rgba(255,255,255,0.04)",
            color: tab === "summary" ? "#ccc" : "#555",
          }}
        >
          Summary
        </button>
        <button
          onClick={() => setTab("chart")}
          style={{
            flex: 1,
            padding: "6px 8px",
            fontSize: 9,
            fontFamily: "var(--mono)",
            cursor: "pointer",
            border: "none",
            borderBottom: tab === "chart" ? "none" : "1px solid rgba(255,255,255,0.07)",
            borderLeft: tab === "chart" ? "1px solid rgba(255,255,255,0.07)" : "none",
            background: tab === "chart" ? "transparent" : "rgba(255,255,255,0.04)",
            color: tab === "chart" ? "#ccc" : "#555",
          }}
        >
          Chart
        </button>
      </div>
      <div style={{ padding: "10px 12px", minHeight: 85 }}>
        {tab === "summary" ? (
          <>
            <div
              style={{
                fontSize: 9,
                letterSpacing: "0.1em",
                color: "#888",
                textTransform: "uppercase",
                marginBottom: 3,
                fontFamily: "var(--mono)",
              }}
            >
              {ticker}
            </div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: "#f0f0f0",
                fontFamily: "var(--display)",
                lineHeight: 1,
              }}
            >
              {val}
            </div>
            <div
              style={{
                fontSize: 10,
                color: "#888",
                marginTop: 6,
                fontFamily: "var(--mono)",
              }}
            >
              {amountDisplay != null ? `${amountDisplay} shares` : "— shares"}
              {entryDisplay && ` ${entryDisplay}`}
              {pnlPct != null && (
                <span
                  style={{
                    color: parseFloat(pnlPct) >= 0 ? "#00ff94" : "#ff6b6b",
                    marginLeft: 6,
                  }}
                >
                  {parseFloat(pnlPct) >= 0 ? "+" : ""}
                  {pnlPct}%
                </span>
              )}
            </div>
            {!amountDisplay && !entryDisplay && (
              <div
                style={{
                  fontSize: 9,
                  color: "#555",
                  marginTop: 4,
                  fontFamily: "var(--mono)",
                }}
              >
                Edit in Memory → Portfolio
              </div>
            )}
          </>
        ) : ohlcvLoading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: 9,
                color: "#666",
                fontFamily: "var(--mono)",
                letterSpacing: "0.08em",
              }}
            >
              {ticker}
            </span>
            <span style={{ fontSize: 10, color: "#555", fontFamily: "var(--mono)" }}>
              Loading…
            </span>
          </div>
        ) : ohlcvError ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  fontSize: 9,
                  color: "#666",
                  fontFamily: "var(--mono)",
                  letterSpacing: "0.08em",
                }}
              >
                {ticker}
              </span>
              <span style={{ fontSize: 10, color: "#ff6b6b", fontFamily: "var(--mono)" }}>
                {ohlcvError}
              </span>
            </div>
            <button
              onClick={async () => {
                if (ticker === "—" || ohlcvLoading) return;
                setOhlcvError(null);
                setOhlcvLoading(true);
                try {
                  const r = await fetch(`${apiBase}/ohlcv/refresh/${ticker}`, {
                    method: "POST",
                  });
                  const data = (await r.json()) as { error?: string; detail?: string };
                  if (!r.ok) throw new Error(data?.detail ?? data?.error ?? `HTTP ${r.status}`);
                  const res = await fetch(`${apiBase}/ohlcv/${ticker}?days=30`);
                  const rows = await res.json();
                  setOhlcv(Array.isArray(rows) && rows.length > 0 ? rows : null);
                  if (!Array.isArray(rows) || rows.length === 0)
                    setOhlcvError("No data after refresh");
                } catch (e) {
                  setOhlcvError(e instanceof Error ? e.message : "Refresh failed");
                } finally {
                  setOhlcvLoading(false);
                }
              }}
              disabled={ohlcvLoading}
              style={{
                fontSize: 9,
                padding: "4px 10px",
                alignSelf: "flex-start",
                background: "rgba(0,255,148,0.1)",
                border: "1px solid rgba(0,255,148,0.3)",
                borderRadius: 6,
                color: "#00ff94",
                cursor: "pointer",
                fontFamily: "var(--mono)",
              }}
            >
              {ohlcvLoading ? "Fetching…" : "Refresh from API"}
            </button>
          </div>
        ) : chartData.length > 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
              height: 80,
              marginTop: -4,
            }}
          >
            <div style={{ flexShrink: 0, paddingTop: 2 }}>
              <span
                style={{
                  fontSize: 9,
                  color: "#666",
                  fontFamily: "var(--mono)",
                  letterSpacing: "0.08em",
                }}
              >
                {ticker}
              </span>
            </div>
            <div style={{ flex: 1, minWidth: 60, width: "100%" }}>
              <ResponsiveContainer width="100%" height={80}>
                <LineChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 8, fill: "#555" }}
                    stroke="#333"
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 8, fill: "#555" }}
                    stroke="#333"
                    tickFormatter={(v) => `$${v}`}
                    domain={["auto", "auto"]}
                    width={28}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#1a1a1a",
                      border: "1px solid #333",
                      borderRadius: 6,
                      fontSize: 10,
                    }}
                    formatter={(v: number) => [`$${v.toFixed(2)}`, "Close"]}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="#00ff94"
                    strokeWidth={1.5}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: 9,
                color: "#666",
                fontFamily: "var(--mono)",
                letterSpacing: "0.08em",
                flexShrink: 0,
              }}
            >
              {ticker}
            </span>
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 8,
              }}
            >
              <span style={{ fontSize: 10, color: "#555", fontFamily: "var(--mono)" }}>
                No 30-day data. Try refresh (takes ~15s).
              </span>
              <button
                onClick={async () => {
                  if (ticker === "—" || ohlcvLoading) return;
                  setOhlcvError(null);
                  setOhlcvLoading(true);
                  try {
                    const r = await fetch(`${apiBase}/ohlcv/refresh/${ticker}`, {
                      method: "POST",
                    });
                    const data = (await r.json()) as { error?: string; detail?: string };
                    if (!r.ok) throw new Error(data?.detail ?? data?.error ?? `HTTP ${r.status}`);
                    const res = await fetch(`${apiBase}/ohlcv/${ticker}?days=30`);
                    const rows = await res.json();
                    const arr = Array.isArray(rows) ? rows : [];
                    setOhlcv(arr.length > 0 ? arr : null);
                    if (arr.length === 0) setOhlcvError("No data returned");
                  } catch (e) {
                    setOhlcvError(e instanceof Error ? e.message : "Refresh failed");
                  } finally {
                    setOhlcvLoading(false);
                  }
                }}
                disabled={ohlcvLoading}
                style={{
                  fontSize: 9,
                  padding: "4px 10px",
                  background: "rgba(0,255,148,0.1)",
                  border: "1px solid rgba(0,255,148,0.3)",
                  borderRadius: 6,
                  color: "#00ff94",
                  cursor: "pointer",
                  fontFamily: "var(--mono)",
                }}
              >
                {ohlcvLoading ? "Fetching… (~15s)" : "Refresh from API"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
