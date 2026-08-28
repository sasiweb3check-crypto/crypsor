# Crypsor

A Solana token intelligence platform that scans wallets for new tokens, scores them via pump-fullend signals, and surfaces picks on a real-time desk.

## Stack

- **Frontend:** React + Vite + Tailwind + TanStack Query + Wouter (`artifacts/crypsor`)
- **API + pipeline:** Express v5 + TypeScript + Drizzle ORM (`artifacts/api-server`)
- **Host:** **Render Starter** — one always-on Node web service (SPA + API + funnel), same origin. Vercel Hobby remains a fallback (needs a keepalive pinger).
- **Database:** PostgreSQL (Aiven free or any Postgres)
- **External APIs:** Helius (Solana), DexScreener, optional GMGN

## Production deploy (Render Starter)

One web service deploys everything from the repo root (`render.yaml`). See [docs/RENDER.md](docs/RENDER.md).

| Piece | How |
|---|---|
| Desk SPA | Vite build, served by Express from `artifacts/crypsor/dist/public` |
| API `/api/*` | Express on `0.0.0.0:$PORT` |
| Funnel | `ensureRuntime()` at boot — always-on, no keepalive |

### Steps

1. Render Dashboard → New Blueprint → this GitHub repo (or New Web Service with the build/start commands in `render.yaml`).
2. Set environment variables:

| Secret | Required | Notes |
|---|---|---|
| `AIVEN_DATABASE_URL` | yes | Postgres URL (`sslmode=require`) |
| `HELIUS_API_KEY` | yes | Wallet buy discovery |
| `SESSION_SECRET` | yes | Session signing (Blueprint can generate) |
| `CRON_SECRET` | optional | Only if you ping `/api/cron/tick` from outside |
| `GMGN_API_KEY` | optional | Holder intel |
| `TELEGRAM_PUSH_ENABLED` | optional | default on |
| `CORS_ORIGIN` | optional | same-origin omits |
| `VITE_API_URL` | **omit** | same-origin `/api` |

3. Deploy. Open `https://<service>.onrender.com`.
4. Confirm: `GET /api/healthz` and Settings → Helius Save/Verify.
5. Keep **1** instance. Do not autoscale — the funnel is in-process.

## How to run locally

| Service | Command |
|---|---|
| Desk | `pnpm --filter @workspace/crypsor run dev` |
| API | `pnpm --filter @workspace/api-server run dev` (needs `PORT`) |

## Architecture

See `ARCHITECTURE.md` for pipeline, routes, and schema.
