# Crypsor

Hospital for Solana tokens bought by **your** wallets. The only data source
is wallet buys (Helius). Each mint is a patient: intake → ward / ICU →
recovery, deceased, or revived. Survival is scored from tape leadership
(omo-style 5m/1h/6h), liquidity, holder behaviour, and holder quality
(hold share, not bot counts).

- **Ward:** live patients by phase, survival rate, TRADE alerts
- **Patient chart:** every factor, tape, holder quality, admitting wallets
- **Agents:** intake, vitals, holders, reporter, backtest (self-tuning weights)
- **Alerts:** Telegram + in-app for admit, trade, ICU, death, revival

## Deploy (Render)

One Node process on **Render** serves the desk, `/api`, and the agents.

See **[docs/RENDER.md](docs/RENDER.md)** — Blueprint file is `render.yaml`.

```bash
# after secrets are set in the Render dashboard
# Build:  pnpm run build:render
# Start:  pnpm run start:render
```

## Keep it running 24/7

On Render **Starter** the process does not sleep — no pinger needed.

On Render **free**, the instance sleeps without traffic. Point a free pinger
at `GET /api/keepalive`: [docs/UPTIME.md](docs/UPTIME.md).

## Development

```bash
pnpm install
pnpm --filter @workspace/api-server dev   # API on :3000
pnpm --filter @workspace/crypsor dev      # Vite desk
```

Env: `DATABASE_URL` or `AIVEN_DATABASE_URL`, `HELIUS_API_KEY`, optional
`GMGN_API_KEY`, Telegram via Settings, `CRON_SECRET` for `/api/cron/tick`.
Add wallets in Settings — that is the entire discovery surface.
