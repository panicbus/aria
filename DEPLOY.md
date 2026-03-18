# ARIA — Fly.io Deployment

## Project Structure

```
aria/
├── server/
│   └── index.ts          # Entry point (compiled to dist-server/server/index.js)
├── src/                  # React frontend (built to dist/)
├── Dockerfile
├── fly.toml
├── .dockerignore
└── package.json
```

## Server Details

- **Entry point:** `dist-server/server/index.js` (compiled from `server/index.ts`)
- **Port:** 8080 (Fly sets `PORT=8080`; server uses `process.env.PORT || 3001`)
- **Database:** SQLite at `/data/aria.db` when `DATA_DIR=/data`

## Deploy Steps

### 1. Create the volume (first time only)

```bash
flyctl volumes create aria_data --size 1 --region sjc
```

### 2. Set secrets

```bash
# Required for chat and briefings (free at https://aistudio.google.com/app/apikey)
flyctl secrets set GEMINI_API_KEY=your_key

# Optional — add as needed
flyctl secrets set ALPHAVANTAGE_API_KEY=your-key    # OHLCV data
flyctl secrets set FINNHUB_API_KEY=your-key        # Stock prices
flyctl secrets set TAVILY_API_KEY=tvly-your-key    # Web search
flyctl secrets set ROBINHOOD_API_KEY=...           # Crypto portfolio
flyctl secrets set ROBINHOOD_PRIVATE_KEY=...       # Robinhood signing
```

### 3. Deploy

```bash
flyctl deploy
```

### 4. Open the app

```bash
flyctl open
```

## Environment Variables (Secrets)

| Variable | Required | Purpose |
|----------|----------|---------|
| `GEMINI_API_KEY` | Yes | Gemini 2.0 Flash for chat, briefings, memory (free tier) |
| `ALPHAVANTAGE_API_KEY` | No | OHLCV historical data (25 req/day free) |
| `FINNHUB_API_KEY` | No | Live stock prices |
| `TAVILY_API_KEY` | No | Web search in chat |
| `ROBINHOOD_API_KEY` | No | Crypto portfolio from Robinhood |
| `ROBINHOOD_PRIVATE_KEY` | No | Robinhood API signing |
| `BRIEFING_EMAIL_TO` | No | Evening briefing email recipient |
| `SMTP_*` | No | SMTP for email briefings |

## Health Check

- **Path:** `GET /health`
- **Response:** `{"status":"healthy","timestamp":"..."}`

## Cron Jobs (run in-process)

- Prices/signals: every 5 min
- News: every 15 min
- OHLCV refresh: daily 06:00
- Scanner: daily 07:00
- Morning briefing: weekdays 08:00
- Evening briefing: weekdays 18:00
- DB backup: 1st and 15th at 03:00

## Free Tier

- 256MB RAM, shared-cpu-1x
- 1GB persistent volume
- `auto_stop_machines = false` — keeps 1 machine running 24/7
