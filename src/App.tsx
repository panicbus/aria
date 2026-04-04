import React, { useState, useEffect, useRef } from "react";

import { StatusDot } from "./components/ui/StatusDot";
import { BacktestTab } from "./components/tabs/BacktestTab";
import { BriefingTab } from "./components/tabs/BriefingTab";
import { PortfolioTab } from "./components/tabs/PortfolioTab";
import { MemoryTab } from "./components/tabs/MemoryTab";
import { ScannerTab } from "./components/tabs/ScannerTab";
import { ChatTab } from "./components/chat/ChatTab";
import { HoldingsAccordion } from "./components/sidebar/HoldingsAccordion";
import { MarketPulseAccordion } from "./components/sidebar/MarketPulseAccordion";
import { NewsTab } from "./components/tabs/NewsTab";
import { SignalsTab } from "./components/tabs/SignalsTab";
import { BuildPhaseList } from "./components/sidebar/BuildPhaseList";
import { MobileNav } from "./components/nav/MobileNav";
import { useIsMobile } from "./hooks/useIsMobile";
import { API, FALLBACK_TICKERS, DASHBOARD_POLL_MS } from "./config";
import type { Message, Signal, Dashboard, Memory } from "./types";

const TZ = "America/Los_Angeles";
// Server timestamps (SQLite CURRENT_TIMESTAMP) are UTC without "Z"; treat as UTC so display is correct
const formatTs = (iso: string) => {
  const normalized = iso && !/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso.replace(" ", "T") + "Z" : iso;
  return new Date(normalized).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const formatTimeLA = (iso?: string) =>
  (iso ? new Date(iso) : new Date()).toLocaleTimeString("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

export default function App() {
  const isMobile = useIsMobile();
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
  const [holdingsOpen, setHoldingsOpen] = useState(true);
  const [ohlcvRefreshAll, setOhlcvRefreshAll] = useState(false);
  const [sidebarRefreshTrigger, setSidebarRefreshTrigger] = useState(0);
  const [backtestPreselectedTicker, setBacktestPreselectedTicker] = useState<string | null>(null);
  const [quickMode, setQuickMode] = useState(false);
  const loadHistory = React.useCallback(() => {
    fetch(`${API}/history?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((data: unknown) => {
        const arr = Array.isArray(data) ? data : (data && typeof data === "object" && Array.isArray((data as any).messages) ? (data as any).messages : []);
        if (arr.length === 0) {
          setMessages([{
            role: "assistant",
            content: "ARIA online. I'm your personal intelligence layer — tech industry, financial signals, and developer growth. What do you need?",
            ts: formatTimeLA(),
          }]);
        } else {
          setMessages(arr.map((m: { id?: number; role: string; content: string; created_at?: string }) => ({
            ...m,
            ts: formatTimeLA(m.created_at ?? new Date().toISOString()),
          })));
        }
      })
      .catch(() => setMessages([{
        role: "assistant",
        content: "ARIA online. I'm your personal intelligence layer — tech industry, financial signals, and developer growth. What do you need?",
        ts: formatTimeLA(),
      }]));
  }, []);

  useEffect(() => {
    // Check server health
    fetch(`${API}/health`)
      .then(r => r.json())
      .then(() => setOnline(true))
      .catch(() => setOnline(false));

    loadHistory();
    // Reload history when user returns to tab (helps if initial load was cached/stale)
    const onFocus = () => { if (document.visibilityState === "visible") loadHistory(); };
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, [loadHistory]);

  // Retry loading history if we're on chat but only have welcome/empty (initial load may have failed)
  const hasRealHistory = messages.length > 1 || (messages.length === 1 && messages[0]?.role === "user");
  useEffect(() => {
    if (activeTab !== "chat" || hasRealHistory) return;
    const t = setTimeout(loadHistory, 800);
    return () => clearTimeout(t);
  }, [activeTab, hasRealHistory, loadHistory]);

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
        .then((data: Signal[]) => {
          const seen = new Set<string>();
          const deduped = data.filter((s) => {
            const key = s.ticker.toUpperCase().trim();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          setSignals(deduped);
        })
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

  const clearChat = async () => {
    try {
      await fetch(`${API}/history`, { method: "DELETE" });
      setMessages([]);
    } catch (_) {}
  };

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
        body: JSON.stringify({ message: userText, quick: quickMode, quickMode }),
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
      // Refresh sidebar (holdings, watchlist) — ARIA may have added/removed via tools
      loadMemories();
      setSidebarRefreshTrigger((t) => t + 1);
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", content: "Server unreachable. Make sure `npm run dev` is running.", ts: "" }]);
    }
    setLoading(false);
  };

  const deleteMemory = async (key: string) => {
    try {
      await fetch(`${API}/memories/${encodeURIComponent(key)}`, { method: "DELETE" });
      setMemories((prev) => prev.filter((m) => m.key !== key));
      setSidebarRefreshTrigger((t) => t + 1);
    } catch (_) {}
  };

  const addToWatchlist = async (ticker: string): Promise<"added" | "duplicate"> => {
    const sym = ticker.toUpperCase();
    const watchRow = memories.find((m) => m.key === "watchlist");
    const current = watchRow?.value?.trim() ?? "";
    const existing = current.split(/[\s,]+/).map((s) => s.toUpperCase()).filter(Boolean);
    if (existing.includes(sym)) return "duplicate";
    const updated = [...existing, sym].join(", ");
    try {
      await fetch(`${API}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "watchlist", value: updated }),
      });
      loadMemories();
      setSidebarRefreshTrigger((t) => t + 1);
    } catch (_) {}
    return "added";
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

      <div className="aria-root" style={{ minHeight: "100vh", height: "100vh", background: "#0a0a0a", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>

        {/* Grid bg */}
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", backgroundImage: "linear-gradient(rgba(0,255,148,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,148,0.025) 1px, transparent 1px)", backgroundSize: "40px 40px" }} />

        {/* Header */}
        <header className="aria-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 24px", borderBottom: "1px solid rgba(255,255,255,0.06)", backdropFilter: "blur(10px)", position: "sticky", top: 0, zIndex: 10 }}>
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: "0.15em", fontFamily: "var(--display)", background: "linear-gradient(135deg, #00ff94, #00d4aa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>ARIA</span>
              <span style={{ fontSize: 9, color: "#555", fontFamily: "var(--mono)", letterSpacing: "0.05em" }}>v1.7.4</span>
            </div>
            <div className="aria-subtitle" style={{ fontSize: 9, color: "#444", letterSpacing: "0.1em", fontFamily: "var(--mono)" }}>AUTONOMOUS RESEARCH & INTELLIGENCE ASSISTANT</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <StatusDot active={online} />
              <span style={{ fontSize: 10, color: "#777", fontFamily: "var(--mono)" }}>{online ? (isMobile ? "online" : "SERVER ONLINE") : (isMobile ? "offline" : "SERVER OFFLINE")}</span>
            </div>
            <div className="aria-top-tabs" style={{ display: "flex", gap: 4, background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: 4 }}>
              {["chat", "portfolio", "signals", "scanner", "backtest", "briefing", "news", "memory"].map((t) => (
                <button key={t} onClick={() => setActiveTab(t)} style={{ padding: "5px 14px", borderRadius: 6, fontSize: 11, fontFamily: "var(--mono)", cursor: "pointer", border: "none", background: activeTab === t ? "rgba(0,255,148,0.12)" : "transparent", color: activeTab === t ? "#00ff94" : "#777", transition: "all 0.2s" }}>
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </header>

        {/* Body */}
        <div className="aria-body" style={{ display: "flex", flex: 1, height: "calc(100vh - 65px)", overflow: "hidden" }}>

          {/* Sidebar */}
          <aside className="aria-sidebar" style={{ width: sidebarWidth, flexShrink: 0, display: "flex", flexDirection: "column", gap: 18, overflowY: "auto", height: "100%", minHeight: 0, padding: 18 }}>
            <HoldingsAccordion
              memories={memories}
              dashboard={dashboard}
              open={holdingsOpen}
              onToggle={() => setHoldingsOpen((o) => !o)}
              ohlcvRefreshAll={ohlcvRefreshAll}
              refreshTrigger={sidebarRefreshTrigger}
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
              refreshTrigger={sidebarRefreshTrigger}
            />
            <BuildPhaseList />
          </aside>

          {/* Resize handle — drag to resize left/right panels */}
          <div
            className="aria-resize-handle resize-handle"
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
          <div className="aria-main aria-content" style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
            {activeTab === "portfolio" ? (
              <PortfolioTab
                dashboard={dashboard}
                onViewBacktest={(t) => {
                  setBacktestPreselectedTicker(t);
                  setActiveTab("backtest");
                }}
                onPortfolioRefresh={() => setSidebarRefreshTrigger((t) => t + 1)}
              />
            ) : activeTab === "signals" ? (
              <SignalsTab signals={signals} formatTs={formatTs} />
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
            ) : activeTab === "news" ? (
              <NewsTab />
            ) : activeTab === "memory" ? (
              <MemoryTab
              memories={memories}
              dashboard={dashboard}
              onRefresh={() => {
                loadMemories();
                setSidebarRefreshTrigger((t) => t + 1);
              }}
              onDelete={deleteMemory}
            />
            ) : (
              <ChatTab
                messages={messages}
                loading={loading}
                input={input}
                setInput={setInput}
                quickMode={quickMode}
                setQuickMode={setQuickMode}
                online={online}
                onSend={sendMessage}
                onClearChat={clearChat}
              />
            )}
          </div>
        </div>
      </div>

      {isMobile && <MobileNav activeTab={activeTab} onTabChange={setActiveTab} />}
    </>
  );
}
