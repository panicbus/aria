import React, { useState, useEffect, useRef } from "react";

import { HoldingsCard } from "./components/holdings/HoldingsCard";
import { TypingIndicator } from "./components/ui/TypingIndicator";
import { StatusDot } from "./components/ui/StatusDot";
import { MetricCard } from "./components/ui/MetricCard";
import { BacktestTab } from "./components/tabs/BacktestTab";
import { BriefingTab } from "./components/tabs/BriefingTab";
import { PortfolioTab } from "./components/tabs/PortfolioTab";
import { MemoryTab } from "./components/tabs/MemoryTab";
import { ScannerTab } from "./components/tabs/ScannerTab";
import { ChatMessage } from "./components/chat/ChatMessage";
import { HoldingsAccordion } from "./components/sidebar/HoldingsAccordion";
import { MarketPulseAccordion } from "./components/sidebar/MarketPulseAccordion";
import { TechNewsList } from "./components/sidebar/TechNewsList";
import { BuildPhaseList } from "./components/sidebar/BuildPhaseList";
import { API, SUGGESTED_PROMPTS, FALLBACK_TICKERS, DASHBOARD_POLL_MS, signalColors } from "./config";
import type { Message, Signal, Dashboard, Memory } from "./types";

const TZ = "America/Los_Angeles";
const formatTs = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const formatTimeLA = (iso?: string) =>
  (iso ? new Date(iso) : new Date()).toLocaleTimeString("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

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
  const [memories, setMemories] = useState<Memory[]>([]);
  const [holdingsOpen, setHoldingsOpen] = useState(false);
  const [ohlcvRefreshAll, setOhlcvRefreshAll] = useState(false);
  const [marketPulseOpen, setMarketPulseOpen] = useState(true);
  const [backtestPreselectedTicker, setBacktestPreselectedTicker] = useState<string | null>(null);
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
            ts: formatTimeLA(),
          }]);
        } else {
          setMessages(data.map(m => ({ ...m, ts: formatTimeLA(m.created_at!) })));
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

    const userMsg: Message = { role: "user", content: userText, ts: formatTimeLA() };
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
        ts: formatTimeLA(),
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

  const addToWatchlist = async (ticker: string) => {
    const sym = ticker.toUpperCase();
    const watchRow = memories.find((m) => m.key === "watchlist");
    const current = watchRow?.value?.trim() ?? "";
    const existing = current.split(/[\s,]+/).map((s) => s.toUpperCase()).filter(Boolean);
    if (existing.includes(sym)) return;
    const updated = [...existing, sym].join(", ");
    try {
      await fetch(`${API}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "watchlist", value: updated }),
      });
      loadMemories();
    } catch (_) {}
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
              {["chat", "portfolio", "signals", "scanner", "backtest", "briefing", "memory"].map(t => (
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
            <HoldingsAccordion
              memories={memories}
              dashboard={dashboard}
              open={holdingsOpen}
              onToggle={() => setHoldingsOpen((o) => !o)}
              ohlcvRefreshAll={ohlcvRefreshAll}
              onRefreshAll={async () => {
                if (ohlcvRefreshAll) return;
                setOhlcvRefreshAll(true);
                try {
                  await fetch(`${API}/ohlcv/refresh-all`, { method: "POST" });
                  setTimeout(() => setOhlcvRefreshAll(false), 60000);
                } catch (_) {
                  setOhlcvRefreshAll(false);
                }
              }}
            />
            <MarketPulseAccordion
              dashboard={dashboard}
              open={marketPulseOpen}
              onToggle={() => setMarketPulseOpen((o) => !o)}
            />
            <TechNewsList news={dashboard?.news ?? []} />
            <BuildPhaseList />
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

          {/* Main: Portfolio, Chat, Signals, Briefing */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
            {activeTab === "portfolio" ? (
              <PortfolioTab
                dashboard={dashboard}
                onViewBacktest={(t) => {
                  setBacktestPreselectedTicker(t);
                  setActiveTab("backtest");
                }}
              />
            ) : activeTab === "signals" ? (
              <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
                <div style={{ fontSize: 16, letterSpacing: "0.12em", color: "#555", fontFamily: "var(--mono)", marginBottom: 14 }}>LIVE SIGNALS</div>
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
            ) : activeTab === "scanner" ? (
              <ScannerTab
                onAddToWatchlist={addToWatchlist}
                onViewBacktest={(t) => {
                  setBacktestPreselectedTicker(t);
                  setActiveTab("backtest");
                }}
              />
            ) : activeTab === "backtest" ? (
              <BacktestTab
                tickers={dashboard?.tickers ?? FALLBACK_TICKERS}
                preselectedTicker={activeTab === "backtest" ? backtestPreselectedTicker : null}
              />
            ) : activeTab === "briefing" ? (
              <BriefingTab />
            ) : activeTab === "memory" ? (
              <MemoryTab memories={memories} dashboard={dashboard} onRefresh={loadMemories} onDelete={deleteMemory} />
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
