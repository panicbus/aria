import React, { useState, useEffect, useRef, useLayoutEffect } from "react";

import { MetricCard } from "../ui/MetricCard";
import { API, DASHBOARD_POLL_MS } from "../../config";

const MIN_HEIGHT = 1345;

export type MarketPulseItem = {
  symbol: string;
  category: "market_context" | "holding" | "watchlist";
  price: number | null;
  change_24h: number | null;
  signal: string | null;
  score: number | null;
  rsi: number | null;
  updated_at: string | null;
};

const SECTION_LABEL_STYLE: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: "0.14em",
  color: "#444",
  textTransform: "uppercase",
  fontFamily: "var(--mono)",
  marginTop: 12,
  marginBottom: 4,
};

export function MarketPulseAccordion({
  open,
  onToggle,
  refreshTrigger = 0,
}: {
  open: boolean;
  onToggle: () => void;
  refreshTrigger?: number;
}) {
  const [data, setData] = useState<MarketPulseItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [measuredHeight, setMeasuredHeight] = useState(MIN_HEIGHT);
  const [hasMeasured, setHasMeasured] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (open && contentRef.current) {
      const h = contentRef.current.scrollHeight;
      setMeasuredHeight(Math.max(MIN_HEIGHT, h));
      setHasMeasured(true);
    } else if (!open) {
      setHasMeasured(false);
    }
  }, [open, data?.length ?? 0, loading]);

  useEffect(() => {
    const fetchData = () => {
      fetch(`${API}/dashboard/market-pulse`)
        .then((r) => r.json())
        .then((items: MarketPulseItem[]) => {
          setData(Array.isArray(items) ? items : []);
          setLoading(false);
        })
        .catch(() => {
          setLoading(false);
          // Keep last known data on failure
        });
    };
    fetchData();
    const t = setInterval(fetchData, DASHBOARD_POLL_MS);
    return () => clearInterval(t);
  }, [refreshTrigger]);

  const items = data ?? [];
  const marketContext = items.filter((i) => i.category === "market_context");
  const holdings = items.filter((i) => i.category === "holding");
  const watchlist = items.filter((i) => i.category === "watchlist");

  const renderCard = (item: MarketPulseItem) => {
    const val =
      item.price != null
        ? item.price >= 1000
          ? `$${item.price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
          : `$${Number(item.price).toFixed(2)}`
        : "—";
    const ch =
      item.change_24h != null
        ? `${item.change_24h >= 0 ? "↑" : "↓"} ${Math.abs(item.change_24h).toFixed(1)}% 24h`
        : "";
    return (
      <MetricCard
        key={item.symbol}
        label={item.symbol}
        value={val}
        sub={ch || undefined}
        signal={item.signal ?? undefined}
        rsi={item.rsi ?? undefined}
      />
    );
  };

  const skeletonItems = [
    { symbol: "SPY", category: "market_context" as const },
    { symbol: "BTC", category: "market_context" as const },
    { symbol: "ETH", category: "market_context" as const },
  ];

  return (
    <div style={{ marginTop: 24 }}>
      <button
        onClick={onToggle}
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
        <span
          style={{
            transform: open ? "rotate(90deg)" : "none",
            display: "inline-block",
            fontSize: 10,
            color: "#555",
            transition: "transform 0.2s ease",
          }}
        >
          ▶
        </span>
        <span style={SECTION_LABEL_STYLE}>Market Pulse</span>
      </button>
      <div
        style={{
          overflow: "hidden",
          maxHeight: open ? (hasMeasured ? Math.max(MIN_HEIGHT, measuredHeight) : 9999) : 0,
          transition: "max-height 0.3s ease",
        }}
      >
        <div ref={contentRef} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {loading && !data ? (
            skeletonItems.map((item) => (
              <MetricCard key={item.symbol} label={item.symbol} value="—" sub="loading" />
            ))
          ) : items.length === 0 ? (
            skeletonItems.map((item) => (
              <MetricCard key={item.symbol} label={item.symbol} value="—" sub="loading" />
            ))
          ) : (
            <>
              {marketContext.length > 0 && (
                <>
                  <div style={{ ...SECTION_LABEL_STYLE, marginTop: 0 }}>MARKET</div>
                  {marketContext.map(renderCard)}
                </>
              )}
              {holdings.length > 0 && (
                <>
                  <div style={SECTION_LABEL_STYLE}>HOLDINGS</div>
                  {holdings.map(renderCard)}
                </>
              )}
              {watchlist.length > 0 && (
                <>
                  <div style={SECTION_LABEL_STYLE}>WATCHLIST</div>
                  {watchlist.map(renderCard)}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
