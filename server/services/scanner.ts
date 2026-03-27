// WAYPOINT [scanner]
// WHAT: Proactive market scanner — scans a risk-based universe beyond Nico's holdings, runs RSI/MACD/MA signals, then ARIA filters to 3-7 top picks.
// WHY: Discovery, not noise. Surfaces opportunities Nico didn't know to look for.
// HOW IT HELPS NICO: "Worth watching" candidates outside his portfolio, ranked by technicals and ARIA reasoning.

import { computeIndicatorsForCloses, scoreToSignal } from "./indicators";
import { generateText } from "./gemini";
import { fetchOHLCVForTicker } from "./ohlcv";

// ── Universe by risk tolerance ─────────────────────────────────────────────────
const UNIVERSE_CONSERVATIVE: Array<[string, "large_cap"]> = [
  ["AAPL", "large_cap"], ["MSFT", "large_cap"], ["GOOGL", "large_cap"], ["AMZN", "large_cap"], ["META", "large_cap"],
  ["BRK.B", "large_cap"], ["JNJ", "large_cap"], ["V", "large_cap"], ["PG", "large_cap"], ["JPM", "large_cap"],
  ["UNH", "large_cap"], ["HD", "large_cap"], ["MA", "large_cap"], ["ABBV", "large_cap"], ["MRK", "large_cap"],
  ["LLY", "large_cap"], ["PEP", "large_cap"], ["KO", "large_cap"], ["WMT", "large_cap"], ["XOM", "large_cap"],
];

const UNIVERSE_GROWTH: Array<[string, "growth"]> = [
  ["NVDA", "growth"], ["TSLA", "growth"], ["AMD", "growth"], ["CRM", "growth"], ["ADBE", "growth"],
  ["NOW", "growth"], ["PANW", "growth"], ["SNOW", "growth"], ["COIN", "growth"], ["PLTR", "growth"],
  ["NET", "growth"], ["DDOG", "growth"], ["MDB", "growth"], ["UBER", "growth"], ["ABNB", "growth"],
];

const UNIVERSE_SMALL_CAP: Array<[string, "small_cap"]> = [
  ["SMCI", "small_cap"], ["IONQ", "small_cap"], ["RXRX", "small_cap"], ["RKLB", "small_cap"], ["ACHR", "small_cap"],
  ["JOBY", "small_cap"], ["LUNR", "small_cap"], ["ASTS", "small_cap"], ["RDDT", "small_cap"], ["HOOD", "small_cap"],
  ["SOFI", "small_cap"], ["AFRM", "small_cap"], ["UPST", "small_cap"], ["OPEN", "small_cap"], ["CAVA", "small_cap"],
];

const ALPHAVANTAGE_DAILY_LIMIT = 25;
const OHLCV_MIN_DAYS = 50;

type ScannerDeps = {
  db: import("sql.js").Database;
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
  run: (sql: string, params?: Record<string, string | number | null | undefined>) => { lastInsertRowid: number };
  saveDb: () => void;
  getWatchedTickers: () => string[];
  cryptoIds?: Record<string, string>;
};

function getAlphavantageCallsToday(execAll: ScannerDeps["execAll"]): number {
  const rows = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'alphavantage_calls_today' LIMIT 1");
  if (!rows[0]?.value) return 0;
  try {
    const parsed = JSON.parse(rows[0].value) as { date: string; count: number };
    const today = new Date().toISOString().slice(0, 10);
    if (parsed.date === today) return parsed.count;
  } catch (_) {}
  return 0;
}

function incrementAlphavantageCalls(execAll: ScannerDeps["execAll"], run: ScannerDeps["run"], saveDb: () => void): void {
  const today = new Date().toISOString().slice(0, 10);
  const current = getAlphavantageCallsToday(execAll);
  const next = current + 1;
  run(
    `INSERT INTO memories (key, value, confidence, source, updated_at, created_at) VALUES ('alphavantage_calls_today', :value, 1, 'explicit', :updated_at, :created_at)
     ON CONFLICT(key) DO UPDATE SET value = :value, updated_at = :updated_at`,
    {
      ":value": JSON.stringify({ date: today, count: next }),
      ":updated_at": new Date().toISOString(),
      ":created_at": new Date().toISOString(),
    }
  );
  saveDb();
}

async function fetchPriceFromFinnhub(symbol: string): Promise<{ price: number; change_24h: number | null } | null> {
  const key = process.env.FINNHUB_API_KEY?.trim();
  if (!key) return null;
  try {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${key}`);
    const data = (await res.json()) as { c?: number; dp?: number };
    const price = data?.c;
    if (price == null || typeof price !== "number") return null;
    const pct = typeof data?.dp === "number" ? data.dp : null;
    return { price, change_24h: pct };
  } catch (_) {
    return null;
  }
}

export type ScannerUniverseEntry = { symbol: string; category: "large_cap" | "growth" | "small_cap" };

export function createScannerService(deps: ScannerDeps) {
  const { db, execAll, run, saveDb, getWatchedTickers, cryptoIds } = deps;

  function getRiskTolerance(): "conservative" | "moderate" | "aggressive" {
    const rows = execAll<{ value: string }>("SELECT value FROM memories WHERE key = 'risk_tolerance' LIMIT 1");
    const val = (rows[0]?.value ?? "").trim().toLowerCase();
    if (val === "conservative" || val === "aggressive") return val;
    return "moderate";
  }

  function getExcludedTickers(): Set<string> {
    const watched = getWatchedTickers();
    return new Set(watched.map((t) => t.toUpperCase()));
  }

  function buildUniverse(): ScannerUniverseEntry[] {
    const risk = getRiskTolerance();
    const exclude = getExcludedTickers();
    const out: ScannerUniverseEntry[] = [];
    for (const [sym, cat] of UNIVERSE_CONSERVATIVE) {
      if (!exclude.has(sym)) out.push({ symbol: sym, category: cat });
    }
    if (risk === "moderate" || risk === "aggressive") {
      for (const [sym, cat] of UNIVERSE_GROWTH) {
        if (!exclude.has(sym)) out.push({ symbol: sym, category: cat });
      }
    }
    if (risk === "aggressive") {
      for (const [sym, cat] of UNIVERSE_SMALL_CAP) {
        if (!exclude.has(sym)) out.push({ symbol: sym, category: cat });
      }
    }
    return out;
  }

  function syncUniverseToDb(universe: ScannerUniverseEntry[]): void {
    run("DELETE FROM scanner_universe");
    for (const u of universe) {
      run(
        "INSERT INTO scanner_universe (symbol, category, active) VALUES (:symbol, :category, 1)",
        { ":symbol": u.symbol, ":category": u.category }
      );
    }
    saveDb();
  }

  async function getActiveUniverse(): Promise<ScannerUniverseEntry[]> {
    const universe = buildUniverse();
    syncUniverseToDb(universe);
    return universe;
  }

  let scanning = false;

  async function runScan(): Promise<void> {
    if (scanning) return;
    scanning = true;
    const today = new Date().toISOString().slice(0, 10);
    try {
      const universe = await getActiveUniverse();
      if (universe.length === 0) {
        scanning = false;
        return;
      }

      run("DELETE FROM scanner_results");
      saveDb();

      let avCalls = getAlphavantageCallsToday(execAll);
      const tickersNeedingOhlcv: string[] = [];

      for (const { symbol } of universe) {
        const ohlcvRows = execAll<{ date: string }>(
          `SELECT date FROM ohlcv WHERE symbol = '${symbol.replace(/'/g, "''")}' ORDER BY date DESC LIMIT 1`
        );
        const countRows = execAll<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM ohlcv WHERE symbol = '${symbol.replace(/'/g, "''")}'`
        );
        const count = countRows[0]?.cnt ?? 0;
        const latestDate = ohlcvRows[0]?.date ?? "";
        const hasEnough = count >= OHLCV_MIN_DAYS && latestDate >= today;
        if (!hasEnough) tickersNeedingOhlcv.push(symbol);
      }

      for (const symbol of tickersNeedingOhlcv) {
        if (avCalls >= ALPHAVANTAGE_DAILY_LIMIT) break;
        const isCrypto = cryptoIds && symbol in cryptoIds;
        if (isCrypto) continue;
        const result = await fetchOHLCVForTicker(symbol, { cryptoIds });
        if (result.rows.length) {
          const rowSource = result.source ?? "alphavantage";
          for (const r of result.rows) {
            db.run(
              `INSERT OR IGNORE INTO ohlcv (symbol, date, open, high, low, close, volume, source, created_at)
               VALUES (:symbol, :date, :open, :high, :low, :close, :volume, :source, :created_at)`,
              {
                ":symbol": r.symbol,
                ":date": r.date,
                ":open": r.open,
                ":high": r.high,
                ":low": r.low,
                ":close": r.close,
                ":volume": r.volume,
                ":source": rowSource,
                ":created_at": new Date().toISOString(),
              }
            );
          }
          if (rowSource === "alphavantage") {
            incrementAlphavantageCalls(execAll, run, saveDb);
            avCalls++;
            await new Promise((r) => setTimeout(r, 13000));
          }
        }
      }

      for (const { symbol, category } of universe) {
        const priceData = await fetchPriceFromFinnhub(symbol);
        const price = priceData?.price ?? 0;
        const change_24h = priceData?.change_24h ?? null;

        const ohlcvRows = execAll<{ close: number }>(
          `SELECT close FROM ohlcv WHERE symbol = '${symbol.replace(/'/g, "''")}' ORDER BY date ASC`
        );
        const closes = ohlcvRows.map((r) => Number(r.close));

        let signal: string;
        let score: number;
        let rsi: number | null = null;
        let macdHistogram: number | null = null;
        let indicatorData: Record<string, unknown> | null = null;

        const ind = computeIndicatorsForCloses(closes);
        if (ind && closes.length >= OHLCV_MIN_DAYS) {
          const res = scoreToSignal(ind.score);
          signal = res.signal;
          score = ind.score;
          rsi = ind.rsi;
          macdHistogram = ind.macd.histogram;
          indicatorData = ind as unknown as Record<string, unknown>;
        } else {
          const change = change_24h ?? 0;
          if (change >= 5) signal = "WATCH";
          else if (change <= -5) signal = "WATCH";
          else if (change >= 2) signal = "BUY";
          else if (change <= -2) signal = "SELL";
          else signal = "HOLD";
          score = 0;
          indicatorData = { methodology: "24h_fallback", rsi: null, macd: null, ma20: null, ma50: null, score: 0 };
        }

        run(
          `INSERT INTO scanner_results (symbol, signal, score, rsi, macd_histogram, price, change_24h, indicator_data, category) 
           VALUES (:symbol, :signal, :score, :rsi, :macd_histogram, :price, :change_24h, :indicator_data, :category)`,
          {
            ":symbol": symbol,
            ":signal": signal,
            ":score": score,
            ":rsi": rsi,
            ":macd_histogram": macdHistogram,
            ":price": price,
            ":change_24h": change_24h,
            ":indicator_data": indicatorData ? JSON.stringify(indicatorData) : null,
            ":category": category,
          }
        );
      }
      saveDb();

      await filterWithAria();
    } finally {
      scanning = false;
    }
  }

  async function filterWithAria(): Promise<void> {
    const risk = getRiskTolerance();
    const rows = execAll<{
      id: number;
      symbol: string;
      signal: string;
      score: number;
      rsi: number | null;
      macd_histogram: number | null;
      price: number;
      change_24h: number | null;
      category: string;
    }>("SELECT id, symbol, signal, score, rsi, macd_histogram, price, change_24h, category FROM scanner_results ORDER BY score DESC");

    if (rows.length === 0) return;
    if (!process.env.GEMINI_API_KEY?.trim()) return;

    const summary = rows
      .map(
        (r) =>
          `${r.symbol} (${r.category}): ${r.signal} score ${r.score}/6, RSI ${r.rsi ?? "n/a"}, MACD ${r.macd_histogram != null ? (r.macd_histogram > 0 ? "bullish" : "bearish") : "n/a"}, price $${r.price}, 24h ${r.change_24h != null ? r.change_24h.toFixed(1) + "%" : "n/a"}`
      )
      .join("\n");

    const prompt = `Here are today's scanner results across ${rows.length} stocks. Nico's risk tolerance is ${risk}.

Surface the 3-7 most genuinely interesting opportunities. Consider: signal strength, unusual RSI readings, MACD crossovers, and anything that stands out as worth attention.

Prioritize variety across categories — do not return more than 2 picks from the same category (large_cap, growth, small_cap). If you have 3 strong large cap signals, pick the top 2 and find the best growth or small cap pick instead. A varied set of picks is more useful than 5 picks from the same category.

For each pick, write 2-3 sentences of plain English reasoning explaining WHY this is interesting right now.

Also flag any tickers showing unusual negative momentum that Nico should be aware of even if he doesn't own them.

Return ONLY a valid JSON array of objects with this exact shape:
[{"symbol":"TICKER","aria_reasoning":"2-3 sentences of reasoning"}]
No other text.`;

    try {
      const systemInstruction = "You are ARIA. Return only valid JSON. No markdown, no explanation.";
      const response = await generateText(`${prompt}\n\n---\n${summary}`, systemInstruction);
      const clean = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const jsonMatch = clean.match(/\[[\s\S]*\]/);
      const arr = jsonMatch ? (JSON.parse(jsonMatch[0]) as Array<{ symbol: string; aria_reasoning: string }>) : [];

      const bySymbol = new Map(arr.map((a) => [a.symbol.toUpperCase(), a.aria_reasoning ?? ""]));
      for (const r of rows) {
        const reasoning = bySymbol.get(r.symbol);
        if (reasoning) {
          db.run("UPDATE scanner_results SET aria_reasoning = :reasoning WHERE id = :id", {
            ":reasoning": reasoning,
            ":id": r.id,
          });
        }
      }
      saveDb();
    } catch (e) {
      console.warn("Scanner ARIA filter failed:", e);
    }
  }

  function getResults(): Array<{
    id: number;
    symbol: string;
    signal: string;
    score: number;
    rsi: number | null;
    macd_histogram: number | null;
    price: number;
    change_24h: number | null;
    indicator_data: string | null;
    aria_reasoning: string | null;
    category: string;
    scanned_at: string;
  }> {
    return execAll(
      "SELECT id, symbol, signal, score, rsi, macd_histogram, price, change_24h, indicator_data, aria_reasoning, category, scanned_at FROM scanner_results ORDER BY CASE WHEN aria_reasoning IS NOT NULL AND aria_reasoning != '' THEN 0 ELSE 1 END, score DESC"
    );
  }

  function getTopPicks(scoreMin = 3): Array<{
    symbol: string;
    signal: string;
    score: number;
    rsi: number | null;
    aria_reasoning: string | null;
    price: number;
    change_24h: number | null;
    category: string;
  }> {
    const rows = execAll<{
      symbol: string;
      signal: string;
      score: number;
      rsi: number | null;
      aria_reasoning: string | null;
      price: number;
      change_24h: number | null;
      category: string;
    }>(`SELECT symbol, signal, score, rsi, aria_reasoning, price, change_24h, category FROM scanner_results WHERE aria_reasoning IS NOT NULL AND aria_reasoning != '' AND score >= ${scoreMin} ORDER BY score DESC`);
    return rows;
  }

  function getStatus(): {
    lastScan: string | null;
    tickersScanned: number;
    scanning: boolean;
    apiCallsRemaining: number;
    universeSize: number;
  } {
    const last = execAll<{ scanned_at: string }>("SELECT scanned_at FROM scanner_results ORDER BY scanned_at DESC LIMIT 1");
    const count = execAll<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM scanner_results");
    const uni = execAll<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM scanner_universe WHERE active = 1");
    const avCalls = getAlphavantageCallsToday(execAll);
    return {
      lastScan: last[0]?.scanned_at ?? null,
      tickersScanned: count[0]?.cnt ?? 0,
      scanning,
      apiCallsRemaining: Math.max(0, ALPHAVANTAGE_DAILY_LIMIT - avCalls),
      universeSize: uni[0]?.cnt ?? 0,
    };
  }

  function triggerScan(): void {
    runScan().catch((e) => console.error("Scanner run failed:", e));
  }

  return {
    getActiveUniverse,
    runScan,
    triggerScan,
    getResults,
    getTopPicks,
    getStatus,
  };
}
