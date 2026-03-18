# ARIA Fly.io Deployment — Context for Claude

## What We Deployed

**ARIA** (Autonomous Research & Intelligence Assistant) is now hosted on **Fly.io** for 24/7 operation. It's a Node.js backend + React frontend app that uses Google Gemini 2.0 Flash for chat, briefings, and memory, with SQLite (sql.js) for persistence.

- **App name:** `aria-nico`
- **URL:** https://aria-nico.fly.dev
- **Region:** `sjc` (San Jose)

## Architecture

- **Backend:** Express server (Node 20), compiled to `dist-server/server/index.js`
- **Frontend:** React app built to `dist/`, served statically by the backend in production
- **Database:** SQLite at `/data/aria.db` — persisted on a Fly volume
- **Port:** 8080 (Fly sets `PORT=8080`)

## Volume vs Secrets

- **Volume** (`aria_data` → `/data`): Holds the SQLite database only. No secrets go here. Created with `flyctl volumes create aria_data --size 1 --region sjc`.
- **Secrets:** Set via `flyctl secrets set KEY=value`. Injected as environment variables at runtime. Never stored in the volume.

## Secrets (flyctl secrets set)

| Secret | Required | Purpose |
|--------|----------|---------|
| `GEMINI_API_KEY` | Yes | Gemini 2.0 Flash for chat, briefings, memory (free tier) |
| `ALPHAVANTAGE_API_KEY` | No | OHLCV historical data |
| `FINNHUB_API_KEY` | No | Stock prices |
| `TAVILY_API_KEY` | No | Web search in chat |
| `ROBINHOOD_API_KEY` | No | Crypto portfolio |
| `ROBINHOOD_PRIVATE_KEY` | No | Robinhood API signing |
| `BRIEFING_EMAIL_TO` | No | Evening briefing recipient |
| `SMTP_HOST` | No | e.g. smtp.gmail.com |
| `SMTP_PORT` | No | Default 587 |
| `SMTP_USER` | No | SMTP username |
| `SMTP_PASS` | No | Gmail App Password (16 chars) — **required for email** |
| `SMTP_FROM` | No | e.g. "ARIA <your@gmail.com>" |

For Gmail, use an [App Password](https://myaccount.google.com/apppasswords) (requires 2-Step Verification).

## Deploy & Manage

```bash
flyctl deploy              # Deploy latest
flyctl open                # Open app in browser
flyctl status              # Check machine status
flyctl secrets list        # List secret names (values hidden)
flyctl logs                # View logs
```

## Test Evening Briefing Email

```bash
curl -X POST https://aria-nico.fly.dev/api/briefings/generate-evening
```

Response includes `email_sent: true` or `false` — confirms SMTP is working.

## Cron Jobs (in-process)

- Prices/signals: every 5 min
- News: every 15 min
- OHLCV: daily 06:00
- Scanner: daily 07:00
- Morning briefing: weekdays 08:00
- Evening briefing: weekdays 18:00 (emails if SMTP configured)
- DB backup: 1st and 15th at 03:00

## Health Check

`GET /health` → `{"status":"healthy","timestamp":"..."}` — used by Fly for liveness.

## Files

- `Dockerfile` — Node 20 Alpine, builds frontend + server, exposes 8080
- `fly.toml` — App config, volume mount, health check, 256MB VM
- `.dockerignore` — Excludes node_modules, .env, .git, aria.db
- `DEPLOY.md` — Deployment instructions
