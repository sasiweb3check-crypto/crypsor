# Crypsor

Solana memecoin gem desk — tracked-wallet discovery, evidence-gated GEM
scoring, survival tracking, Telegram alerts.

- **Desk:** confirmed GEM calls (judged by survival) + live capture log
- **Engine:** buy-sourced discovery → snapshot tape → GEM score (flow /
  holders / smart / structure / timing, hard vetoes, confidence gate) →
  GEM_CALL alerts → survival scoring after the call

## Deploy (Render)

The funnel is an always-on Node process. **Render Starter** is the intended
host: one web service serves the desk, `/api`, and the scanner together.

See **[docs/RENDER.md](docs/RENDER.md)** — Blueprint file is `render.yaml`.

```bash
# after secrets are set in the Render dashboard
# Build:  pnpm run build:render
# Start:  pnpm run start:render
```

## Keep it running 24/7

On Render **Starter** the process does not sleep — no pinger needed.

On Render **free** or **Vercel Hobby**, the instance freezes without traffic.
Set up a free external pinger: [docs/UPTIME.md](docs/UPTIME.md). A GitHub
Actions baseline (`.github/workflows/keepalive.yml`) pings every 30 minutes
if you set the `APP_URL` repo variable.

## Development

```bash
pnpm install
pnpm --filter @workspace/api-server dev   # API on :3000
pnpm --filter @workspace/crypsor dev      # Vite dev server
```

Env: `DATABASE_URL` (Postgres), `HELIUS_API_KEY`, optional `GMGN_API_KEY`,
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (or via Settings UI), `CRON_SECRET`
for the authorized cron tick.
