import React, { useState, useEffect, useRef } from "react";
import { API } from "../../config";
import { useIsMobile } from "../../hooks/useIsMobile";
import { signalColors } from "../../config";
import type { ScannerResult, ScannerStatus, ScannerCandidate } from "../../types";

const TZ = "America/Los_Angeles";

function formatLastScan(iso: string): string {
  const normalized = iso && !/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso.replace(" ", "T") + "Z" : iso;
  return new Date(normalized).toLocaleString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

type FilterPill = "ALL" | "STRONG BUY" | "BUY" | "UNUSUAL MOVE";

function isUnusualMove(r: ScannerResult): boolean {
  if (r.rsi != null && (r.rsi < 30 || r.rsi > 70)) return true;
  if (r.macd_histogram != null && Math.abs(r.macd_histogram) > 1) return true;
  if (r.change_24h != null && Math.abs(r.change_24h) > 5) return true;
  return false;
}

function filterResults(results: ScannerResult[], filter: FilterPill): ScannerResult[] {
  if (filter === "ALL") return results;
  if (filter === "STRONG BUY") return results.filter((r) => r.signal === "STRONG BUY");
  if (filter === "BUY") return results.filter((r) => r.signal === "BUY" || r.signal === "STRONG BUY");
  if (filter === "UNUSUAL MOVE") return results.filter(isUnusualMove);
  return results;
}

const OHLCV_TARGET = 50;

function progressColor(days: number): string {
  if (days >= 40) return "rgba(0,255,148,0.6)";
  if (days >= 25) return "rgba(251,191,36,0.6)";
  return "rgba(255,255,255,0.2)";
}

export function ScannerTab({
  onAddToWatchlist,
  onViewBacktest,
}: {
  onAddToWatchlist?: (ticker: string) => Promise<void>;
  onViewBacktest?: (ticker: string) => void;
}) {
  const [results, setResults] = useState<ScannerResult[]>([]);
  const [status, setStatus] = useState<ScannerStatus | null>(null);
  const [filter, setFilter] = useState<FilterPill>("ALL");
  const [scanning, setScanning] = useState(false);
  const [fullResultsOpen, setFullResultsOpen] = useState(false);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [candidates, setCandidates] = useState<ScannerCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [addingTicker, setAddingTicker] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [companyNames, setCompanyNames] = useState<Record<string, string>>({});
  const infoRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  const fetchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const symbols = [...new Set(results.map((r) => r.symbol))];
    const toFetch = symbols.filter((s) => !fetchedRef.current.has(s));
    if (toFetch.length === 0) return;
    toFetch.forEach((s) => fetchedRef.current.add(s));
    let cancelled = false;
    Promise.all(
      toFetch.map((symbol) =>
        fetch(`${API}/scanner/company/${encodeURIComponent(symbol)}`)
          .then((r) => r.json())
          .then((data: { name?: string }) => ({ symbol, name: data?.name ?? symbol }))
          .catch(() => ({ symbol, name: symbol }))
      )
    ).then((pairs) => {
      if (cancelled) return;
      setCompanyNames((prev) => {
        const next = { ...prev };
        for (const { symbol, name } of pairs) next[symbol] = name;
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [results]);

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

  const load = () => {
    fetch(`${API}/scanner/results`)
      .then((r) => r.json())
      .then((data: ScannerResult[]) => setResults(data))
      .catch(() => setResults([]));
    fetch(`${API}/scanner/status`)
      .then((r) => r.json())
      .then((data: ScannerStatus) => setStatus(data))
      .catch(() => setStatus(null));
    fetch(`${API}/scanner/candidates`)
      .then((r) => r.json())
      .then((data: { candidates: ScannerCandidate[] }) => setCandidates(Array.isArray(data?.candidates) ? data.candidates : []))
      .catch(() => setCandidates([]));
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const runScan = async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch(`${API}/scanner/run`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Scan failed");
        return;
      }
      if (data.status === "scanning") {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          load();
          const st = await fetch(`${API}/scanner/status`).then((r) => r.json());
          if (!st.scanning) break;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setScanning(false);
      load();
    }
  };

  const addToWatchlist = async (ticker: string) => {
    if (!onAddToWatchlist) return;
    setAddingTicker(ticker);
    try {
      await onAddToWatchlist(ticker);
    } finally {
      setAddingTicker(null);
    }
  };

  const topPicks = results.slice(0, 10);
  const allFiltered = filterResults(results, filter);
  const apiLimitReached = status != null && status.apiCallsRemaining <= 0;
  const pendingCandidates = candidates.filter((c) => c.status === "pending");

  const metricsExplainer = (
    <div style={{ padding: 12, maxWidth: 510 }}>
      <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 10, color: "#00ff94", fontFamily: "var(--mono)" }}>What do these mean?</div>
      <p style={{ fontSize: 18, lineHeight: 1.55, color: "#aaa", marginBottom: 10, fontFamily: "var(--body)" }}>
        <strong style={{ color: "#00ff94" }}>STRONG BUY</strong> — A bunch of indicators agree this might be a good time to look. We combine RSI (Relative Strength Index—tells you if a stock is overbought or oversold), MACD (Moving Average Convergence Divergence—a momentum indicator), and where the price sits vs its recent averages. When most of those line up in a positive way, we call it a strong buy.
      </p>
      <p style={{ fontSize: 18, lineHeight: 1.55, color: "#aaa", marginBottom: 10, fontFamily: "var(--body)" }}>
        <strong style={{ color: "#00ff94" }}>BUY</strong> — Some signs look good, but not everything's aligned. Worth keeping an eye on—maybe do a bit more research before jumping in.
      </p>
      <p style={{ fontSize: 18, lineHeight: 1.55, color: "#aaa", marginBottom: 0, fontFamily: "var(--body)" }}>
        <strong style={{ color: "#a29bfe" }}>UNUSUAL MOVE</strong> — Something's going on: the stock moved a lot in 24 hours, or its RSI is in an extreme zone (below 30 = oversold, above 70 = overbought). Not necessarily good or bad—just something worth noticing before you decide.
      </p>
    </div>
  );

  return (
    <div className="tab-scanner" style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16, position: "relative" }}>
      <div ref={infoRef} style={{ position: "relative" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 16, letterSpacing: "0.12em", color: "#999", fontWeight: 600, fontFamily: "var(--mono)", marginBottom: 24 }}>
              SCANNER
            </div>
            <p style={{ fontSize: 15, color: "#888", fontFamily: "var(--mono)", marginBottom: 12 }}>
              Discovery beyond your portfolio — ARIA surfaces opportunities worth watching. Not financial advice.
            </p>
          </div>
          <button
            onClick={() => setInfoOpen((o) => !o)}
            style={{
              flexShrink: 0, width: 24, height: 24, borderRadius: "50%",
              border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.04)",
              color: "#888", fontSize: 18, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
            title="How signals are determined"
          >
            ⓘ
          </button>
        </div>
        {infoOpen && (
          <div
            className="info-tooltip"
            style={{
              position: "absolute", top: 0, right: 0, zIndex: 20,
              background: "#141414", border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
              <button onClick={() => setInfoOpen(false)} style={{ background: "none", border: "none", color: "#888", fontSize: 18, cursor: "pointer", padding: 4, lineHeight: 1 }} aria-label="Close">×</button>
            </div>
            {metricsExplainer}
          </div>
        )}
      </div>

      {/* Header row */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <span style={{ fontSize: 15, color: "#888", fontFamily: "var(--mono)" }}>
          {status ? `${status.universeSize} active · ${status.pendingCount ?? 0} in pipeline` : "Loading…"}
          {status?.lastScan ? ` · ${formatLastScan(status.lastScan)}` : ""}
        </span>
        <button
          onClick={runScan}
          disabled={scanning || status?.scanning}
          style={{
            fontSize: 15, fontFamily: "var(--mono)", padding: "5px 12px", borderRadius: 16,
            border: "1px solid rgba(0,255,148,0.4)",
            background: scanning || status?.scanning ? "rgba(0,255,148,0.1)" : "transparent",
            color: "#00ff94", cursor: scanning || status?.scanning ? "wait" : "pointer",
          }}
        >
          {(scanning || status?.scanning) ? (
            <>
              <span style={{ display: "inline-block", width: 10, height: 10, border: "2px solid rgba(0,255,148,0.3)", borderTopColor: "#00ff94", borderRadius: "50%", animation: "spin 0.7s linear infinite", marginRight: 6, verticalAlign: "middle" }} />
              Scanning…
            </>
          ) : "Scan Now"}
        </button>
        <div className="scanner-filter-pills" style={{ display: "flex", gap: 4 }}>
          {(["ALL", "STRONG BUY", "BUY", "UNUSUAL MOVE"] as FilterPill[]).map((p) => (
            <button
              key={p}
              onClick={() => setFilter(p)}
              style={{
                fontSize: 14, fontFamily: "var(--mono)", padding: "3px 10px", borderRadius: 12,
                border: `1px solid ${filter === p ? "rgba(0,255,148,0.5)" : "rgba(255,255,255,0.1)"}`,
                background: filter === p ? "rgba(0,255,148,0.08)" : "transparent",
                color: filter === p ? "#00ff94" : "#888", cursor: "pointer",
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {apiLimitReached && (
        <div style={{ padding: "10px 14px", background: "rgba(255,212,42,0.1)", border: "1px solid rgba(255,212,42,0.3)", borderRadius: 8, fontSize: 16, color: "#ffd32a", fontFamily: "var(--mono)" }}>
          API limit reached for today. Full indicators available for {status?.tickersScanned ?? 0} tickers. Remaining tickers show price data only.
        </div>
      )}

      {error && (
        <div style={{ padding: "10px 14px", background: "rgba(255,71,87,0.1)", border: "1px solid rgba(255,71,87,0.3)", borderRadius: 8, fontSize: 16, color: "#ff6b6b", fontFamily: "var(--mono)" }}>
          {error}
        </div>
      )}

      {results.length === 0 && !status?.scanning && (
        <div style={{ padding: 32, textAlign: "center", color: "#777", fontSize: 17, fontFamily: "var(--body)", background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(255,255,255,0.08)", borderRadius: 12 }}>
          ARIA hasn&apos;t scanned the market yet.
          <br />
          Click &quot;Scan Now&quot; to discover opportunities, or wait for the 7:30am automated scan.
        </div>
      )}

      {topPicks.length > 0 && (
        <>
          <div style={{ fontSize: 15, letterSpacing: "0.1em", color: "#00ff94", fontFamily: "var(--mono)", marginTop: 8 }}>
            ARIA&apos;S TOP PICKS TODAY
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {filterResults(topPicks, filter).map((r) => (
              <div
                key={r.id}
                className="scanner-card"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "14px 16px" }}
              >
                <div style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontFamily: "var(--display)", fontWeight: 700, color: "#f0f0f0" }}>{r.symbol}</span>
                      <span style={{ fontSize: 13, fontFamily: "var(--mono)", padding: "2px 6px", borderRadius: 4, background: "rgba(0,255,148,0.12)", color: "#00ff94" }}>
                        {(r.category ?? "large_cap").replace("_", " ").toUpperCase()}
                      </span>
                      <span style={{ fontSize: 15, fontFamily: "var(--mono)", padding: "2px 8px", borderRadius: 20, background: `${(signalColors[r.signal] ?? "#888")}18`, border: `1px solid ${(signalColors[r.signal] ?? "#888")}40`, color: signalColors[r.signal] ?? "#888" }}>
                        {r.signal}
                      </span>
                    </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 16, fontFamily: "var(--mono)", color: "#ccc" }}>
                      ${Number(r.price).toLocaleString()}
                      {r.change_24h != null && (
                        <span style={{ color: r.change_24h >= 0 ? "#00ff94" : "#ff4757", marginLeft: 6 }}>
                          {r.change_24h >= 0 ? "+" : ""}{r.change_24h.toFixed(1)}%
                        </span>
                      )}
                    </span>
                  </div>
                  </div>
                  <div style={{ fontSize: 14, color: "rgba(255,255,255,0.8)", fontFamily: "var(--body)", marginTop: 4 }}>{companyNames[r.symbol] ?? r.symbol}</div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 8, fontSize: 15, fontFamily: "var(--mono)" }}>
                  <span style={{ color: "#00ff94" }}>Score {r.score > 0 ? "+" : ""}{r.score}/6</span>
                  {r.rsi != null && <span style={{ color: r.rsi > 70 ? "#ff4757" : r.rsi < 30 ? "#00ff94" : "#888" }}>RSI {r.rsi.toFixed(0)}</span>}
                  {r.macd_histogram != null && <span style={{ color: r.macd_histogram > 0 ? "#00ff94" : "#ff4757" }}>MACD {r.macd_histogram > 0 ? "↑ bullish" : "↓ bearish"}</span>}
                </div>
                <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, marginBottom: 10, overflow: "hidden" }}>
                  <div style={{ width: `${((r.score + 6) / 12) * 100}%`, height: "100%", background: r.score >= 0 ? "linear-gradient(90deg, #00ff94, #00d4aa)" : "linear-gradient(90deg, #ff4757, #ff6b81)", transition: "width 0.3s" }} />
                </div>
                <div style={{ fontSize: 16, color: "#aaa", lineHeight: 1.5, marginBottom: 12, fontFamily: "var(--body)" }}>
                  {r.aria_reasoning?.trim() || "Technical indicators only — no ARIA summary for this scan."}
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button
                    className="scanner-watchlist-btn"
                    onClick={() => addToWatchlist(r.symbol)}
                    disabled={addingTicker === r.symbol}
                    style={{
                      fontSize: isMobile ? 10 : 15, fontFamily: "var(--mono)",
                      padding: isMobile ? "5px 10px" : "5px 12px",
                      borderRadius: isMobile ? 6 : 8,
                      background: isMobile ? "rgba(255,255,255,0.05)" : "transparent",
                      border: isMobile ? "0.5px solid rgba(255,255,255,0.12)" : "1px solid rgba(0,255,148,0.4)",
                      color: isMobile ? "#777" : "#00ff94",
                      cursor: addingTicker === r.symbol ? "wait" : "pointer",
                    }}
                  >
                    {addingTicker === r.symbol ? "Adding…" : isMobile ? "+ watchlist" : "Add to Watchlist"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Pipeline section */}
      {pendingCandidates.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <button
            onClick={() => setPipelineOpen((o) => !o)}
            style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              padding: "10px 0", background: "none", border: "none",
              color: "#888", fontSize: 15, fontFamily: "var(--mono)",
              cursor: "pointer", textAlign: "left",
            }}
          >
            {pipelineOpen ? "▼" : "▶"} BUILDING DATA ({pendingCandidates.length} tickers)
          </button>
          {pipelineOpen && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
              {pendingCandidates.map((c) => {
                const pct = Math.min(100, (c.ohlcv_days / OHLCV_TARGET) * 100);
                const almostReady = c.ohlcv_days >= 45;
                return (
                  <div
                    key={c.symbol}
                    style={{
                      display: "flex", alignItems: "center", gap: 12, padding: "8px 12px",
                      background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
                      borderRadius: 8,
                    }}
                  >
                    <span style={{ fontFamily: "var(--mono)", fontWeight: 600, color: almostReady ? "#00ff94" : "#ccc", minWidth: 52, fontSize: 13 }}>
                      {c.symbol}
                    </span>
                    <span style={{ fontSize: 11, color: "#777", fontFamily: "var(--mono)", minWidth: 90 }}>
                      {c.category.replace("_", " ")}
                    </span>
                    <div style={{ flex: 1, height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: progressColor(c.ohlcv_days), borderRadius: 3, transition: "width 0.3s" }} />
                    </div>
                    <span style={{ fontSize: 11, color: "#888", fontFamily: "var(--mono)", minWidth: 44, textAlign: "right" }}>
                      {c.ohlcv_days}/{OHLCV_TARGET}
                    </span>
                    {almostReady && (
                      <span style={{ fontSize: 9, color: "#00ff94", fontFamily: "var(--mono)", letterSpacing: "0.06em" }}>
                        Almost!
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Full results accordion */}
      {results.length > 0 && (
        <div className="scanner-full-results" style={{ marginTop: 16 }}>
          <button
            onClick={() => setFullResultsOpen((o) => !o)}
            style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              padding: "10px 0", background: "none", border: "none",
              color: "#888", fontSize: 15, fontFamily: "var(--mono)",
              cursor: "pointer", textAlign: "left",
            }}
          >
            {fullResultsOpen ? "▼" : "▶"} All {results.length} results
          </button>
          {fullResultsOpen && (
            <>
            <div style={{ overflowX: "auto", marginTop: 8 }} className="scanner-full-results-table">
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 15, fontFamily: "var(--mono)" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.15)" }}>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: "#777" }}>Ticker</th>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: "#777" }}>Signal</th>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: "#777" }}>Score</th>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: "#777" }}>RSI</th>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: "#777" }}>Price</th>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: "#777" }}>24h</th>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: "#777" }}>Category</th>
                  </tr>
                </thead>
                <tbody>
                  {allFiltered.map((r) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                      <td style={{ padding: "6px 10px", color: "#ccc" }}>{r.symbol}</td>
                      <td style={{ padding: "6px 10px" }}>
                        <span style={{ padding: "2px 6px", borderRadius: 4, background: `${(signalColors[r.signal] ?? "#888")}18`, color: signalColors[r.signal] ?? "#888", fontSize: 14 }}>
                          {r.signal}
                        </span>
                      </td>
                      <td style={{ padding: "6px 10px", color: r.score >= 0 ? "#00ff94" : "#ff4757" }}>{r.score > 0 ? "+" : ""}{r.score}</td>
                      <td style={{ padding: "6px 10px", color: "#888" }}>{r.rsi != null ? r.rsi.toFixed(0) : "—"}</td>
                      <td style={{ padding: "6px 10px", color: "#888" }}>${Number(r.price).toLocaleString()}</td>
                      <td style={{ padding: "6px 10px", color: r.change_24h != null ? (r.change_24h >= 0 ? "#00ff94" : "#ff4757") : "#888" }}>
                        {r.change_24h != null ? `${r.change_24h >= 0 ? "+" : ""}${r.change_24h.toFixed(1)}%` : "—"}
                      </td>
                      <td style={{ padding: "6px 10px", color: "#888" }}>{(r.category ?? "").replace("_", " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="scanner-mobile-results" style={{ display: "none", marginTop: 8 }}>
              {allFiltered.map((r) => (
                <div key={r.id} className="scanner-result-row">
                  <span>{r.symbol}</span>
                  <span style={{ color: signalColors[r.signal] ?? "#888" }}>{r.signal}</span>
                  <span>{r.score > 0 ? "+" : ""}{r.score}</span>
                  <span>${Number(r.price).toLocaleString()}</span>
                  <span>{r.change_24h != null ? `${r.change_24h >= 0 ? "+" : ""}${r.change_24h.toFixed(1)}%` : "—"}</span>
                </div>
              ))}
            </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
