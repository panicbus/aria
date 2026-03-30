/**
 * Live data fetchers: Robinhood (crypto primary), CoinGecko (crypto fallback), Finnhub (stocks), Hacker News.
 * Phase 6a: BTC and ETH use Robinhood first, CoinGecko as silent fallback.
 */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

import { fetchCryptoPrice as fetchRobinhoodPrice } from "./robinhood";
import { generateText } from "./gemini";

const HN_TOP = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_ITEM = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

const CRYPTO_SYMBOLS = ["BTC", "ETH"] as const;

export type LiveDataDeps = {
  db: import("sql.js").Database | null;
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
  saveDb: () => void;
  getWatchedTickers: () => string[];
  cryptoIds: Record<string, string>;
  coingeckoIdToSymbol: Record<string, string>;
};

export function createLiveDataFetchers(deps: LiveDataDeps) {
  const { db, execAll, saveDb, getWatchedTickers, cryptoIds, coingeckoIdToSymbol } = deps;

  async function fetchCoinGeckoPriceForSymbol(symbol: string): Promise<{ price: number; change_24h: number | null } | null> {
    const id = cryptoIds[symbol];
    if (!id) return null;
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`;
    try {
      const res = await fetch(url);
      const data = (await res.json()) as Record<string, { usd: number; usd_24h_change?: number }>;
      const v = data[id];
      if (!v?.usd) return null;
      return { price: v.usd, change_24h: v.usd_24h_change ?? null };
    } catch (e) {
      console.warn(`CoinGecko ${symbol} fetch error:`, e);
      return null;
    }
  }

  function getPrevPrice(symbol: string): { price: number; change_24h: number | null } | null {
    if (!db) return null;
    const safe = symbol.replace(/'/g, "''");
    const rows = execAll<{ price: number; change_24h: number | null }>(
      `SELECT price, change_24h FROM prices WHERE symbol = '${safe}' LIMIT 1`
    );
    const r = rows[0];
    if (!r?.price) return null;
    return { price: r.price, change_24h: r.change_24h };
  }

  async function fetchCryptoPrices(): Promise<void> {
    if (!db) return;
    const tickers = getWatchedTickers();
    const crypto = tickers.filter((s) => CRYPTO_SYMBOLS.includes(s as any));
    if (crypto.length === 0) return;

    const now = new Date().toISOString();
    for (const symbol of crypto) {
      let price: number | null = null;
      let change24h: number | null = null;
      let source = "coingecko_fallback";

      price = await fetchRobinhoodPrice(symbol);
      if (price != null) {
        source = "robinhood";
        const prev = getPrevPrice(symbol);
        change24h = prev?.price ? ((price - prev.price) / prev.price) * 100 : null;
      } else {
        console.warn(`Robinhood price unavailable for ${symbol}, falling back to CoinGecko`);
        const fallback = await fetchCoinGeckoPriceForSymbol(symbol);
        if (fallback) {
          price = fallback.price;
          change24h = fallback.change_24h;
        }
      }

      if (price != null && !isNaN(price)) {
        db.run(
          "INSERT OR REPLACE INTO prices (symbol, price, change_24h, source, updated_at) VALUES (:symbol, :price, :change_24h, :source, :updated_at)",
          { ":symbol": symbol, ":price": price, ":change_24h": change24h, ":source": source, ":updated_at": now } as any
        );
      }
    }
    saveDb();
  }

  async function fetchCoinGecko(): Promise<void> {
    if (!db) return;
    const tickers = getWatchedTickers();
    const crypto = tickers.filter((s) => s in cryptoIds);
    if (crypto.length === 0) return;
    const ids = crypto.map((s) => cryptoIds[s]).filter(Boolean).join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
    try {
      const res = await fetch(url);
      const data = (await res.json()) as Record<string, { usd: number; usd_24h_change?: number }>;
      const now = new Date().toISOString();
      for (const [id, v] of Object.entries(data)) {
        const symbol = coingeckoIdToSymbol[id] ?? id.toUpperCase();
        const price = v.usd;
        const change = v.usd_24h_change ?? null;
        db.run(
          "INSERT OR REPLACE INTO prices (symbol, price, change_24h, source, updated_at) VALUES (:symbol, :price, :change_24h, :source, :updated_at)",
          { ":symbol": symbol, ":price": price, ":change_24h": change, ":source": "coingecko", ":updated_at": now } as any
        );
      }
      saveDb();
    } catch (e) {
      console.error("CoinGecko fetch error:", e);
    }
  }

  async function fetchStocks(): Promise<void> {
    if (!db) return;
    const key = process.env.FINNHUB_API_KEY?.trim();
    if (!key) {
      console.warn("Stocks: Add FINNHUB_API_KEY to .env (free at finnhub.io).");
      return;
    }
    const finnhubQuote = (symbol: string) =>
      `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${key}`;
    const symbols = getWatchedTickers().filter((s) => s !== "BTC" && s !== "ETH");
    const now = new Date().toISOString();
    for (const symbol of symbols) {
      try {
        const res = await fetch(finnhubQuote(symbol));
        const text = await res.text();
        if (!res.ok) {
          console.warn(`Finnhub ${symbol}: ${res.status} ${text.slice(0, 80)}`);
          continue;
        }
        const data = JSON.parse(text) as { c?: number; dp?: number };
        const price = data?.c;
        if (price == null || typeof price !== "number") continue;
        const pct = typeof data?.dp === "number" ? data.dp : null;
        db.run(
          "INSERT OR REPLACE INTO prices (symbol, price, change_24h, source, updated_at) VALUES (:symbol, :price, :change_24h, :source, :updated_at)",
          { ":symbol": symbol, ":price": price, ":change_24h": pct, ":source": "finnhub", ":updated_at": now }
        );
      } catch (e) {
        console.warn(`Finnhub ${symbol} fetch error:`, e);
      }
    }
    saveDb();
  }

  function summaryFromText(text: string | undefined): string | null {
    if (!text || typeof text !== "string") return null;
    const stripped = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const words = stripped.split(/\s+/).filter(Boolean).slice(0, 20);
    if (words.length === 0) return null;
    const out = words.join(" ");
    return out.length > 0 ? out + (words.length >= 20 ? "…" : "") : null;
  }

  function truncateSummary(s: string, maxWords = 20): string {
    const decoded = s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const words = decoded.trim().split(/\s+/).filter(Boolean).slice(0, maxWords);
    if (words.length === 0) return "";
    const out = words.join(" ");
    return out + (words.length >= maxWords ? "…" : "");
  }

  async function fetchArticleSummary(url: string, title: string): Promise<string | null> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ARIA/1.0; +https://github.com)" },
        redirect: "follow",
      });
      clearTimeout(t);
      if (!res.ok) return null;
      const html = await res.text();

      // 1. Try meta description first (fast, no AI cost)
      const ogMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i)
        ?? html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:description["']/i);
      if (ogMatch?.[1]) return truncateSummary(ogMatch[1]);
      const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
        ?? html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i);
      if (descMatch?.[1]) return truncateSummary(descMatch[1]);

      // 2. Scrape article body with Readability, then AI summarize (optional, uses quota)
      if (!process.env.GEMINI_API_KEY?.trim()) return null;
      if (process.env.ENABLE_AI_NEWS_SUMMARIES === "false") return null;
      const dom = new JSDOM(html, { url: res.url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      const text = article?.textContent?.replace(/\s+/g, " ").trim();
      if (!text || text.length < 100) return null;

      const excerpt = text.slice(0, 2000);
      const prompt = `Summarize this article in 1-2 sentences (max 25 words). Be concise.

Title: ${title}

Article excerpt:
${excerpt}

Summary (25 words max):`;

      const summary = (await generateText(prompt)).trim();
      if (!summary) return null;
      return truncateSummary(summary, 25);
    } catch {
      return null;
    }
  }

  async function fetchHN(): Promise<void> {
    if (!db) return;
    try {
      const ids = (await (await fetch(HN_TOP)).json()) as number[];
      const top = ids.slice(0, 10);
      const items: { id: number; title: string; url: string | null; text?: string }[] = [];
      for (const id of top) {
        const item = (await (await fetch(HN_ITEM(id))).json()) as { title?: string; url?: string; text?: string } | null;
        if (!item?.title) continue;
        items.push({
          id,
          title: String(item.title).slice(0, 200),
          url: item.url ?? null,
          text: item.text,
        });
      }
      const now = new Date().toISOString();
      const needSummary = items.filter((i) => !summaryFromText(i.text) && i.url?.startsWith("http"));
      // Skip articles we already have a summary for (avoids re-calling Gemini every 15 min)
      const existing = execAll<{ id: number; summary: string }>("SELECT id, summary FROM news WHERE summary IS NOT NULL AND summary != ''");
      const hasSummary = new Set(existing.filter((r) => r.summary?.trim()).map((r) => r.id));
      const toFetch = needSummary.filter((i) => !hasSummary.has(i.id));
      // Cap AI calls: max 3 per fetch to stay under free tier (~250–500 RPD)
      const maxAI = parseInt(process.env.AI_NEWS_SUMMARIES_PER_FETCH || "3", 10) || 3;
      const capped = toFetch.slice(0, Math.max(0, maxAI));
      const summaryResults = await Promise.allSettled(
        capped.map((i) => fetchArticleSummary(i.url!, i.title))
      );
      const summaryByIndex = new Map(capped.map((_, idx) => [capped[idx].id, summaryResults[idx]]));
      const existingById = new Map(existing.map((r) => [r.id, r.summary]));
      for (const i of items) {
        let summary = summaryFromText(i.text);
        if (!summary) summary = existingById.get(i.id) ?? null;
        if (!summary) {
          const res = summaryByIndex.get(i.id);
          if (res?.status === "fulfilled" && res.value) summary = res.value;
        }
        db.run(
          `INSERT INTO news (id, title, url, source, created_at, summary) VALUES (:id, :title, :url, :source, :created_at, :summary)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, url = excluded.url, summary = excluded.summary`,
          { ":id": i.id, ":title": i.title, ":url": i.url, ":source": "hackernews", ":created_at": now, ":summary": summary }
        );
      }
      saveDb();
    } catch (e) {
      console.error("HN fetch error:", e);
    }
  }

  // WAYPOINT [vix-fetch]
  // WHAT: Fetches CBOE VIX (volatility index) from Yahoo Finance.
  // WHY: Finnhub free tier doesn't support index symbols. VIX is a key market health indicator.
  // HOW IT HELPS NICO: At-a-glance market fear gauge in the sidebar.
  async function fetchVIX(): Promise<void> {
    if (!db) return;
    try {
      const url = "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX";
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ARIA/1.0)" },
      });
      if (!res.ok) {
        console.warn(`VIX fetch: ${res.status}`);
        return;
      }
      const data = (await res.json()) as {
        chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number } }> };
      };
      const meta = data?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const prevClose = meta?.previousClose;
      if (price == null || typeof price !== "number") return;
      const change24h = prevClose ? ((price - prevClose) / prevClose) * 100 : null;
      const now = new Date().toISOString();
      db.run(
        "INSERT OR REPLACE INTO prices (symbol, price, change_24h, source, updated_at) VALUES (:symbol, :price, :change_24h, :source, :updated_at)",
        { ":symbol": "VIX", ":price": price, ":change_24h": change24h, ":source": "yahoo", ":updated_at": now } as any
      );
      saveDb();
    } catch (e) {
      console.warn("VIX fetch error:", e);
    }
  }

  // WAYPOINT [stock-news-tickers]
  // WHAT: Builds a focused list of tickers for Finnhub company-news.
  // WHY: Only fetch news for tickers Nico actually cares about — holdings + top scanner picks + market indices.
  // HOW IT HELPS NICO: Relevant financial headlines without noise from 65 universe tickers.
  function getStockNewsTickers(): string[] {
    const tickers = new Set<string>();

    const positions = execAll<{ key: string; value: string }>(
      "SELECT key, value FROM memories WHERE key LIKE 'position_%'"
    );
    for (const row of positions) {
      try {
        const pos = JSON.parse(row.value) as { ticker?: string };
        if (pos?.ticker) tickers.add(pos.ticker.toUpperCase());
      } catch {}
    }

    const picks = execAll<{ symbol: string }>(
      `SELECT symbol FROM scanner_results
       WHERE aria_reasoning IS NOT NULL AND scanned_at >= datetime('now', '-2 days')
       ORDER BY score DESC LIMIT 5`
    );
    for (const p of picks) tickers.add(p.symbol);

    tickers.add("SPY");
    tickers.add("QQQ");

    // Finnhub company-news doesn't cover crypto
    tickers.delete("BTC");
    tickers.delete("ETH");

    return Array.from(tickers).slice(0, 12);
  }

  // WAYPOINT [stock-news-fetch]
  // WHAT: Fetches financial news from Finnhub for holdings and top scanner picks.
  // WHY: Keeps Nico informed about news driving price movements in relevant stocks.
  // HOW IT HELPS NICO: Understand WHY a stock is moving before acting on a signal.
  async function fetchStockNews(): Promise<void> {
    if (!db) return;
    const key = process.env.FINNHUB_API_KEY?.trim();
    if (!key) {
      console.warn("Stock news: no FINNHUB_API_KEY");
      return;
    }

    const tickers = getStockNewsTickers();
    const now = Date.now();
    const fromDate = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const toDate = new Date(now).toISOString().split("T")[0];
    let inserted = 0;

    for (const ticker of tickers) {
      try {
        const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${fromDate}&to=${toDate}&token=${key}`;
        const res = await fetch(url);
        if (!res.ok) {
          console.warn(`Stock news ${ticker}: ${res.status}`);
          continue;
        }

        const articles = (await res.json()) as Array<{
          headline: string; url: string; summary: string; source: string; datetime: number;
        }>;
        if (!Array.isArray(articles)) continue;

        const recent = articles.sort((a, b) => b.datetime - a.datetime).slice(0, 5);

        for (const a of recent) {
          if (!a.headline || !a.url) continue;
          try {
            db.run(
              `INSERT OR IGNORE INTO stock_news (ticker, title, url, summary, source, published_at)
               VALUES (:ticker, :title, :url, :summary, :source, :published_at)`,
              {
                ":ticker": ticker,
                ":title": a.headline.slice(0, 250),
                ":url": a.url,
                ":summary": a.summary?.slice(0, 400) || null,
                ":source": a.source || "finnhub",
                ":published_at": new Date(a.datetime * 1000).toISOString(),
              } as any
            );
            inserted++;
          } catch {}
        }
        saveDb();
      } catch (e) {
        console.warn(`Stock news ${ticker} error:`, e);
      }

      await new Promise((r) => setTimeout(r, 300));
    }

    // Prune old + cap at 200
    db.run("DELETE FROM stock_news WHERE published_at < datetime('now', '-5 days')");
    db.run(
      "DELETE FROM stock_news WHERE id NOT IN (SELECT id FROM stock_news ORDER BY published_at DESC LIMIT 200)"
    );
    saveDb();
    console.log(`Stock news: ${tickers.length} tickers, ${inserted} new articles`);
  }

  return { fetchCoinGecko, fetchCryptoPrices, fetchStocks, fetchHN, fetchVIX, fetchStockNews };
}
