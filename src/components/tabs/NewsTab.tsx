import React, { useState, useEffect } from "react";

import { API } from "../../config";
import { useIsMobile } from "../../hooks/useIsMobile";
import type { NewsRow, StockNewsArticle } from "../../types";

const TZ = "America/Los_Angeles";
const NEWS_POLL_MS = 30 * 60 * 1000;

const normalizeIso = (iso: string) =>
  iso && !/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso.replace(" ", "T") + "Z" : iso;
const formatDateHeader = (iso: string) =>
  new Date(normalizeIso(iso)).toLocaleDateString("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
const formatTime = (iso: string) =>
  new Date(normalizeIso(iso)).toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  });

const isLessThan1DayOld = (iso: string) => {
  const ageMs = Date.now() - new Date(normalizeIso(iso)).getTime();
  return ageMs < 24 * 60 * 60 * 1000;
};

const relativeTime = (iso: string) => {
  const ms = Date.now() - new Date(normalizeIso(iso)).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
};

function groupByDay<T extends { [K in F]: string }, F extends string>(
  items: T[],
  field: F,
  maxPerDay: number,
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const d = new Date(normalizeIso(item[field] as string));
    const key = d.toLocaleDateString("en-CA", { timeZone: TZ });
    if (!map.has(key)) map.set(key, []);
    const arr = map.get(key)!;
    if (arr.length < maxPerDay) arr.push(item);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => new Date(normalizeIso(b[field] as string)).getTime() - new Date(normalizeIso(a[field] as string)).getTime());
  }
  return new Map([...map.entries()].sort((a, b) => b[0].localeCompare(a[0])));
}

const PILL_BASE: React.CSSProperties = {
  fontSize: 11,
  padding: "4px 12px",
  borderRadius: 20,
  cursor: "pointer",
  fontFamily: "var(--mono)",
  border: "none",
};

export function NewsTab() {
  const [view, setView] = useState<"tech" | "stock">("tech");
  const [news, setNews] = useState<NewsRow[]>([]);
  const [stockNews, setStockNews] = useState<StockNewsArticle[]>([]);
  const [stockLoading, setStockLoading] = useState(false);
  const isMobile = useIsMobile();

  const loadHN = () => {
    fetch(`${API}/news?days=5`)
      .then((r) => r.json())
      .then((data: NewsRow[]) => setNews(Array.isArray(data) ? data : []))
      .catch(() => setNews([]));
  };

  const loadStock = () => {
    setStockLoading(true);
    fetch(`${API}/stock-news?days=5`)
      .then((r) => r.json())
      .then((data: StockNewsArticle[]) => {
        if (!Array.isArray(data)) { setStockNews([]); return; }
        // Deduplicate by URL in the UI
        const seen = new Set<string>();
        setStockNews(data.filter((a) => {
          if (seen.has(a.url)) return false;
          seen.add(a.url);
          return true;
        }));
      })
      .catch(() => setStockNews([]))
      .finally(() => setStockLoading(false));
  };

  useEffect(() => {
    loadHN();
    loadStock();
    const t1 = setInterval(loadHN, NEWS_POLL_MS);
    const t2 = setInterval(loadStock, NEWS_POLL_MS);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, []);

  const byDay = groupByDay(news, "created_at", 6);
  const stockByDay = groupByDay(stockNews, "published_at", 10);

  const hoverHandlers = (el: HTMLAnchorElement, enter: boolean) => {
    el.style.background = enter ? "rgba(0,255,148,0.06)" : "rgba(255,255,255,0.03)";
    el.style.borderColor = enter ? "rgba(0,255,148,0.2)" : "rgba(255,255,255,0.07)";
  };

  return (
    <div className="tab-news" style={{ flex: 1, overflowY: "auto", padding: "0 24px 20px", display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "#0e0e0e", paddingTop: 20, paddingBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 16, letterSpacing: "0.12em", color: "#999", fontWeight: 600, fontFamily: "var(--mono)" }}>
          NEWS
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {(["tech", "stock"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                ...PILL_BASE,
                background: view === v ? "rgba(0,255,148,0.12)" : "rgba(255,255,255,0.05)",
                border: view === v ? "0.5px solid rgba(0,255,148,0.25)" : "0.5px solid rgba(255,255,255,0.08)",
                color: view === v ? "#00ff94" : "#888",
              }}
            >
              {v === "tech" ? "Tech News" : "Stock News"}
            </button>
          ))}
        </div>
      </div>

      {view === "tech" ? (
        /* ── Tech News (HN) — unchanged ── */
        byDay.size === 0 ? (
          <div style={{ color: "#777", fontSize: 15, fontFamily: "var(--mono)" }}>
            No articles in the last 5 days. HN headlines refresh every 30 minutes.
          </div>
        ) : (
          [...byDay.entries()].map(([dateKey, articles]) => {
            const first = articles[0];
            const headerLabel = first ? formatDateHeader(first.created_at) : dateKey;
            const timeLabel = first ? formatTime(first.created_at) : "";
            return (
              <section key={dateKey}>
                <div style={{ fontSize: 12, letterSpacing: "0.1em", color: "#888", fontFamily: "var(--mono)", marginBottom: 12, paddingBottom: 6, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  {headerLabel}
                  {timeLabel && <span style={{ marginLeft: 10, color: "#777" }}>{timeLabel} PT</span>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {articles.map((n) => (
                    <a
                      key={n.id}
                      className="news-article"
                      href={n.url ?? `https://news.ycombinator.com/item?id=${n.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ display: "flex", flexDirection: "column", gap: 4, padding: "14px 16px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, textDecoration: "none", color: "#e0e0e0", fontFamily: "var(--body)", transition: "background 0.15s, border-color 0.15s" }}
                      {...(!isMobile && {
                        onMouseEnter: (e: React.MouseEvent<HTMLAnchorElement>) => hoverHandlers(e.currentTarget, true),
                        onMouseLeave: (e: React.MouseEvent<HTMLAnchorElement>) => hoverHandlers(e.currentTarget, false),
                      })}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        {isLessThan1DayOld(n.created_at) && (
                          <span style={{ fontSize: 10, fontFamily: "var(--mono)", letterSpacing: "0.08em", padding: "2px 6px", borderRadius: 4, background: "rgba(0,255,148,0.15)", border: "1px solid rgba(0,255,148,0.35)", color: "#00ff94", flexShrink: 0 }}>NEW</span>
                        )}
                        <span className="news-title" style={{ fontSize: 16, lineHeight: 1.5, flex: 1, minWidth: 0 }}>{n.title}</span>
                      </div>
                      {n.summary && (
                        <div className="news-summary" style={{ fontSize: 13, opacity: 0.8, color: "#999", fontFamily: "var(--body)", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginLeft: 45 }}>
                          {n.summary}
                        </div>
                      )}
                    </a>
                  ))}
                </div>
              </section>
            );
          })
        )
      ) : (
        /* ── Stock News (Finnhub) ── */
        stockLoading && stockNews.length === 0 ? (
          <div style={{ color: "#777", fontSize: 13, fontFamily: "var(--mono)" }}>Loading stock news…</div>
        ) : stockNews.length === 0 ? (
          <div style={{ color: "#444", fontSize: 13, fontFamily: "var(--mono)", textAlign: "center", padding: 32 }}>
            Stock news loads every 30 minutes. Check back shortly.
          </div>
        ) : (
          [...stockByDay.entries()].map(([dateKey, articles]) => {
            const first = articles[0];
            const headerLabel = first ? formatDateHeader(first.published_at) : dateKey;
            return (
              <section key={dateKey}>
                <div style={{ fontSize: 12, letterSpacing: "0.1em", color: "#888", fontFamily: "var(--mono)", marginBottom: 12, paddingBottom: 6, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  {headerLabel}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {articles.map((a) => (
                    <a
                      key={a.id}
                      className="news-article"
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ display: "flex", flexDirection: "column", gap: 4, padding: "14px 16px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, textDecoration: "none", color: "#e0e0e0", fontFamily: "var(--body)", transition: "background 0.15s, border-color 0.15s" }}
                      {...(!isMobile && {
                        onMouseEnter: (e: React.MouseEvent<HTMLAnchorElement>) => hoverHandlers(e.currentTarget, true),
                        onMouseLeave: (e: React.MouseEvent<HTMLAnchorElement>) => hoverHandlers(e.currentTarget, false),
                      })}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span style={{ display: "inline-block", fontSize: 15, fontWeight: 700, color: "#c2c2c2", fontFamily: "Syne, var(--display)", flexShrink: 0 }}>
                          {a.ticker}
                        </span>
                        {isLessThan1DayOld(a.published_at) && (
                          <span style={{ fontSize: 10, fontFamily: "var(--mono)", letterSpacing: "0.08em", padding: "2px 6px", borderRadius: 4, background: "rgba(0,255,148,0.15)", border: "1px solid rgba(0,255,148,0.35)", color: "#00ff94", flexShrink: 0 }}>NEW</span>
                        )}
                        <span className="news-title" style={{ fontSize: 16, lineHeight: 1.5, flex: 1, minWidth: 0, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                          {a.title}
                        </span>
                      </div>
                      {a.summary && (
                        <div className="news-summary" style={{ fontSize: 13, color: "#999", fontFamily: "var(--body)", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                          {a.summary}
                        </div>
                      )}
                      <div style={{ fontSize: 9, color: "#777", fontFamily: "var(--mono)" }}>
                        {a.source} · {relativeTime(a.published_at)}
                      </div>
                    </a>
                  ))}
                </div>
              </section>
            );
          })
        )
      )}
    </div>
  );
}
