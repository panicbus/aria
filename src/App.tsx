import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

import { HoldingsCard } from "./components/holdings/HoldingsCard";
import { TypingIndicator } from "./components/ui/TypingIndicator";
import { StatusDot } from "./components/ui/StatusDot";
import { MetricCard } from "./components/ui/MetricCard";
import {
  API,
  SUGGESTED_PROMPTS,
  FALLBACK_TICKERS,
  DASHBOARD_POLL_MS,
  MEMORY_SECTIONS,
  RISK_OPTIONS,
  SIGNALS_OPTIONS,
  signalColors,
} from "./config";
import type { Message, Signal, Dashboard, Memory, Briefing, BacktestResult } from "./types";

function memorySection(key: string): "portfolio" | "preferences" | "context" {
  if (key.startsWith("position_") || key === "positions" || key === "watchlist") return "portfolio";
  if (key === "risk_tolerance" || key === "signals_preference" || key.startsWith("pref_")) return "preferences";
  return "context";
}

function parseMemoryValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function MemoryTab({
  memories,
  onRefresh,
  onDelete,
}: {
  memories: Memory[];
  onRefresh: () => void;
  onDelete: (key: string) => void;
}) {
  const [section, setSection] = useState<"portfolio" | "preferences" | "context">("portfolio");
  const [search, setSearch] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [addingPosition, setAddingPosition] = useState(false);
  const [newPosition, setNewPosition] = useState({ ticker: "", amount: "", entry: "" });
  const [addingWatchlist, setAddingWatchlist] = useState(false);
  const [newWatchlist, setNewWatchlist] = useState("");
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

  const filtered = memories.filter((m) => {
    const sec = memorySection(m.key);
    if (section !== sec) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q);
    }
    return true;
  });

  const saveMemory = async (key: string, value: string | object, source = "explicit") => {
    try {
      await fetch(`${API}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: typeof value === "string" ? value : value, source }),
      });
      setEditingKey(null);
      setEditValue("");
      setAddingPosition(false);
      setNewPosition({ ticker: "", amount: "", entry: "" });
      setAddingWatchlist(false);
      setNewWatchlist("");
      onRefresh();
    } catch (_) {}
  };

  const handleAddPosition = () => {
    const ticker = newPosition.ticker.trim().toUpperCase();
    const amount = parseFloat(newPosition.amount);
    const entry = parseFloat(newPosition.entry);
    if (!ticker || isNaN(amount) || isNaN(entry)) return;
    saveMemory(`position_${ticker}`, { ticker, amount, entry });
  };

  const handleAddWatchlist = () => {
    const list = newWatchlist.trim().replace(/\s*,\s*/g, ", ");
    if (!list) return;
    saveMemory("watchlist", list);
  };

  const exportJson = () => {
    fetch(`${API}/memories/export`).then((r) => r.text()).then((text) => {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "aria-memories.json";
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  const importInputRef = useRef<HTMLInputElement>(null);
  const importJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      const res = await fetch(`${API}/memories/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(obj),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Import failed");
      onRefresh();
      alert(`Imported ${data.imported} memories.`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Import failed. Use a file exported from ARIA.");
    }
  };

  const clearAll = async () => {
    if (!confirm("Clear all memories? This cannot be undone.")) return;
    try {
      await fetch(`${API}/memories`, { method: "DELETE" });
      onRefresh();
    } catch (_) {}
  };

  const portfolioMemories = filtered.filter((m) => memorySection(m.key) === "portfolio");
  const prefMemories = filtered.filter((m) => memorySection(m.key) === "preferences");
  const contextMemories = filtered.filter((m) => memorySection(m.key) === "context");

  const riskMem = memories.find((m) => m.key === "risk_tolerance");
  const signalsMem = memories.find((m) => m.key === "signals_preference");

  const btn = (label: string, onClick: () => void, variant: "primary" | "ghost" = "ghost") => (
    <button
      onClick={onClick}
      style={{
        fontSize: 10, fontFamily: "var(--mono)", padding: "4px 8px", borderRadius: 6,
        border: variant === "primary" ? "1px solid rgba(0,255,148,0.4)" : "1px solid rgba(255,255,255,0.2)",
        background: variant === "primary" ? "rgba(0,255,148,0.1)" : "transparent",
        color: variant === "primary" ? "#00ff94" : "#888", cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div style={{ fontSize: 12, letterSpacing: "0.12em", color: "#555", fontFamily: "var(--mono)" }}>MEMORY</div>
        <div ref={infoRef} style={{ display: "flex", alignItems: "center", gap: 10, position: "relative" }}>
          <button
            onClick={() => setInfoOpen((o) => !o)}
            style={{
              width: 26, height: 26, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.3)",
              background: infoOpen ? "rgba(0,255,148,0.15)" : "rgba(255,255,255,0.06)",
              color: infoOpen ? "#00ff94" : "#888", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, fontWeight: 700, fontFamily: "var(--body)",
            }}
            aria-label="How to use Memory"
          >
            i
          </button>
          {MEMORY_SECTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              style={{
                fontSize: 11, fontFamily: "var(--mono)", padding: "5px 12px", borderRadius: 20,
                border: "1px solid " + (section === s ? "rgba(0,255,148,0.4)" : "rgba(255,255,255,0.15)"),
                background: section === s ? "rgba(0,255,148,0.1)" : "transparent",
                color: section === s ? "#00ff94" : "#666", cursor: "pointer",
              }}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
          {infoOpen && (
            <div
              style={{
                position: "absolute", top: "100%", right: 0, marginTop: 8,
                width: 640, padding: 16,
                background: "#141414", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 10,
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                fontSize: 14, lineHeight: 1.5, color: "#ccc", fontFamily: "var(--body)",
                zIndex: 50,
              }}
            >
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontWeight: 700, color: "#00ff94", marginBottom: 6 }}>Portfolio</div>
                <p style={{ margin: 0, color: "#bbb" }}>
                  Add your positions (ticker, amount, entry price) and your watchlist. For the watchlist, you list tickers (e.g. UBER, SPY, LTBR) so ARIA knows what you're interested in.
                </p>
                <p style={{ margin: "8px 0 0 0", color: "#bbb" }}>
                  When you save, ARIA stores it in memory. In chat, she uses it when you ask things like: "What do you think about my watchlist?" or "Give me a signal check on the tickers I'm watching" or "Any thoughts on UBER and SPY?" It helps her tailor advice and signal summaries to those tickers instead of guessing.
                </p>
              </div>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontWeight: 700, color: "#00ff94", marginBottom: 6 }}>Preferences</div>
                <p style={{ margin: 0, color: "#bbb" }}>
                  Set your risk level (conservative, moderate, aggressive) and how often you want signals. ARIA uses these when giving advice and sizing recommendations.
                </p>
              </div>
              <div>
                <div style={{ fontWeight: 700, color: "#00ff94", marginBottom: 6 }}>Context</div>
                <p style={{ margin: 0, color: "#bbb" }}>
                  ARIA saves facts from your chats here automatically. You can edit or delete anything. Use the search bar to find a specific memory.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <input
        placeholder="Search memories…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "8px 12px", color: "#f0f0f0", fontSize: 12, fontFamily: "var(--mono)", outline: "none" }}
      />

      {/* Portfolio */}
      {section === "portfolio" && (
        <div>
          <div style={{ fontSize: 10, letterSpacing: "0.1em", color: "#00ff94", fontFamily: "var(--mono)", marginBottom: 8 }}>PORTFOLIO</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {portfolioMemories.filter((m) => m.key.startsWith("position_")).map((m) => {
              const v = parseMemoryValue(m.value) as { ticker?: string; amount?: number; entry?: number };
              const disp = typeof v === "object" && v && "ticker" in v
                ? `${v.ticker}: ${v.amount} @ $${v.entry?.toLocaleString()}`
                : String(m.value);
              return (
                <div key={m.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "#ccc" }}>• {disp}</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    {btn("Edit", () => { setEditingKey(m.key); setEditValue(m.value); })}
                    {btn("×", () => onDelete(m.key))}
                  </div>
                </div>
              );
            })}
            {portfolioMemories.filter((m) => m.key === "watchlist").length > 0 && (
              <>
                <div style={{ fontSize: 10, letterSpacing: "0.1em", color: "#666", fontFamily: "var(--mono)", marginTop: 12, marginBottom: 4 }}>WATCHLIST</div>
                {portfolioMemories.filter((m) => m.key === "watchlist").map((m) => (
              <div key={m.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)" }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "#ccc" }}>• {String(m.value)}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {btn("Edit", () => { setEditingKey(m.key); setEditValue(m.value); })}
                </div>
              </div>
                ))}
              </>
            )}
            {addingPosition ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: 8, background: "rgba(255,255,255,0.03)", borderRadius: 8 }}>
                <input placeholder="Ticker" value={newPosition.ticker} onChange={(e) => setNewPosition((p) => ({ ...p, ticker: e.target.value }))} style={{ width: 70, padding: "6px 8px", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, color: "#f0f0f0", fontSize: 11, fontFamily: "var(--mono)" }} />
                <input placeholder="Amount" value={newPosition.amount} onChange={(e) => setNewPosition((p) => ({ ...p, amount: e.target.value }))} style={{ width: 70, padding: "6px 8px", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, color: "#f0f0f0", fontSize: 11, fontFamily: "var(--mono)" }} />
                <input placeholder="Entry $" value={newPosition.entry} onChange={(e) => setNewPosition((p) => ({ ...p, entry: e.target.value }))} style={{ width: 80, padding: "6px 8px", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, color: "#f0f0f0", fontSize: 11, fontFamily: "var(--mono)" }} />
                {btn("Save", handleAddPosition, "primary")}
                {btn("Cancel", () => setAddingPosition(false))}
              </div>
            ) : (
              <button onClick={() => setAddingPosition(true)} style={{ fontSize: 11, fontFamily: "var(--mono)", padding: "6px 10px", color: "#00ff94", background: "transparent", border: "1px dashed rgba(0,255,148,0.4)", borderRadius: 8, cursor: "pointer", textAlign: "left" }}>
                + Add Position
              </button>
            )}
            {addingWatchlist ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: 8, background: "rgba(255,255,255,0.03)", borderRadius: 8 }}>
                <input placeholder="Tickers (e.g. UBER, SPY, LTBR)" value={newWatchlist} onChange={(e) => setNewWatchlist(e.target.value)} style={{ flex: 1, minWidth: 150, padding: "6px 8px", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, color: "#f0f0f0", fontSize: 11, fontFamily: "var(--mono)" }} />
                {btn("Save", handleAddWatchlist, "primary")}
                {btn("Cancel", () => setAddingWatchlist(false))}
              </div>
            ) : !portfolioMemories.some((m) => m.key === "watchlist") && (
              <button onClick={() => setAddingWatchlist(true)} style={{ fontSize: 11, fontFamily: "var(--mono)", padding: "6px 10px", color: "#00ff94", background: "transparent", border: "1px dashed rgba(0,255,148,0.4)", borderRadius: 8, cursor: "pointer", textAlign: "left" }}>
                + Add Watchlist
              </button>
            )}
          </div>
        </div>
      )}

      {/* Preferences */}
      {section === "preferences" && (
        <div>
          <div style={{ fontSize: 10, letterSpacing: "0.1em", color: "#00ff94", fontFamily: "var(--mono)", marginBottom: 8 }}>PREFERENCES</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 12, color: "#888", fontFamily: "var(--mono)", minWidth: 60 }}>Risk:</span>
              <select
                value={RISK_OPTIONS.includes(String(riskMem?.value ?? "moderate").toLowerCase()) ? String(riskMem?.value ?? "moderate").toLowerCase() : "moderate"}
                onChange={(e) => saveMemory("risk_tolerance", e.target.value)}
                style={{ padding: "6px 10px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, color: "#f0f0f0", fontSize: 12, fontFamily: "var(--mono)" }}
              >
                {RISK_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 12, color: "#888", fontFamily: "var(--mono)", minWidth: 60 }}>Signals:</span>
              <select
                value={SIGNALS_OPTIONS.includes(String(signalsMem?.value ?? "daily").toLowerCase()) ? String(signalsMem?.value ?? "daily").toLowerCase() : "daily"}
                onChange={(e) => saveMemory("signals_preference", e.target.value)}
                style={{ padding: "6px 10px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, color: "#f0f0f0", fontSize: 12, fontFamily: "var(--mono)" }}
              >
                {SIGNALS_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            {prefMemories.filter((m) => !["risk_tolerance", "signals_preference"].includes(m.key)).map((m) => (
              <div key={m.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)" }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "#00ff94" }}>{m.key}</span>
                <span style={{ fontSize: 11, color: "#888" }}>{String(m.value)}</span>
                {btn("×", () => onDelete(m.key))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Context */}
      {section === "context" && (
        <div>
          <div style={{ fontSize: 10, letterSpacing: "0.1em", color: "#00ff94", fontFamily: "var(--mono)", marginBottom: 8 }}>CONTEXT</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {contextMemories.length === 0 ? (
              <div style={{ color: "#555", fontSize: 12, fontFamily: "var(--mono)" }}>No context memories. Chat with ARIA; she will extract facts over time.</div>
            ) : (
              contextMemories.map((m) => (
                <div key={m.key} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                    <span style={{ fontFamily: "var(--mono)", fontWeight: 700, color: "#00ff94", fontSize: 12 }}>{m.key}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {m.source && <span style={{ fontSize: 10, color: "#666", fontFamily: "var(--mono)", padding: "2px 6px", background: "rgba(255,255,255,0.06)", borderRadius: 4 }}>{m.source}</span>}
                      {m.confidence != null && <span style={{ fontSize: 10, color: "#666" }}>{(m.confidence * 100).toFixed(0)}%</span>}
                      {btn("Edit", () => { setEditingKey(m.key); setEditValue(m.value); })}
                      {btn("×", () => onDelete(m.key))}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "#ccc", fontFamily: "var(--body)", marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.value}</div>
                  <div style={{ fontSize: 10, color: "#555", fontFamily: "var(--mono)", marginTop: 4 }}>updated {m.updated_at ? new Date(m.updated_at).toLocaleString() : ""}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editingKey && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={() => setEditingKey(null)}>
          <div style={{ background: "#141414", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 12, padding: 20, maxWidth: 400, width: "90%" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 11, color: "#00ff94", fontFamily: "var(--mono)", marginBottom: 8 }}>Edit: {editingKey}</div>
            <textarea value={editValue} onChange={(e) => setEditValue(e.target.value)} rows={4} style={{ width: "100%", padding: 10, background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, color: "#f0f0f0", fontSize: 12, fontFamily: "var(--mono)", resize: "vertical", boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              {btn("Save", () => saveMemory(editingKey, editValue), "primary")}
              {btn("Cancel", () => setEditingKey(null))}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ display: "flex", gap: 10, marginTop: "auto", paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <input ref={importInputRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={importJson} />
        {btn("Import JSON", () => importInputRef.current?.click(), "primary")}
        {btn("Export JSON", exportJson, "primary")}
        {btn("Clear All", clearAll)}
      </div>
    </div>
  );
}
const BACKTEST_DAYS = [30, 60, 90, 180] as const;

function BacktestTab({ tickers }: { tickers: string[] }) {
  const [ticker, setTicker] = useState<string>(tickers[0] ?? "BTC");
  useEffect(() => {
    if (tickers.length && !tickers.includes(ticker)) setTicker(tickers[0]);
  }, [tickers, ticker]);
  const [days, setDays] = useState<number>(90);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 12, letterSpacing: "0.12em", color: "#555", fontFamily: "var(--mono)", marginBottom: 4 }}>BACKTEST</div>
      <div style={{ fontSize: 11, color: "#666", fontFamily: "var(--mono)", marginBottom: 8 }}>
        Historical simulation — not a guarantee. Uses same composite indicator logic as live signals.
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <select value={ticker} onChange={(e) => setTicker(e.target.value)} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "8px 12px", color: "#f0f0f0", fontFamily: "var(--mono)", fontSize: 12 }}>
          {tickers.map((t) => <option key={t} value={t}>{t}</option>)}
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
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#666" }} stroke="#333" />
                  <YAxis tick={{ fontSize: 10, fill: "#666" }} stroke="#333" tickFormatter={(v) => `$${v}`} />
                  <Tooltip contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8 }} labelStyle={{ color: "#00ff94" }} formatter={(v: number) => [`$${v.toFixed(0)}`, "Equity"]} />
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
                        <td style={{ padding: "6px 10px", color: "#ccc" }}>{t.entry_date}</td>
                        <td style={{ padding: "6px 10px", color: "#ccc" }}>{t.exit_date}</td>
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

const markdownChatStyles = {
  p: { margin: "0 0 0.6em 0" },
  "p:last-child": { marginBottom: 0 },
  strong: { fontWeight: 700, color: "#f0f0f0" },
  em: { fontStyle: "italic" },
  code: { fontFamily: "var(--mono)", fontSize: "0.9em", background: "rgba(0,255,148,0.08)", color: "#00ff94", padding: "2px 6px", borderRadius: 4 },
  pre: { margin: "0.5em 0", padding: 12, background: "rgba(0,0,0,0.3)", borderRadius: 8, overflow: "auto", border: "1px solid rgba(255,255,255,0.06)" },
  "pre code": { background: "none", padding: 0, color: "#ccc" },
  ul: { margin: "0.4em 0 0.4em 1.2em", paddingLeft: "1.2em" },
  ol: { margin: "0.4em 0 0.4em 1.2em", paddingLeft: "1.2em" },
  li: { marginBottom: 0.25 },
  blockquote: { margin: "0.5em 0", paddingLeft: 14, borderLeft: "3px solid rgba(0,255,148,0.4)", color: "#aaa" },
  a: { color: "#00ff94", textDecoration: "none" },
  "a:hover": { textDecoration: "underline" },
  h1: { fontSize: "1.2em", fontWeight: 700, margin: "0.75em 0 0.35em", color: "#f0f0f0" },
  h2: { fontSize: "1.1em", fontWeight: 700, margin: "0.6em 0 0.3em", color: "#e8e8e8" },
  h3: { fontSize: "1em", fontWeight: 700, margin: "0.5em 0 0.25em", color: "#ddd" },
  table: { width: "100%", borderCollapse: "collapse" as const, margin: "0.5em 0", fontSize: "0.95em" },
  th: { textAlign: "left" as const, padding: "6px 10px", borderBottom: "1px solid rgba(255,255,255,0.15)", color: "#00ff94" },
  td: { padding: "6px 10px", borderBottom: "1px solid rgba(255,255,255,0.06)" },
  hr: { border: "none", borderTop: "1px solid rgba(255,255,255,0.1)", margin: "0.75em 0" },
};

const ChatMessage = React.memo(({ msg }: { msg: Message }) => (
  <div
    className="msg-enter"
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: msg.role === "user" ? "flex-end" : "flex-start",
      maxWidth: "78%",
      alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
    }}
  >
    <div
      style={{
        padding: "11px 15px",
        borderRadius: msg.role === "user" ? "14px 14px 3px 14px" : "14px 14px 14px 3px",
        background: msg.role === "user" ? "rgba(0,255,148,0.09)" : "rgba(255,255,255,0.04)",
        border: msg.role === "user" ? "1px solid rgba(0,255,148,0.18)" : "1px solid rgba(255,255,255,0.07)",
        fontSize: 14,
        lineHeight: 1.65,
        color: msg.role === "user" ? "#d0ffe8" : "#ccc",
        ...(msg.role === "user" ? { whiteSpace: "pre-wrap" as const } : {}),
      }}
    >
      {msg.role === "assistant" ? <MarkdownContent content={msg.content} /> : msg.content}
    </div>
    <div style={{ fontSize: 10, color: "#333", marginTop: 3, fontFamily: "var(--mono)" }}>{msg.ts}</div>
  </div>
));

function MarkdownContent({ content, className = "" }: { content: string; className?: string }) {
  return (
    <div className={className} style={{ wordBreak: "break-word" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }: { children?: React.ReactNode }) => <p style={markdownChatStyles.p}>{children}</p>,
          strong: ({ children }: { children?: React.ReactNode }) => <strong style={markdownChatStyles.strong}>{children}</strong>,
          em: ({ children }: { children?: React.ReactNode }) => <em style={markdownChatStyles.em}>{children}</em>,
          code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
            const isBlock = className?.startsWith("language-");
            if (isBlock) {
              return <pre style={markdownChatStyles.pre}><code style={markdownChatStyles["pre code"]}>{children}</code></pre>;
            }
            return <code style={markdownChatStyles.code}>{children}</code>;
          },
          ul: ({ children }: { children?: React.ReactNode }) => <ul style={markdownChatStyles.ul}>{children}</ul>,
          ol: ({ children }: { children?: React.ReactNode }) => <ol style={markdownChatStyles.ol}>{children}</ol>,
          li: ({ children }: { children?: React.ReactNode }) => <li style={markdownChatStyles.li}>{children}</li>,
          blockquote: ({ children }: { children?: React.ReactNode }) => <blockquote style={markdownChatStyles.blockquote}>{children}</blockquote>,
          a: ({ href, children }: { href?: string; children?: React.ReactNode }) => <a href={href} target="_blank" rel="noopener noreferrer" style={markdownChatStyles.a}>{children}</a>,
          h1: ({ children }: { children?: React.ReactNode }) => <h1 style={markdownChatStyles.h1}>{children}</h1>,
          h2: ({ children }: { children?: React.ReactNode }) => <h2 style={markdownChatStyles.h2}>{children}</h2>,
          h3: ({ children }: { children?: React.ReactNode }) => <h3 style={markdownChatStyles.h3}>{children}</h3>,
          table: ({ children }: { children?: React.ReactNode }) => <table style={markdownChatStyles.table}>{children}</table>,
          th: ({ children }: { children?: React.ReactNode }) => <th style={markdownChatStyles.th}>{children}</th>,
          td: ({ children }: { children?: React.ReactNode }) => <td style={markdownChatStyles.td}>{children}</td>,
          hr: () => <hr style={markdownChatStyles.hr} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState(false);
  const [activeTab, setActiveTab] = useState("chat");
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [resizing, setResizing] = useState(false);
  const resizeStartRef = useRef({ x: 0, w: 260 });

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - resizeStartRef.current.x;
      const next = Math.min(480, Math.max(180, resizeStartRef.current.w + delta));
      setSidebarWidth(next);
    };
    const onUp = () => setResizing(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizing]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [briefings, setBriefings] = useState<Briefing[]>([]);
  const [briefingGenerating, setBriefingGenerating] = useState(false);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [holdingsOpen, setHoldingsOpen] = useState(false);
  const [ohlcvRefreshAll, setOhlcvRefreshAll] = useState(false);
  const [marketPulseOpen, setMarketPulseOpen] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 280)}px`;
  }, [input]);

  useEffect(() => {
    // Check server health
    fetch(`${API}/health`)
      .then(r => r.json())
      .then(() => setOnline(true))
      .catch(() => setOnline(false));

    // Load history
    fetch(`${API}/history`)
      .then(r => r.json())
      .then((data: Message[]) => {
        if (data.length === 0) {
          setMessages([{
            role: "assistant",
            content: "ARIA online. I'm your personal intelligence layer — tech industry, financial signals, and developer growth. What do you need?",
            ts: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          }]);
        } else {
          setMessages(data.map(m => ({ ...m, ts: new Date(m.created_at!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })));
        }
      });
  }, []);

  // Live dashboard (prices, news, signals) on schedule
  useEffect(() => {
    const load = () => {
      fetch(`${API}/dashboard`)
        .then(r => r.json())
        .then((data: Dashboard) => setDashboard(data))
        .catch(() => setDashboard(null));
    };
    load();
    const t = setInterval(load, DASHBOARD_POLL_MS);
    return () => clearInterval(t);
  }, []);

  // Signals list for Signals tab
  useEffect(() => {
    const load = () => {
      fetch(`${API}/signals`)
        .then(r => r.json())
        .then((data: Signal[]) => setSignals(data))
        .catch(() => setSignals([]));
    };
    load();
    const t = setInterval(load, DASHBOARD_POLL_MS);
    return () => clearInterval(t);
  }, []);

  // Briefings list (Phase 3)
  useEffect(() => {
    fetch(`${API}/briefings`)
      .then(r => r.json())
      .then((data: Briefing[]) => setBriefings(data))
      .catch(() => setBriefings([]));
  }, []);

  // Memories list (Phase 3) — refresh when Memory tab is active or on interval
  const loadMemories = () => {
    fetch(`${API}/memories`)
      .then(r => r.json())
      .then((data: Memory[]) => setMemories(data))
      .catch(() => setMemories([]));
  };
  useEffect(() => {
    loadMemories();
    const t = setInterval(loadMemories, DASHBOARD_POLL_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (activeTab === "chat") {
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [messages, loading, activeTab]);

  const sendMessage = async (text?: string) => {
    const userText = text || input.trim();
    if (!userText || loading) return;

    const userMsg: Message = { role: "user", content: userText, ts: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userText }),
      });
      const data = await res.json();
      if (!res.ok) {
        const errMsg = data?.detail ?? data?.error ?? "Request failed";
        setMessages(prev => [...prev, { role: "assistant", content: `Error: ${errMsg}`, ts: "" }]);
        return;
      }
      setMessages(prev => [...prev, {
        role: "assistant", content: data.reply ?? "",
        ts: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", content: "Server unreachable. Make sure `npm run dev` is running.", ts: "" }]);
    }
    setLoading(false);
  };

  const deleteMemory = async (key: string) => {
    try {
      await fetch(`${API}/memories/${encodeURIComponent(key)}`, { method: "DELETE" });
      setMemories((prev) => prev.filter((m) => m.key !== key));
    } catch (_) {}
  };

  const generateBriefingNow = async () => {
    if (briefingGenerating) return;
    setBriefingGenerating(true);
    setBriefingError(null);
    try {
      const res = await fetch(`${API}/briefings/generate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setBriefingError((data?.error ?? "Request failed") + (data?.detail ? `: ${data.detail}` : ""));
        return;
      }
      const generated = data as Briefing;
      if (generated?.id) {
        setBriefings((prev) => [generated, ...prev.filter((b) => b.id !== generated.id)].slice(0, 5));
      } else {
        setBriefingError("Briefing generated but invalid response format.");
      }
    } catch (e) {
      setBriefingError(e instanceof Error ? e.message : "Network error. Is the server running on port 3001?");
    } finally {
      setBriefingGenerating(false);
    }
  };

  const generateEveningBriefingNow = async () => {
    if (briefingGenerating) return;
    setBriefingGenerating(true);
    setBriefingError(null);
    try {
      const res = await fetch(`${API}/briefings/generate-evening`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setBriefingError((data?.error ?? "Request failed") + (data?.detail ? `: ${data.detail}` : ""));
        return;
      }
      const generated = data as Briefing & { email_sent?: boolean };
      if (generated?.id) {
        setBriefings((prev) => [generated, ...prev.filter((b) => b.id !== generated.id)].slice(0, 5));
        if (generated.email_sent) setBriefingError(null); // Clear any prior error; show success via the new briefing
      } else {
        setBriefingError("Evening briefing failed.");
      }
    } catch (e) {
      setBriefingError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBriefingGenerating(false);
    }
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500&family=DM+Mono:wght@400;500&display=swap');
        :root { --display: 'Syne', sans-serif; --body: 'DM Sans', sans-serif; --mono: 'DM Mono', monospace; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0a0a0a; color: #f0f0f0; font-family: var(--body); }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
        @keyframes pulse { 0%,100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.1); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .msg-enter { animation: fadeIn 0.25s ease forwards; }
        .chip:hover { background: rgba(0,255,148,0.08) !important; border-color: rgba(0,255,148,0.25) !important; color: #00ff94 !important; }
        .resize-handle:hover { background: rgba(0,255,148,0.08) !important; }
      `}</style>

      <div style={{ minHeight: "100vh", height: "100vh", background: "#0a0a0a", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>

        {/* Grid bg */}
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", backgroundImage: "linear-gradient(rgba(0,255,148,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,148,0.025) 1px, transparent 1px)", backgroundSize: "40px 40px" }} />

        {/* Header */}
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 24px", borderBottom: "1px solid rgba(255,255,255,0.06)", backdropFilter: "blur(10px)", position: "sticky", top: 0, zIndex: 10 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "0.15em", fontFamily: "var(--display)", background: "linear-gradient(135deg, #00ff94, #00d4aa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>ARIA</div>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.1em", fontFamily: "var(--mono)" }}>AUTONOMOUS RESEARCH & INTELLIGENCE ASSISTANT</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <StatusDot active={online} />
              <span style={{ fontSize: 10, color: "#555", fontFamily: "var(--mono)" }}>{online ? "SERVER ONLINE" : "SERVER OFFLINE"}</span>
            </div>
            <div style={{ display: "flex", gap: 4, background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: 4 }}>
              {["chat", "signals", "backtest", "briefing", "memory"].map(t => (
                <button key={t} onClick={() => setActiveTab(t)} style={{ padding: "5px 14px", borderRadius: 6, fontSize: 11, fontFamily: "var(--mono)", cursor: "pointer", border: "none", background: activeTab === t ? "rgba(0,255,148,0.12)" : "transparent", color: activeTab === t ? "#00ff94" : "#555", transition: "all 0.2s" }}>
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </header>

        {/* Body */}
        <div style={{ display: "flex", flex: 1, height: "calc(100vh - 65px)", overflow: "hidden" }}>

          {/* Sidebar */}
          <aside style={{ width: sidebarWidth, flexShrink: 0, display: "flex", flexDirection: "column", gap: 18, overflowY: "auto", height: "100%", minHeight: 0, padding: 18 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <button onClick={() => setHoldingsOpen((o) => !o)} style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
                  <span style={{ transform: holdingsOpen ? "rotate(90deg)" : "none", display: "inline-block", fontSize: 10, color: "#555", transition: "transform 0.2s ease" }}>▶</span>
                  <span style={{ fontSize: 9, letterSpacing: "0.14em", color: "#444", textTransform: "uppercase", fontFamily: "var(--mono)" }}>Holdings</span>
                </button>
                {holdingsOpen && memories.filter((m) => m.key.startsWith("position_")).length > 0 && (
                  <button
                    onClick={async () => {
                      if (ohlcvRefreshAll) return;
                      setOhlcvRefreshAll(true);
                      try {
                        await fetch(`${API}/ohlcv/refresh-all`, { method: "POST" });
                        setTimeout(() => setOhlcvRefreshAll(false), 60000);
                      } catch (_) {
                        setOhlcvRefreshAll(false);
                      }
                    }}
                    disabled={ohlcvRefreshAll}
                    style={{ fontSize: 8, padding: "3px 6px", background: "rgba(0,255,148,0.08)", border: "1px solid rgba(0,255,148,0.2)", borderRadius: 4, color: "#00ff94", cursor: ohlcvRefreshAll ? "wait" : "pointer", fontFamily: "var(--mono)" }}
                  >
                    {ohlcvRefreshAll ? "Refreshing…" : "Refresh all charts"}
                  </button>
                )}
              </div>
              <div style={{
                overflow: "hidden",
                maxHeight: (() => {
                  const count = memories.filter((m) => m.key.startsWith("position_")).length;
                  const CARD_H = 130;
                  const GAP = 7;
                  return holdingsOpen ? (count > 0 ? count * CARD_H + (count - 1) * GAP + 40 : 80) : 0;
                })(),
                transition: "max-height 0.3s ease",
              }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {memories.filter((m) => m.key.startsWith("position_")).length > 0
                      ? memories.filter((m) => m.key.startsWith("position_")).map((m) => {
                        let pos: { ticker?: string; amount?: string | number; entry?: string | number };
                        try { pos = typeof m.value === "string" ? JSON.parse(m.value) : (m.value ?? {}); } catch { pos = {}; }
                        const tickerFromKey = m.key.replace(/^position_/i, "").toUpperCase();
                        if (!pos.ticker && tickerFromKey) pos = { ...pos, ticker: tickerFromKey };
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
                      })
                    : <span style={{ fontSize: 11, color: "#444", fontFamily: "var(--mono)" }}>Add positions in Memory → Portfolio</span>}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 24 }}>
              <button onClick={() => setMarketPulseOpen((o) => !o)} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", marginBottom: 8 }}>
                <span style={{ transform: marketPulseOpen ? "rotate(90deg)" : "none", display: "inline-block", fontSize: 10, color: "#555", transition: "transform 0.2s ease" }}>▶</span>
                <span style={{ fontSize: 9, letterSpacing: "0.14em", color: "#444", textTransform: "uppercase", fontFamily: "var(--mono)" }}>Market Pulse</span>
              </button>
              <div style={{ overflow: "hidden", maxHeight: marketPulseOpen ? 1080 : 0, transition: "max-height 0.3s ease" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {(dashboard?.prices ?? []).length > 0
                    ? (dashboard?.tickers ?? FALLBACK_TICKERS).map((sym) => {
                        const p = dashboard!.prices.find((r) => r.symbol === sym);
                        const sig = dashboard!.signalsByTicker[sym];
                        if (!p) return <MetricCard key={sym} label={sym} value="—" sub="…" />;
                        const val = p.price >= 1000 ? `$${p.price.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : `$${Number(p.price).toFixed(2)}`;
                        const ch = p.change_24h != null ? `${p.change_24h >= 0 ? "↑" : "↓"} ${Math.abs(p.change_24h).toFixed(1)}% 24h` : "";
                        return <MetricCard key={sym} label={sym} value={val} sub={ch} signal={sig?.signal} rsi={sig?.indicator_data?.rsi} />;
                      })
                    : (dashboard?.tickers ?? FALLBACK_TICKERS).map((sym) => <MetricCard key={sym} label={sym} value="—" sub="loading" />)}
                </div>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 9, letterSpacing: "0.14em", color: "#444", textTransform: "uppercase", fontFamily: "var(--mono)", marginBottom: 8 }}>Tech News (HN)</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {(dashboard?.news ?? []).slice(0, 5).map((n) => (
                  <a key={n.id} href={n.url ?? `https://news.ycombinator.com/item?id=${n.id}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: "#888", fontFamily: "var(--mono)", textDecoration: "none", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                    {n.title}
                  </a>
                ))}
                {(!dashboard?.news?.length) && <span style={{ fontSize: 11, color: "#444", fontFamily: "var(--mono)" }}>Loading…</span>}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 9, letterSpacing: "0.14em", color: "#444", textTransform: "uppercase", fontFamily: "var(--mono)", marginBottom: 8 }}>Build Phase</div>
              {[{ label: "1 — The Shell", done: true }, { label: "2 — The Eyes", done: true }, { label: "3 — The Brain", done: true }, { label: "4 — The Edge", done: true }].map(p => (
                <div key={p.label} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", marginBottom: 5, background: p.done ? "rgba(0,255,148,0.06)" : "rgba(255,255,255,0.02)", border: p.done ? "1px solid rgba(0,255,148,0.15)" : "1px solid rgba(255,255,255,0.05)", borderRadius: 8 }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: p.done ? "#00ff94" : "#2a2a2a" }} />
                  <span style={{ fontSize: 11, color: p.done ? "#00ff94" : "#444", fontFamily: "var(--mono)" }}>{p.label}</span>
                </div>
              ))}
            </div>
          </aside>

          {/* Resize handle — drag to resize left/right panels */}
          <div
            className="resize-handle"
            onMouseDown={(e) => {
              resizeStartRef.current = { x: e.clientX, w: sidebarWidth };
              setResizing(true);
            }}
            style={{
              width: 10,
              flexShrink: 0,
              cursor: "col-resize",
              background: resizing ? "rgba(0,255,148,0.2)" : "rgba(255,255,255,0.04)",
              borderLeft: "1px solid rgba(255,255,255,0.08)",
              borderRight: "1px solid rgba(255,255,255,0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background 0.15s",
            }}
            title="Drag to resize panels"
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {[0, 1, 2].map((i) => (
                <div key={i} style={{ width: 3, height: 6, borderRadius: 1, background: resizing ? "rgba(0,255,148,0.7)" : "rgba(255,255,255,0.3)" }} />
              ))}
            </div>
          </div>

          {/* Main: Chat, Signals, Briefing */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
            {activeTab === "signals" ? (
              <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
                <div style={{ fontSize: 12, letterSpacing: "0.12em", color: "#555", fontFamily: "var(--mono)", marginBottom: 14 }}>LIVE SIGNALS</div>
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
                          <div style={{ fontSize: 11, color: "#555", fontFamily: "var(--mono)" }}>${Number(s.price).toLocaleString()} · {s.created_at ? new Date(s.created_at).toLocaleString() : ""}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : activeTab === "backtest" ? (
              <BacktestTab tickers={dashboard?.tickers ?? FALLBACK_TICKERS} />
            ) : activeTab === "briefing" ? (
              <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ fontSize: 12, letterSpacing: "0.12em", color: "#555", fontFamily: "var(--mono)", marginBottom: 4 }}>BRIEFINGS</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: "#666", fontFamily: "var(--mono)" }}>
                    {briefings[0] ? `Latest: ${new Date(briefings[0].created_at).toLocaleString()}` : "No briefing generated yet"}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {briefingGenerating && (
                      <div style={{
                        width: 14, height: 14, border: "2px solid rgba(0,255,148,0.3)", borderTopColor: "#00ff94", borderRadius: "50%",
                        animation: "spin 0.7s linear infinite",
                      }} />
                    )}
                    <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={generateBriefingNow}
                      disabled={briefingGenerating}
                      style={{
                        fontSize: 11,
                        fontFamily: "var(--mono)",
                        padding: "5px 10px",
                        borderRadius: 16,
                        border: "1px solid rgba(0,255,148,0.4)",
                        background: briefingGenerating ? "rgba(0,255,148,0.05)" : "transparent",
                        color: "#00ff94",
                        cursor: "pointer",
                      }}
                    >
                      {briefingGenerating ? "Generating…" : "Morning"}
                    </button>
                    <button
                      onClick={generateEveningBriefingNow}
                      disabled={briefingGenerating}
                      style={{
                        fontSize: 11,
                        fontFamily: "var(--mono)",
                        padding: "5px 10px",
                        borderRadius: 16,
                        border: "1px solid rgba(0,255,148,0.4)",
                        background: briefingGenerating ? "rgba(0,255,148,0.05)" : "transparent",
                        color: "#00ff94",
                        cursor: "pointer",
                      }}
                    >
                      Evening (6pm)
                    </button>
                    </div>
                  </div>
                </div>
                {briefingError && (
                  <div style={{ padding: "10px 14px", background: "rgba(255,71,87,0.1)", border: "1px solid rgba(255,71,87,0.3)", borderRadius: 8, fontSize: 12, color: "#ff6b6b", fontFamily: "var(--mono)" }}>
                    {briefingError}
                  </div>
                )}
                {briefings[0] && (
                  <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "16px 18px", fontSize: 13, lineHeight: 1.6, color: "#ccc", fontFamily: "var(--body)" }}>
                    <MarkdownContent content={briefings[0].content} />
                  </div>
                )}
                {briefings.length > 1 && (
                  <div style={{ marginTop: 16 }}>
                    <div style={{ fontSize: 10, color: "#555", fontFamily: "var(--mono)", marginBottom: 6 }}>PREVIOUS BRIEFINGS</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {briefings.slice(1, 5).map((b) => (
                        <div key={b.id} style={{ fontSize: 11, color: "#666", fontFamily: "var(--mono)" }}>
                          {new Date(b.created_at).toLocaleString()}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : activeTab === "memory" ? (
              <MemoryTab memories={memories} onRefresh={loadMemories} onDelete={deleteMemory} />
            ) : (
              <>
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
              {messages.map((msg, i) => (
                <ChatMessage key={msg.id ?? i} msg={msg} />
              ))}
              {loading && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", alignSelf: "flex-start" }}>
                  <div style={{ borderRadius: "14px 14px 14px 3px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}>
                    <TypingIndicator />
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div style={{ padding: "14px 24px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ display: "flex", gap: 7, marginBottom: 10, flexWrap: "wrap" }}>
                {SUGGESTED_PROMPTS.map((p, i) => (
                  <button key={i} className="chip" onClick={() => setInput(p.text)} style={{ fontSize: 11, padding: "4px 11px", borderRadius: 20, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#777", cursor: "pointer", fontFamily: "var(--mono)", transition: "all 0.15s" }}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                <textarea
                  ref={textareaRef}
                  style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 11, padding: "11px 15px", color: "#f0f0f0", fontSize: 14, outline: "none", fontFamily: "var(--body)", resize: "none", minHeight: 44, overflow: "hidden" }}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder={online ? "Ask ARIA anything..." : "Start the server with: npm run dev"}
                  onFocus={e => (e.target.style.borderColor = "rgba(0,255,148,0.4)")}
                  onBlur={e => (e.target.style.borderColor = "rgba(255,255,255,0.1)")}
                  rows={1}
                />
                <button
                  onClick={() => sendMessage()}
                  disabled={loading || !input.trim()}
                  style={{ background: "linear-gradient(135deg, #00ff94, #00d4aa)", border: "none", borderRadius: 10, padding: "11px 20px", color: "#0a0a0a", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "var(--display)", letterSpacing: "0.05em", opacity: loading || !input.trim() ? 0.4 : 1, transition: "opacity 0.2s" }}
                >
                  SEND
                </button>
              </div>
            </div>
            </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
