/**
 * Morning and evening briefings: fetch data, call Gemini, store, optionally email.
 */

import nodemailer from "nodemailer";
import { marked } from "marked";
import { generateText } from "./gemini";
type BriefingRow = { id: number; content: string; created_at: string; type: "morning" | "evening" };

type ExecAllFn = <T extends Record<string, unknown>>(sql: string) => T[];
type RunFn = (sql: string, params?: Record<string, string | number | null>) => { lastInsertRowid: number };

const BRIEFING_PRICE_SNAPSHOT_KEY = "briefing_portfolio_price_snapshot";
const CRYPTO_NEWS_SKIP = new Set(["BTC", "ETH", "BTC-USD", "ETH-USD"]);

type EquityPositionRow = { ticker: string; quantity: number; averageCost: number | null };
type HoldingEmailRow = {
  symbol: string;
  kind: "equity" | "crypto";
  quantity: number;
  avgCost: number | null;
  price: number;
  change24hPct: number | null;
  marketValue: number;
};

function parseEquityPositions(execAll: ExecAllFn): EquityPositionRow[] {
  const rows = execAll<{ key: string; value: string }>("SELECT key, value FROM memories WHERE key LIKE 'position_%'");
  const out: EquityPositionRow[] = [];
  for (const row of rows) {
    const fromKey = row.key.replace(/^position_/i, "").toUpperCase();
    if (!/^[A-Z0-9.]{1,6}$/.test(fromKey) || fromKey.includes("_")) continue;
    try {
      const p = JSON.parse(row.value) as { ticker?: string; quantity?: number; amount?: number; average_cost?: number; entry?: number };
      const ticker = (p.ticker ?? fromKey).toUpperCase();
      const quantity = typeof p.quantity === "number" ? p.quantity : typeof p.amount === "number" ? p.amount : NaN;
      if (!ticker || !(quantity > 0)) continue;
      const ac = p.average_cost ?? p.entry;
      const averageCost = typeof ac === "number" && ac > 0 ? ac : null;
      out.push({ ticker, quantity, averageCost });
    } catch {
      continue;
    }
  }
  return out;
}

function loadBriefingPriceSnapshot(execAll: ExecAllFn): Record<string, number> | null {
  const row = execAll<{ value: string }>(
    `SELECT value FROM memories WHERE key = '${BRIEFING_PRICE_SNAPSHOT_KEY.replace(/'/g, "''")}' LIMIT 1`
  );
  if (!row.length) return null;
  try {
    const j = JSON.parse(row[0].value) as { prices?: Record<string, number> };
    return j.prices && typeof j.prices === "object" ? j.prices : null;
  } catch {
    return null;
  }
}

function saveBriefingPriceSnapshot(run: RunFn, saveDb: () => void, prices: Record<string, number>): void {
  const now = new Date().toISOString();
  const payload = JSON.stringify({ prices, updated_at: now });
  run(
    `INSERT INTO memories (key, value, confidence, source, updated_at, created_at)
     VALUES (:key, :value, 1, 'system', :u, :c)
     ON CONFLICT(key) DO UPDATE SET value = :value, updated_at = :u`,
    { ":key": BRIEFING_PRICE_SNAPSHOT_KEY, ":value": payload, ":u": now, ":c": now }
  );
  saveDb();
}

function buildHoldingsForEmail(execAll: ExecAllFn, equityPositions: EquityPositionRow[]): HoldingEmailRow[] {
  const priceRows = execAll<{ symbol: string; price: number; change_24h: number | null }>(
    "SELECT symbol, price, change_24h FROM prices"
  );
  const priceMap = new Map(priceRows.map((r) => [r.symbol.toUpperCase(), r]));

  const holdings: HoldingEmailRow[] = [];

  for (const p of equityPositions) {
    const pr = priceMap.get(p.ticker);
    if (!pr) continue;
    const mv = p.quantity * pr.price;
    holdings.push({
      symbol: p.ticker,
      kind: "equity",
      quantity: p.quantity,
      avgCost: p.averageCost,
      price: pr.price,
      change24hPct: pr.change_24h,
      marketValue: mv,
    });
  }

  const cryptoRows = execAll<{
    symbol: string;
    quantity: number;
    average_buy_price: number;
    current_price: number;
    unrealized_pnl_pct: number;
    market_value: number;
  }>(`SELECT symbol, quantity, average_buy_price, current_price, unrealized_pnl_pct, market_value
       FROM crypto_portfolio ORDER BY market_value DESC`);

  for (const c of cryptoRows) {
    const sym = c.symbol.replace(/-USD$/i, "").toUpperCase();
    const pr = priceMap.get(sym) ?? { price: c.current_price, change_24h: null as number | null };
    const ch = pr.change_24h;
    holdings.push({
      symbol: sym,
      kind: "crypto",
      quantity: c.quantity,
      avgCost: c.average_buy_price > 0 ? c.average_buy_price : null,
      price: pr.price ?? c.current_price,
      change24hPct: ch,
      marketValue: c.market_value,
    });
  }

  return holdings;
}

function collectTickersForStockNews(execAll: ExecAllFn, getWatchedTickers: () => string[], equityPositions: EquityPositionRow[]): string[] {
  const set = new Set<string>();
  for (const p of equityPositions) if (!CRYPTO_NEWS_SKIP.has(p.ticker)) set.add(p.ticker);
  for (const t of getWatchedTickers()) {
    const u = t.toUpperCase().trim();
    if (u && !CRYPTO_NEWS_SKIP.has(u) && /^[A-Z][A-Z0-9.]{0,9}$/.test(u)) set.add(u);
  }
  const cryptoSyms = execAll<{ symbol: string }>("SELECT symbol FROM crypto_portfolio");
  for (const r of cryptoSyms) {
    const sym = r.symbol.replace(/-USD$/i, "").toUpperCase();
    if (!CRYPTO_NEWS_SKIP.has(sym) && /^[A-Z][A-Z0-9.]{0,9}$/.test(sym)) set.add(sym);
  }
  return Array.from(set).slice(0, 12);
}

type FinnhubArticle = { headline: string; url: string; summary: string; source: string; datetime: number };

async function fetchStockNewsForBriefing(tickers: string[], maxItems: number): Promise<Array<{ ticker: string; title: string; url: string; summary: string; source: string; publishedAt: string }>> {
  const key = process.env.FINNHUB_API_KEY?.trim();
  if (!key || tickers.length === 0 || maxItems <= 0) return [];

  const now = Date.now();
  const fromDate = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const toDate = new Date(now).toISOString().split("T")[0];
  const seenUrl = new Set<string>();
  const out: Array<{ ticker: string; title: string; url: string; summary: string; source: string; publishedAt: string }> = [];

  for (const ticker of tickers) {
    if (out.length >= maxItems) break;
    try {
      const u = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${fromDate}&to=${toDate}&token=${key}`;
      const res = await fetch(u);
      if (!res.ok) continue;
      const articles = (await res.json()) as FinnhubArticle[];
      if (!Array.isArray(articles)) continue;
      const recent = articles.sort((a, b) => b.datetime - a.datetime);
      for (const a of recent) {
        if (!a.headline || !a.url || seenUrl.has(a.url)) continue;
        seenUrl.add(a.url);
        out.push({
          ticker,
          title: a.headline.slice(0, 200),
          url: a.url,
          summary: (a.summary || "").slice(0, 220),
          source: a.source || "finnhub",
          publishedAt: new Date(a.datetime * 1000).toISOString(),
        });
        if (out.length >= maxItems) break;
      }
    } catch {
      /* skip ticker */
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return out.slice(0, maxItems);
}

function pctUnrealized(h: HoldingEmailRow): number | null {
  if (h.avgCost == null || h.avgCost <= 0) return null;
  return ((h.price - h.avgCost) / h.avgCost) * 100;
}

/** Insert HTML block immediately before the first &lt;h2&gt;Tech News&lt;/h2&gt; from markdown. */
function injectHtmlBeforeTechNewsHeading(html: string, block: string): string {
  if (!block.trim()) return html;
  const re = /<h2\b[^>]*>\s*Tech News\s*<\/h2>/i;
  if (re.test(html)) {
    return html.replace(re, `${block.trim()}\n$&`);
  }
  return `${html}\n${block}`;
}

/** Insert plain-text block before `## Tech News` in markdown (for text/plain part). */
function injectMarkdownBeforeTechNewsSection(markdown: string, block: string): string {
  if (!block.trim()) return markdown;
  const re = /(^|\n)(##\s+Tech News\s*\n)/im;
  if (re.test(markdown)) {
    return markdown.replace(re, (_m, pre, heading) => `${pre}${block.trim()}\n\n${heading}`);
  }
  return `${markdown}\n\n${block.trim()}\n`;
}

function buildStocksNewsSectionHtml(
  stockNews: Array<{ ticker: string; title: string; url: string; summary: string; source: string; publishedAt: string }>,
): string {
  const newsItems =
    stockNews.length === 0
      ? `<p style="color:#666;font-size:13px">No recent company headlines from Finnhub for your tickers.</p>`
      : `<ul style="margin:8px 0;padding-left:18px">${stockNews
          .map(
            (n) =>
              `<li style="margin:10px 0;line-height:1.4"><span style="font-size:11px;color:#666;font-family:ui-monospace,monospace">${escapeHtml(n.ticker)}</span> — <a href="${escapeHtmlAttr(n.url)}" style="color:#0066cc">${escapeHtml(n.title)}</a><br/><span style="font-size:12px;color:#555">${escapeHtml(n.summary || "")}</span><br/><span style="font-size:11px;color:#999">${escapeHtml(n.source)}</span></li>`,
          )
          .join("")}</ul>`;

  const divider = `<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0" />`;
  return `
<div style="margin-top:1.5em">
<h2 style="font-size:1.15em;border-bottom:1px solid #ddd;padding-bottom:6px;margin-top:0">Stocks News</h2>
${newsItems}
</div>${divider}`;
}

function buildStocksNewsPlainText(
  stockNews: Array<{ ticker: string; title: string; url: string }>,
): string {
  let t = "## Stocks News\n\n";
  if (!stockNews.length) t += "No recent company headlines from Finnhub for your tickers.\n";
  else for (const n of stockNews) t += `- [${n.ticker}] ${n.title} — ${n.url}\n`;
  return t;
}

function buildBriefingPortfolioPrependHtml(params: {
  holdings: HoldingEmailRow[];
  prevPrices: Record<string, number> | null;
}): string {
  const { holdings, prevPrices } = params;

  const ariaHeader = `
<div style="text-align:left;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #e5e5e5">
  <span style="display:inline-block;font-family:'Syne','Montserrat',sans-serif;font-size:26px;font-weight:800;letter-spacing:0.15em;color:#00d4aa;background:linear-gradient(135deg,#00ff94,#00d4aa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">ARIA</span>
</div>`;

  let sinceBriefingHtml = "";
  if (prevPrices && Object.keys(prevPrices).length > 0) {
    let totalDelta = 0;
    for (const h of holdings) {
      const prev = prevPrices[h.symbol];
      if (prev != null && prev > 0 && h.quantity > 0) {
        totalDelta += h.quantity * (h.price - prev);
      }
    }
    const sign = totalDelta >= 0 ? "+" : "";
    const color = totalDelta >= 0 ? "#16a34a" : "#dc2626";
    sinceBriefingHtml = `<p style="margin:8px 0 12px;font-size:13px;font-family:system-ui,sans-serif;color:#555">Estimated P/L since last briefing (from price snapshot): <strong style="color:${color}">${sign}$${Math.abs(totalDelta).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong> <span style="color:#888">(based on shares/crypto quantity × price change)</span></p>`;
  } else {
    sinceBriefingHtml = `<p style="margin:8px 0 12px;font-size:12px;color:#888;font-family:system-ui,sans-serif">First snapshot — dollar change since last briefing will appear after your next briefing.</p>`;
  }

  const rows =
    holdings.length === 0
      ? `<tr><td colspan="4" style="padding:10px;color:#666">No holdings synced — add positions in chat or connect crypto portfolio.</td></tr>`
      : holdings
          .map((h) => {
            const pctDay = h.change24hPct != null ? h.change24hPct : pctUnrealized(h);
            const pctStr = pctDay != null ? `${pctDay >= 0 ? "+" : ""}${pctDay.toFixed(2)}%` : "—";
            const pctColor = pctDay == null ? "#666" : pctDay >= 0 ? "#16a34a" : "#dc2626";
            const kind = h.kind === "crypto" ? "crypto" : "stock";
            return `<tr>
  <td style="padding:8px 6px;border-bottom:1px solid #eee;font-weight:600">${h.symbol} <span style="font-size:10px;color:#888;font-weight:400">${kind}</span></td>
  <td style="padding:8px 6px;border-bottom:1px solid #eee">$${h.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
  <td style="padding:8px 6px;border-bottom:1px solid #eee;color:${pctColor};font-weight:600">${pctStr}</td>
  <td style="padding:8px 6px;border-bottom:1px solid #eee;color:#444">${h.quantity.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
</tr>`;
          })
          .join("");

  const portfolioSection = `
<h2 style="font-size:1.15em;border-bottom:1px solid #ddd;padding-bottom:6px;margin-top:0">Your Portfolio Today</h2>
<h3 style="font-size:1em;color:#444;margin:10px 0 6px">Profit / Loss</h3>
${sinceBriefingHtml}
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px;font-family:system-ui,sans-serif">
<thead><tr>
<th style="text-align:left;padding:8px 6px;border-bottom:2px solid #ccc">Symbol</th>
<th style="text-align:left;padding:8px 6px;border-bottom:2px solid #ccc">Price</th>
<th style="text-align:left;padding:8px 6px;border-bottom:2px solid #ccc">Day / vs avg %</th>
<th style="text-align:left;padding:8px 6px;border-bottom:2px solid #ccc">Qty</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>
<p style="font-size:11px;color:#888;margin-bottom:20px">% column uses 24h change when available; otherwise vs average cost when recorded.</p>`;

  const divider = `<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0" />`;

  return `${ariaHeader}${portfolioSection}${divider}`;
}

function buildPortfolioTextPrefix(holdings: HoldingEmailRow[], prevPrices: Record<string, number> | null): string {
  let t = "ARIA\n\n=== Your Portfolio Today / Profit-Loss ===\n";
  if (!holdings.length) t += "No holdings.\n";
  else {
    for (const h of holdings) {
      const pct = h.change24hPct ?? pctUnrealized(h);
      t += `${h.symbol}: $${h.price.toFixed(2)}${pct != null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)` : ""} x ${h.quantity}\n`;
    }
  }
  if (prevPrices && Object.keys(prevPrices).length) {
    let d = 0;
    for (const h of holdings) {
      const pr = prevPrices[h.symbol];
      if (pr != null && pr > 0) d += h.quantity * (h.price - pr);
    }
    t += `Est. P/L since last briefing: $${d.toFixed(2)}\n`;
  }
  t += "\n---\n\n";
  return t;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeHtmlAttr(url: string): string {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return "#";
  return escapeHtml(u);
}

async function tavilySearch(query: string, maxResults = 5): Promise<Array<{ title: string; url: string; content: string }>> {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key) return [];
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, search_depth: "basic", max_results: maxResults }),
    });
    const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> };
    return res.ok ? (data.results ?? []) : [];
  } catch (_) {
    return [];
  }
}

async function sendBriefingEmail(
  content: string,
  subject: string,
  portfolioHtml?: string,
  stocksNewsHtml?: string,
  plainTextBody?: string,
): Promise<boolean> {
  const to = process.env.BRIEFING_EMAIL_TO?.trim();
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  if (!to || !host || !user || !pass) {
    const missing = [to ? null : "BRIEFING_EMAIL_TO", host ? null : "SMTP_HOST", user ? null : "SMTP_USER", pass ? null : "SMTP_PASS"].filter(Boolean);
    console.warn("Briefing email skipped: missing env vars:", missing.join(", "));
    return false;
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port: parseInt(process.env.SMTP_PORT ?? "587", 10),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user, pass },
    });
    let htmlBody = await Promise.resolve(marked.parse(content));
    if (stocksNewsHtml?.trim()) {
      htmlBody = injectHtmlBeforeTechNewsHeading(htmlBody, stocksNewsHtml);
    }
    const prefix = portfolioHtml ?? "";
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;800&family=Syne:wght@600;800&display=swap" rel="stylesheet">
<style>
body{font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#333;max-width:600px;margin:0 auto;padding:16px}
h1,h2,h3{color:#111;margin-top:1.2em;margin-bottom:0.5em}
h2{font-size:1.1em;border-bottom:1px solid #ddd;padding-bottom:4px}
ul,ol{margin:0.5em 0;padding-left:1.5em}
li{margin:0.25em 0}
strong{color:#000}
a{color:#0066cc}
</style></head>
<body>
${prefix}
${htmlBody}
</body>
</html>`;
    const from =
      process.env.SMTP_FROM?.trim() ||
      `ARIA <${user}>`; // display name + mailbox; Gmail still sends as authenticated SMTP_USER
    await transporter.sendMail({
      from,
      to,
      subject,
      text: plainTextBody ?? content,
      html,
    });
    console.log("Briefing email sent to", to);
    return true;
  } catch (e) {
    console.error("Briefing email failed:", e);
    return false;
  }
}

export { sendBriefingEmail };

/** Sample briefing email (ARIA header, portfolio table, Stocks News + stub markdown) — for SMTP/layout checks. */
export async function sendBriefingLayoutPreviewEmail(): Promise<boolean> {
  const sampleHoldings: HoldingEmailRow[] = [
    { symbol: "AMD", kind: "equity", quantity: 50, avgCost: 105, price: 112.34, change24hPct: 1.25, marketValue: 5617 },
    { symbol: "NVDA", kind: "equity", quantity: 10, avgCost: 120, price: 118.5, change24hPct: -0.85, marketValue: 1185 },
    { symbol: "BTC", kind: "crypto", quantity: 0.25, avgCost: 62000, price: 98500, change24hPct: 2.1, marketValue: 24625 },
  ];
  const sampleNews = [
    { ticker: "AMD", title: "Preview: sample company headline (not real news)", url: "https://finnhub.io/", summary: "This is placeholder text to show how stock headlines appear in the briefing email.", source: "finnhub", publishedAt: new Date().toISOString() },
    { ticker: "NVDA", title: "Preview: another sample headline for layout", url: "https://finnhub.io/", summary: "Real briefings pull live headlines from Finnhub for your holdings and watchlist.", source: "finnhub", publishedAt: new Date().toISOString() },
  ];
  const prevPrices = { AMD: 108, NVDA: 119, BTC: 97000 };
  const portfolioHtml = buildBriefingPortfolioPrependHtml({ holdings: sampleHoldings, prevPrices });
  const stocksNewsHtml = buildStocksNewsSectionHtml(sampleNews);
  const portfolioText = buildPortfolioTextPrefix(sampleHoldings, prevPrices);
  const stocksPlain = buildStocksNewsPlainText(sampleNews.map((n) => ({ ticker: n.ticker, title: n.title, url: n.url })));
  const body = `## Good Morning

This is **sample** body text so you can preview the full email layout. Real briefings are generated from your live portfolio, watchlist, scanner, and news.

## Portfolio notes

In production this section stays short — your P/L table is already above.

## Top Signals Today

- **[WATCHLIST]** SAMPLE — layout preview only.

## Worth Watching

- SAMPLE — discovery picks appear here in real briefings.

## Tech News

Sample: real briefings summarize **Hacker News** here (**Stocks News** is placed directly above this heading in the email).

## Market Pulse

Sample closing theme.

## Action Items

1. Confirm the **ARIA** header and green/red percentages look good on your mail client.
2. Tap a **Stocks News** link to verify it opens.`;

  const subject = `ARIA briefing layout preview — ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}`;
  const plainTextBody = portfolioText + injectMarkdownBeforeTechNewsSection(body, stocksPlain);
  return sendBriefingEmail(body, subject, portfolioHtml, stocksNewsHtml, plainTextBody);
}

/** Result of generating a briefing — portfolio block at top; Stocks News injected before Tech News in the body. */
export type BriefingGenerationResult = {
  briefing: BriefingRow;
  portfolioHtml: string;
  stocksNewsHtml: string;
  plainTextBody: string;
};

type BriefingDeps = {
  db: import("sql.js").Database | null;
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
  run: (sql: string, params?: Record<string, string | number | null>) => { lastInsertRowid: number };
  saveDb: () => void;
  fetchCoinGecko: () => Promise<void>;
  fetchStocks: () => Promise<void>;
  fetchHN: () => Promise<void>;
  generateSignals: () => void;
  buildLiveContext: () => string;
  buildMemoryContext: () => string;
  getWatchedTickers: () => string[];
  getScannerTopPicks?: () => Array<{ symbol: string; signal: string; score: number; aria_reasoning: string | null; price: number }>;
};

export function createBriefingGenerators(deps: BriefingDeps) {
  const {
    db,
    execAll,
    run,
    saveDb,
    fetchCoinGecko,
    fetchStocks,
    fetchHN,
    generateSignals,
    buildLiveContext,
    buildMemoryContext,
    getWatchedTickers,
  } = deps;

  async function generateBriefing(): Promise<BriefingGenerationResult | null> {
    if (!db) return null;
    if (!process.env.GEMINI_API_KEY?.trim()) {
      throw new Error("GEMINI_API_KEY is not set in .env");
    }

    await fetchCoinGecko();
    await fetchStocks();
    await fetchHN();
    generateSignals();

    // WAYPOINT [briefing-email-static]
    // WHAT: Portfolio P/L table, Finnhub headlines for user tickers, ARIA header — prepended to HTML email before Gemini body.
    const equityPositions = parseEquityPositions(execAll);
    const holdings = buildHoldingsForEmail(execAll, equityPositions);
    const prevPrices = loadBriefingPriceSnapshot(execAll);
    const newsTickers = collectTickersForStockNews(execAll, getWatchedTickers, equityPositions);
    const stockNews = await fetchStockNewsForBriefing(newsTickers, 5);
    const portfolioHtml = buildBriefingPortfolioPrependHtml({ holdings, prevPrices });
    const stocksNewsHtml = buildStocksNewsSectionHtml(stockNews);
    const portfolioText = buildPortfolioTextPrefix(holdings, prevPrices);
    const stocksPlain = buildStocksNewsPlainText(stockNews.map((n) => ({ ticker: n.ticker, title: n.title, url: n.url })));

    const memoryContext = buildMemoryContext();

    // WAYPOINT [briefing-data-fetch]
    // WHAT: Pull watchlist signals, scanner picks, notable movers, and crypto portfolio for briefing.
    // WHY: Briefings must surface insights from a wider set of tickers — not just Nico's fixed watchlist.
    // HOW: Three tiers — watchlist, scanner top picks (discovery), notable movers (±3 score).
    const watchlistSignals = execAll<{
      ticker: string;
      signal: string;
      reasoning: string | null;
      price: number;
      indicator_data: string | null;
      created_at: string;
    }>(
      `SELECT ticker, signal, reasoning, price, indicator_data, created_at FROM signals
       WHERE ticker IN (SELECT DISTINCT symbol FROM prices)
       ORDER BY created_at DESC LIMIT 20`
    );

    const scannerPicks = execAll<{
      symbol: string;
      signal: string;
      score: number;
      rsi: number | null;
      macd_histogram: number | null;
      aria_reasoning: string | null;
      category: string;
      scanned_at: string;
    }>(
      `SELECT symbol, signal, score, rsi, macd_histogram, aria_reasoning, category, scanned_at
       FROM scanner_results
       WHERE aria_reasoning IS NOT NULL AND aria_reasoning != ''
         AND scanned_at >= datetime('now', '-2 days')
       ORDER BY score DESC
       LIMIT 10`
    );

    const notableMovers = execAll<{
      symbol: string;
      signal: string;
      score: number;
      rsi: number | null;
      macd_histogram: number | null;
      category: string;
      scanned_at: string;
    }>(
      `SELECT symbol, signal, score, rsi, macd_histogram, category, scanned_at
       FROM scanner_results
       WHERE (score >= 3 OR score <= -3)
         AND scanned_at >= datetime('now', '-2 days')
         AND (aria_reasoning IS NULL OR aria_reasoning = '')
       ORDER BY ABS(score) DESC
       LIMIT 8`
    );

    const portfolio = execAll<{
      symbol: string;
      current_price: number;
      unrealized_pnl_pct: number;
      market_value: number;
    }>(
      `SELECT symbol, current_price, unrealized_pnl_pct, market_value
       FROM crypto_portfolio
       ORDER BY market_value DESC`
    );

    const news = execAll<{
      id: number;
      title: string;
      url: string | null;
      summary: string | null;
      created_at: string;
    }>(
      `SELECT id, title, url, summary, created_at FROM news
       WHERE title IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 5`
    );

    const newsBlock =
      news.length > 0
        ? news
            .map(
              (n) =>
                `- Title: ${n.title}\n  Summary: ${n.summary && n.summary.trim() ? n.summary : "No summary"}\n  Link: ${n.url ?? "—"}`
            )
            .join("\n\n")
        : "(No notable tech news from Hacker News available.)";

    console.log("Briefing data: scannerPicks=", scannerPicks.length, "notableMovers=", notableMovers.length, "news=", news.length);

    // WAYPOINT [briefing-freshness]
    // WHAT: Extract tickers mentioned in yesterday's briefing to avoid repetition.
    // WHY: Day-to-day variety — Worth Watching and Top Signals should feel different.
    // HOW: Parse yesterday's content for 2-5 char uppercase words, filter to known tickers.
    let recentlyMentioned: string[] = [];
    const watchedSet = new Set(getWatchedTickers().map((t) => t.toUpperCase()));
    const scannerSymbols = new Set([...scannerPicks, ...notableMovers].map((r) => r.symbol.toUpperCase()));
    const knownTickers = new Set([...watchedSet, ...scannerSymbols, ...portfolio.map((p) => p.symbol.toUpperCase())]);

    const yesterdayBriefing = execAll<{ content: string }>(
      `SELECT content FROM briefings
       WHERE date(created_at) = date('now', '-1 day')
       ORDER BY created_at DESC
       LIMIT 1`
    );
    if (yesterdayBriefing.length) {
      const matches = yesterdayBriefing[0].content.match(/\b[A-Z]{2,5}\b/g) || [];
      recentlyMentioned = [...new Set(matches.map((m) => m.toUpperCase()))].filter((t) => knownTickers.has(t));
    }

    const freshnessRule =
      recentlyMentioned.length > 0
        ? `
FRESHNESS RULE:
These tickers were highlighted yesterday — avoid featuring them again in Worth Watching or Top Signals unless something significant changed (e.g. signal flipped from HOLD to STRONG BUY):
${recentlyMentioned.join(", ")}
`
        : "";

    const scannerNote =
      scannerPicks.length === 0 && notableMovers.length === 0
        ? "\n(Scanner data is empty — scan may not have run yet. Focus on watchlist data only. Note briefly if relevant.)\n"
        : "";

    const userPrompt = `You are ARIA, Nico's personal market intelligence assistant.
Write a morning briefing that is specific, varied, and actionable. Never repeat the same observations two days in a row — always find something fresh to highlight.

DISCOVERY OPPORTUNITIES (from market scan — put these FIRST in Top Signals and Worth Watching when present):

TIER 2 — SCANNER TOP PICKS (broader market, up to 50 stocks scanned):
${JSON.stringify(scannerPicks)}
These are ARIA's highest-conviction picks. OUTSIDE Nico's current watchlist — pure discovery.

TIER 3 — NOTABLE MOVERS (strong signals ±3):
${JSON.stringify(notableMovers)}
Bullish (score ≥3) or bearish (score ≤-3) from today's scan.
${scannerNote}

TIER 1 — NICO'S PORTFOLIO & WATCHLIST:
${JSON.stringify(watchlistSignals)}
His holdings and watchlist. Cover briefly — focus only on what CHANGED or is notable TODAY.

CRYPTO PORTFOLIO:
${JSON.stringify(portfolio)}

TECH NEWS (Hacker News):
${newsBlock}
${memoryContext}
${freshnessRule}

Write the briefing in these sections:

## Good Morning
One sentence on overall market tone today. Make it specific — reference an actual data point.

## Portfolio notes
The email begins with **Your Portfolio Today** (prices, green/red %, P/L since last briefing). **Stocks News** appears later, directly above **Tech News**. Do not repeat those tables or headlines. At most 1-2 sentences if something notable beyond that data.

## Top Signals Today
Pull the 3 strongest signals from ALL THREE tiers — MUST include scanner picks when available. For each: ticker, signal, composite score (if available), one sentence of plain English reasoning. Label: [WATCHLIST] [SCANNER] [MOVER].

## Worth Watching
2-3 discovery picks from Tier 2 or Tier 3 that Nico does NOT own or watch. When scanner data exists, this section MUST contain scanner tickers — never only watchlist tickers.

## Tech News
Summarize 1-2 of the most relevant **Hacker News** stories from the Tech News block below. In the email, **Stocks News** (Finnhub) is inserted directly above this heading — don't duplicate it. If none, say "No notable tech news from Hacker News available."

## Market Pulse
One paragraph on the broader theme across the data. What sector is strong? What's weak? Be analytical, not generic.

## Action Items
Two specific, concrete things Nico could do today. Reference specific tickers and conditions. Never give generic advice.

RULES:
- Maximum 400 words total
- Never say "as of my last update" or similar hedging
- Never repeat yesterday's action items
- Always reference actual numbers from the data
- Frame everything as "indicators suggest" — never present as financial advice`;

    const systemInstruction = "You are ARIA writing a sharp, no-fluff morning briefing for Nico. Be direct, structured, and concrete. Use short sections and bullets.";
    const content = (await generateText(userPrompt, systemInstruction)).trim();
    if (!content) return null;

    const created_at = new Date().toISOString();
    const result = run("INSERT INTO briefings (content, created_at, type) VALUES (:content, :created_at, :type)", {
      ":content": content,
      ":created_at": created_at,
      ":type": "morning",
    });
    saveDb();

    const rows = execAll<BriefingRow>(
      `SELECT id, content, created_at, type FROM briefings WHERE id = ${result.lastInsertRowid} LIMIT 1`
    );
    const briefing = rows[0];
    if (!briefing) return null;

    const priceSnapshot: Record<string, number> = {};
    for (const h of holdings) priceSnapshot[h.symbol] = h.price;
    saveBriefingPriceSnapshot(run, saveDb, priceSnapshot);

    const plainTextBody = portfolioText + injectMarkdownBeforeTechNewsSection(content, stocksPlain);
    return { briefing, portfolioHtml, stocksNewsHtml, plainTextBody };
  }

  async function generateEveningBriefing(): Promise<BriefingGenerationResult | null> {
    if (!db) return null;
    if (!process.env.GEMINI_API_KEY?.trim()) return null;

    await fetchCoinGecko();
    await fetchStocks();
    await fetchHN();
    generateSignals();

    const equityPositions = parseEquityPositions(execAll);
    const holdings = buildHoldingsForEmail(execAll, equityPositions);
    const prevPrices = loadBriefingPriceSnapshot(execAll);
    const newsTickers = collectTickersForStockNews(execAll, getWatchedTickers, equityPositions);
    const stockNews = await fetchStockNewsForBriefing(newsTickers, 5);
    const portfolioHtml = buildBriefingPortfolioPrependHtml({ holdings, prevPrices });
    const stocksNewsHtml = buildStocksNewsSectionHtml(stockNews);
    const portfolioText = buildPortfolioTextPrefix(holdings, prevPrices);
    const stocksPlain = buildStocksNewsPlainText(stockNews.map((n) => ({ ticker: n.ticker, title: n.title, url: n.url })));

    const memoryContext = buildMemoryContext();

    // Same data fetches as morning briefing (WAYPOINT [briefing-data-fetch])
    const watchlistSignals = execAll<{
      ticker: string;
      signal: string;
      reasoning: string | null;
      price: number;
      indicator_data: string | null;
      created_at: string;
    }>(
      `SELECT ticker, signal, reasoning, price, indicator_data, created_at FROM signals
       WHERE ticker IN (SELECT DISTINCT symbol FROM prices)
       ORDER BY created_at DESC LIMIT 20`
    );

    const scannerPicks = execAll<{
      symbol: string;
      signal: string;
      score: number;
      rsi: number | null;
      macd_histogram: number | null;
      aria_reasoning: string | null;
      category: string;
      scanned_at: string;
    }>(
      `SELECT symbol, signal, score, rsi, macd_histogram, aria_reasoning, category, scanned_at
       FROM scanner_results
       WHERE aria_reasoning IS NOT NULL AND aria_reasoning != ''
         AND scanned_at >= datetime('now', '-2 days')
       ORDER BY score DESC
       LIMIT 10`
    );

    const notableMovers = execAll<{
      symbol: string;
      signal: string;
      score: number;
      rsi: number | null;
      macd_histogram: number | null;
      category: string;
      scanned_at: string;
    }>(
      `SELECT symbol, signal, score, rsi, macd_histogram, category, scanned_at
       FROM scanner_results
       WHERE (score >= 3 OR score <= -3)
         AND scanned_at >= datetime('now', '-2 days')
         AND (aria_reasoning IS NULL OR aria_reasoning = '')
       ORDER BY ABS(score) DESC
       LIMIT 8`
    );

    const portfolio = execAll<{
      symbol: string;
      current_price: number;
      unrealized_pnl_pct: number;
      market_value: number;
    }>(
      `SELECT symbol, current_price, unrealized_pnl_pct, market_value
       FROM crypto_portfolio
       ORDER BY market_value DESC`
    );

    const news = execAll<{
      id: number;
      title: string;
      url: string | null;
      summary: string | null;
      created_at: string;
    }>(
      `SELECT id, title, url, summary, created_at FROM news
       WHERE title IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 5`
    );

    const newsBlock =
      news.length > 0
        ? news
            .map(
              (n) =>
                `- Title: ${n.title}\n  Summary: ${n.summary && n.summary.trim() ? n.summary : "No summary"}\n  Link: ${n.url ?? "—"}`
            )
            .join("\n\n")
        : "(No notable tech news from Hacker News available.)";

    console.log("Evening briefing data: scannerPicks=", scannerPicks.length, "notableMovers=", notableMovers.length, "news=", news.length);

    // Freshness: avoid repeating yesterday's tickers (WAYPOINT [briefing-freshness])
    let recentlyMentioned: string[] = [];
    const watchedSet = new Set(getWatchedTickers().map((t) => t.toUpperCase()));
    const scannerSymbols = new Set([...scannerPicks, ...notableMovers].map((r) => r.symbol.toUpperCase()));
    const knownTickers = new Set([...watchedSet, ...scannerSymbols, ...portfolio.map((p) => p.symbol.toUpperCase())]);

    const yesterdayBriefing = execAll<{ content: string }>(
      `SELECT content FROM briefings
       WHERE date(created_at) = date('now', '-1 day')
       ORDER BY created_at DESC
       LIMIT 1`
    );
    if (yesterdayBriefing.length) {
      const matches = yesterdayBriefing[0].content.match(/\b[A-Z]{2,5}\b/g) || [];
      recentlyMentioned = [...new Set(matches.map((m) => m.toUpperCase()))].filter((t) => knownTickers.has(t));
    }

    const freshnessRule =
      recentlyMentioned.length > 0
        ? `
FRESHNESS RULE:
These tickers were highlighted yesterday — avoid featuring them again in Scanner Standouts or Tomorrow's Watchlist unless something significant changed:
${recentlyMentioned.join(", ")}
`
        : "";

    const scannerNote =
      scannerPicks.length === 0 && notableMovers.length === 0
        ? "\n(Scanner data is empty — focus on watchlist and portfolio data only.)\n"
        : "";

    const userPrompt = `You are ARIA, Nico's personal market intelligence assistant.
Write an evening briefing (6pm) that summarizes the day and sets up tomorrow.

DISCOVERY OPPORTUNITIES (from market scan — put these FIRST in Scanner Standouts and Tomorrow's Watchlist):

TIER 2 — SCANNER TOP PICKS:
${JSON.stringify(scannerPicks)}

TIER 3 — NOTABLE MOVERS:
${JSON.stringify(notableMovers)}
${scannerNote}

TIER 1 — NICO'S PORTFOLIO & WATCHLIST:
${JSON.stringify(watchlistSignals)}

CRYPTO PORTFOLIO:
${JSON.stringify(portfolio)}

TECH NEWS:
${newsBlock}
${memoryContext}
${freshnessRule}

Write the briefing in these sections:

## Market Close Summary
How did the day end overall — reference actual price/signal changes from the data.

## Portfolio wrap
The email already has **Your Portfolio Today** / **Profit-Loss** and **Stocks News**. Do not repeat that data. One tight paragraph on narrative only if something mattered beyond the table.

## Scanner Standouts
2-3 tickers from scanner_results with the most interesting movement today. MUST include scanner picks when data exists.

## Tomorrow's Watchlist
2-3 tickers for tomorrow morning. Draw from scanner picks with strong but not yet extreme RSI.

## Tech News
1-2 relevant **Hacker News** stories only (**Stocks News** is inserted directly above this heading in the email). If none, say "No notable tech news available."

## Evening Action Item
One specific thing to consider before tomorrow's open.

RULES:
- Maximum 400 words total
- Frame everything as "indicators suggest" — never present as financial advice
- Reference actual numbers from the data`;

    const systemInstruction = "You are ARIA writing a sharp evening briefing for Nico. Direct, concrete, no fluff. Use short bullets.";
    const content = (await generateText(userPrompt, systemInstruction)).trim();
    if (!content) return null;

    const created_at = new Date().toISOString();
    const result = run("INSERT INTO briefings (content, created_at, type) VALUES (:content, :created_at, :type)", {
      ":content": content,
      ":created_at": created_at,
      ":type": "evening",
    });
    saveDb();

    const rows = execAll<BriefingRow>(
      `SELECT id, content, created_at, type FROM briefings WHERE id = ${result.lastInsertRowid} LIMIT 1`
    );
    const briefing = rows[0];
    if (!briefing) return null;

    const priceSnapshot: Record<string, number> = {};
    for (const h of holdings) priceSnapshot[h.symbol] = h.price;
    saveBriefingPriceSnapshot(run, saveDb, priceSnapshot);

    const plainTextBody = portfolioText + injectMarkdownBeforeTechNewsSection(content, stocksPlain);
    return { briefing, portfolioHtml, stocksNewsHtml, plainTextBody };
  }

  return { generateBriefing, generateEveningBriefing };
}
