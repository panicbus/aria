import React, { useState, useEffect, useRef } from "react";

import { API, MEMORY_SECTIONS, RISK_OPTIONS, SIGNALS_OPTIONS } from "../../config";

const TZ = "America/Los_Angeles";
const formatTs = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
import type { Memory, Dashboard } from "../../types";

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

type PositionParsed = {
  ticker?: string;
  amount?: number;
  entry?: number;
  quantity?: number;
  average_cost?: number;
};

function formatPositionDisplay(
  v: PositionParsed,
  key: string,
  currentPrice: number | null
): string {
  const ticker = (v.ticker ?? key.replace(/^position_/i, "") ?? "").toUpperCase().trim() || "—";
  const qty = v.amount ?? v.quantity;
  const entry = v.entry ?? v.average_cost;
  const qtyStr = qty != null && !isNaN(Number(qty)) ? String(Number(qty)) : "?";
  const entryStr =
    entry != null && !isNaN(Number(entry))
      ? `$${Number(entry) >= 1000 ? Number(entry).toLocaleString("en-US", { maximumFractionDigits: 0 }) : Number(entry).toFixed(2)}`
      : "?";
  let base = `${ticker}: ${qtyStr} @ ${entryStr}`;
  if (currentPrice != null && !isNaN(currentPrice)) {
    const priceStr = currentPrice >= 1000 ? currentPrice.toLocaleString("en-US", { maximumFractionDigits: 0 }) : currentPrice.toFixed(2);
    base += ` · now $${priceStr}`;
    if (entry != null && !isNaN(Number(entry)) && Number(entry) > 0) {
      const pct = (((currentPrice - Number(entry)) / Number(entry)) * 100).toFixed(1);
      base += ` (${Number(pct) >= 0 ? "+" : ""}${pct}%)`;
    }
  }
  return base;
}

export function MemoryTab({
  memories,
  dashboard,
  onRefresh,
  onDelete,
}: {
  memories: Memory[];
  dashboard?: Dashboard | null;
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
    const quantity = parseFloat(newPosition.amount);
    const average_cost = parseFloat(newPosition.entry);
    if (!ticker || isNaN(quantity) || isNaN(average_cost)) return;
    saveMemory(`position_${ticker}`, { ticker, quantity, average_cost });
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
        <div style={{ fontSize: 16, letterSpacing: "0.12em", color: "#555", fontFamily: "var(--mono)" }}>MEMORY</div>
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
              const v = parseMemoryValue(m.value) as PositionParsed;
              const ticker = (v?.ticker ?? m.key.replace(/^position_/i, "") ?? "").toUpperCase().trim() || "?";
              const currentPrice = dashboard?.prices?.find((r) => r.symbol === ticker)?.price ?? null;
              const disp =
                typeof v === "object" && v && (v.ticker != null || v.amount != null || v.quantity != null || v.entry != null || v.average_cost != null)
                  ? formatPositionDisplay(v, m.key, currentPrice)
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
                  <div style={{ fontSize: 10, color: "#555", fontFamily: "var(--mono)", marginTop: 4 }}>updated {m.updated_at ? formatTs(m.updated_at) : ""}</div>
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
