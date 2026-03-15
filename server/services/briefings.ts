/**
 * Morning and evening briefings: fetch data, call Claude, store, optionally email.
 */

import nodemailer from "nodemailer";

type BriefingRow = { id: number; content: string; created_at: string; type: "morning" | "evening" };

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

async function sendBriefingEmail(content: string, subject: string): Promise<boolean> {
  const to = process.env.BRIEFING_EMAIL_TO?.trim();
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  if (!to || !host || !user || !pass) return false;

  try {
    const transporter = nodemailer.createTransport({
      host,
      port: parseInt(process.env.SMTP_PORT ?? "587", 10),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user, pass },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM?.trim() || user,
      to,
      subject,
      text: content,
      html: content.replace(/\n/g, "<br>"),
    });
    return true;
  } catch (e) {
    console.error("Briefing email failed:", e);
    return false;
  }
}

export { sendBriefingEmail };

type BriefingDeps = {
  db: import("sql.js").Database | null;
  anthropic: import("@anthropic-ai/sdk").default;
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
  run: (sql: string, params?: Record<string, string | number | null>) => { lastInsertRowid: number };
  saveDb: () => void;
  fetchCoinGecko: () => Promise<void>;
  fetchStocks: () => Promise<void>;
  fetchHN: () => Promise<void>;
  generateSignals: () => void;
  buildLiveContext: () => string;
  buildMemoryContext: () => string;
  getScannerTopPicks?: () => Array<{ symbol: string; signal: string; score: number; aria_reasoning: string | null; price: number }>;
};

export function createBriefingGenerators(deps: BriefingDeps) {
  const {
    db,
    anthropic,
    execAll,
    run,
    saveDb,
    fetchCoinGecko,
    fetchStocks,
    fetchHN,
    generateSignals,
    buildLiveContext,
    buildMemoryContext,
    getScannerTopPicks,
  } = deps;

  async function generateBriefing(): Promise<BriefingRow | null> {
    if (!db) return null;
    if (!process.env.ANTHROPIC_API_KEY?.trim()) {
      throw new Error("ANTHROPIC_API_KEY is not set in .env");
    }

    await fetchCoinGecko();
    await fetchStocks();
    await fetchHN();
    generateSignals();

    const liveContext = buildLiveContext();
    const memoryContext = buildMemoryContext();
    const scannerPicks = getScannerTopPicks?.() ?? [];
    const worthWatchingSection =
      scannerPicks.length > 0
        ? `\n--- Worth Watching Today (Scanner picks, score ≥+3) ---\n${scannerPicks
            .map((p) => `${p.symbol}: ${p.signal} (score +${p.score}/6) — ${p.aria_reasoning ?? "—"}`)
            .join("\n")}\n\nInclude 2-3 of the strongest in the briefing under a "Worth Watching Today" section. Keep it to 2 sentences per pick — ticker, signal, and one reason why. If no strong picks exist, skip that section.\n`
        : "\n(No scanner picks with score ≥+3 — skip Worth Watching Today section.)\n";

    const userPrompt = `Write a concise morning briefing for Nico based on the live market data, signals, news, and memory below.
${worthWatchingSection}
Include:
- Market summary for watched tickers (BTC, UBER, SPY, LTBR, GDX, GOLD)
- When Nico has real crypto positions (from Robinhood in the live data): include his actual P&L, buying power, and one sentence on whether either position warrants attention today
- Top signals with plain-English reasoning (not just BUY/SELL labels — explain why, reference RSI/MACD/MAs when available)
- For each signal recommendation: suggested position size %, stop-loss level %, and a one-sentence plain-English risk statement (e.g. "Risk 5% of portfolio, cut losses at -3%")
- Notable tech news from HN
- One specific actionable recommendation for Nico with a brief explanation of why
- 2–3 concrete action items for today

Keep it under 400 words. Frame every recommendation with risk context (suggested size, stop-loss); never overstate certainty. Use "indicators suggest" not "you should".

Risk sizing guide (from Nico's risk_tolerance in memory): conservative = max 5% per position, stop -3%; moderate = 10%, stop -5%; aggressive = 20%, stop -8%. Default to moderate if not specified.

${liveContext}
${memoryContext}
`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 800,
      system:
        "You are ARIA writing a sharp, no-fluff morning briefing for Nico. Be direct, structured, and concrete. Use short sections and bullets.",
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = response.content.find((c: any) => c.type === "text") as { text: string } | undefined;
    const content = textBlock?.text?.trim();
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
    return rows[0] ?? null;
  }

  async function generateEveningBriefing(): Promise<BriefingRow | null> {
    if (!db) return null;
    if (!process.env.ANTHROPIC_API_KEY?.trim()) return null;

    await fetchCoinGecko();
    await fetchStocks();
    await fetchHN();
    generateSignals();

    const liveContext = buildLiveContext();
    const memoryContext = buildMemoryContext();

    const [upsideSearch, newsSearch, techSearch] = await Promise.all([
      tavilySearch("stocks to watch tomorrow analyst picks momentum upgrades", 5),
      tavilySearch("earnings calendar this week Fed meeting economic data releases market moving events", 5),
      tavilySearch("tech stocks AI industry news today", 4),
    ]);

    const formatResults = (results: Array<{ title: string; url: string; content: string }>) =>
      results.length === 0
        ? "(No web results — use your knowledge if relevant)"
        : results.map((r) => `• ${r.title}\n  ${(r.content ?? "").slice(0, 250)}${(r.content ?? "").length > 250 ? "…" : ""}`).join("\n\n");

    const userPrompt = `Write a concise evening briefing for Nico (6pm). Include these four sections:

## 1. Tickers with upside potential tomorrow
Use the web search results below. Pick 2–4 tickers that could move up (analyst upgrades, momentum, catalysts). They don't have to be in Nico's watchlist. For each: ticker, brief reason, and one-line risk note.

## 2. Big news with money-making implications
From the web search: earnings, Fed, economic data, or other events that could move markets. What's coming up and why it matters. Be specific (dates, names).

## 3. Your portfolio snapshot
From Nico's positions, watchlist in memory, and real Robinhood crypto data (if present): quick take on each holding. Include end-of-day portfolio snapshot with how positions moved. Reference our signals and risk context. Any alerts or suggested tweaks. Keep it tight.

## 4. Tech & AI pulse
From the web search: notable moves in tech/AI that could affect Nico's work or investments. He's a frontend dev in the Bay Area; surface what's relevant.

Keep total under 500 words. Be direct. Use bullets. Frame every recommendation with "indicators suggest" or similar; never guarantee. Risk sizing guide from memory: conservative 5%/-3%, moderate 10%/-5%, aggressive 20%/-8%.

--- Web search: upside tickers ---
${formatResults(upsideSearch)}
--- Web search: market-moving news ---
${formatResults(newsSearch)}
--- Web search: tech/AI ---
${formatResults(techSearch)}

--- Live market data ---
${liveContext}
--- Memory ---
${memoryContext}
`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1200,
      system:
        "You are ARIA writing a sharp evening briefing for Nico. Four sections. Direct, concrete, no fluff. Use short bullets.",
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = response.content.find((c: any) => c.type === "text") as { text: string } | undefined;
    const content = textBlock?.text?.trim();
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
    return rows[0] ?? null;
  }

  return { generateBriefing, generateEveningBriefing };
}
