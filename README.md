# ARIA — Autonomous Research & Intelligence Assistant

> Your personal intelligence layer for tech, finance, and developer growth.

## Stack
- **Frontend**: React + TypeScript + Vite (port 5173)
- **Backend**: Node.js + TypeScript + Express (port 3001)
- **AI Brain**: Claude API (Sonnet 4.5)
- **Memory**: SQLite via sql.js (local file: `aria.db`, no native build)

---

## Setup (5 minutes)

### 1. Install dependencies
```bash
npm install
```

### 2. Configure your API key
```bash
cp .env.example .env
```
Open `.env` and add your Anthropic API key:
```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```
Get your key at: https://console.anthropic.com

### 3. Run ARIA
```bash
npm run dev
```

This starts both the server (port 3001) and the frontend (port 5173) simultaneously.

Open your browser to: **http://localhost:5173**

---

## Build Phases

### Phase 1 — The Shell ✅
- Hybrid UI — chat panel + dashboard sidebar
- Claude API wired in with ARIA's system prompt
- Persistent memory via SQLite (conversations survive restarts)
- AI Radar panel
- Build Phase tracker

### Phase 2 — The Eyes ✅
- **Live prices**: CoinGecko (crypto) + Yahoo Finance (stocks) — stored in DB, refreshed every 5 min
- **Tech news**: Hacker News top stories — fetched every 15 min, linked in sidebar
- **Real signals**: BUY/SELL/HOLD/WATCH generated from 24h price moves, stored in DB, refreshed every 5 min
- **Dashboard sidebar**: Market Pulse and Tech News (HN) update on a 1‑minute poll
- **Signals tab**: List of live signals with ticker, signal, reasoning, price

### Phase 3 — The Brain ✅
- **Tool calling** — ARIA uses local tools: `get_prices`, `get_signals`, `get_news`, `generate_signal`, `get_risk_context`, `remember`, `recall`
- **Scheduled tasks** — Cron: prices (5 min), news (15 min), signals (5 min), morning briefing
- **Agent loop** — Claude chains multiple tool calls until it returns only text (no hand-holding)
- **Memory extraction** — After each reply, ARIA extracts facts (positions, preferences, risk tolerance) and persists them

*Note: Web search is implemented (optional, requires [Tavily API key](#web-search-tavily)). Opus upgrade is in [Future Work](#future-work).*

### Phase 4 — The Edge ✅
- **OHLCV historical** — Alphavantage (stocks + crypto), last 100 days
- **Technical indicators** — RSI, MACD, 20/50 MAs → composite signals with methodology
- **Backtest engine** — Historical simulation, equity curve, win rate, drawdown; exposed via API and Backtest tab
- **Risk framing** — `get_risk_context` tool: position size %, stop-loss, take-profit, risk:reward, confidence
- **Memory tab** — Portfolio (positions, watchlist), preferences, context; add/edit/delete, export JSON, clear all
- **Watchlist from memory** — Base tickers (BTC, AMD, AMZN, CLS) + Memory watchlist drive price/OHLCV/signal fetching
- **Morning briefing** — Structured digest with market summary, signals with risk framing, HN news, action items (8am weekdays)
- **Evening briefing** — 6pm weekdays: upside tickers, market-moving news, portfolio snapshot, tech/AI pulse; optional email delivery
- **Holdings in sidebar** — Positions from Memory shown in collapsible accordion

---

## Web Search (Tavily)

ARIA can search the web for current information. **To enable:**

1. Sign up at [tavily.com](https://tavily.com) — free tier: 1K searches/month, no credit card
2. Get your API key
3. Add to `.env`: `TAVILY_API_KEY=tvly-your-key`
4. Restart the server

Without the key, ARIA will tell Nico that web search isn't configured when it tries to use it.

## Evening Briefing (6pm + email)

A **6pm weekday briefing** runs automatically. It includes:
1. **Tickers with upside potential** — stocks that could move up tomorrow (from web search; not limited to your watchlist)
2. **Big news with money-making implications** — earnings, Fed, economic data, catalysts
3. **Your portfolio snapshot** — quick take on holdings, signals, risk alerts
4. **Tech & AI pulse** — notable moves relevant to your work or investments

**Email delivery (optional):** To get the briefing by email at 6pm, add to `.env`:
```
BRIEFING_EMAIL_TO=your@email.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-password
```

For Gmail, use an [App Password](https://support.google.com/accounts/answer/185833) (not your main password). Without SMTP, the briefing is still generated and stored — view it in the Briefing tab.

**Manual trigger:** POST `/api/briefings/generate-evening` or use the "Evening (6pm)" button in the Briefing tab.

## Future Work

| Item | Effort | Notes |
|------|--------|-------|
| **Claude Opus upgrade** | Config change | Use Opus for complex reasoning / research; Sonnet is fine for most tasks |

---

## Project Structure

```
aria/
├── server/
│   └── index.ts          # Express API + Claude integration + SQLite
├── src/
│   ├── App.tsx            # Main UI component
│   └── main.tsx           # React entry point
├── aria.db                # Auto-created SQLite database (gitignore this)
├── .env                   # Your API key (gitignore this)
├── .env.example           # Template
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Server status check |
| POST | `/api/chat` | Send message, get ARIA response |
| GET | `/api/history` | Load conversation history |
| DELETE | `/api/history` | Clear all messages |
| POST | `/api/signals` | Save a financial signal |
| GET | `/api/signals` | Get recent signals |
| GET | `/api/prices` | Latest prices |
| GET | `/api/news` | Tech news (Hacker News top stories) |
| GET | `/api/dashboard` | Aggregate: prices + news + tickers + signals by ticker |
| GET | `/api/memories` | All memories (portfolio, preferences, context) |
| POST | `/api/memories` | Create/update memory |
| DELETE | `/api/memories` | Clear all memories |
| GET | `/api/ohlcv/:symbol?days=90` | Historical OHLCV for a ticker |
| GET | `/api/backtest?ticker=&days=` | Run backtest simulation |
| GET | `/api/briefings` | List morning briefings |
| POST | `/api/briefings/generate` | Generate morning briefing |
| POST | `/api/briefings/generate-evening` | Generate 6pm evening briefing (upside tickers, news, portfolio, tech) |

---

## Automatic backups

The server backs up `aria.db` to a `backups/` folder at 3am on the **1st and 15th** of each month (~every 14 days). It keeps the last 6 backups. To restore: stop the server, copy a backup over `aria.db`, then restart.

## Tips

- ARIA remembers your conversations between sessions (SQLite)
- Clear history anytime: `DELETE http://localhost:3001/api/history`
- The `.env` file and `aria.db` should both be in your `.gitignore`
- Add positions and watchlist in Memory → Portfolio; they drive sidebar Holdings and Market Pulse
- Phase 2 runs scheduled fetches on startup and on intervals (5 min prices & signals, 15 min news). The frontend polls `/api/dashboard` every 60s.

---

*Built by Nico × ARIA — Phases 1–4 complete*
