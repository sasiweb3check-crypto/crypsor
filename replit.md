# Crypsor

A Solana token intelligence platform that scans wallets for new tokens, scores them via pump-fullend signals, and surfaces picks on a real-time desk.

## Stack

- **Frontend:** React + Vite + Tailwind + TanStack Query + Wouter (`artifacts/crypsor`)
- **API + pipeline:** Express v5 + TypeScript + Drizzle ORM (`artifacts/api-server`)
- **Host:** **Vercel** (single project — SPA + Fluid Compute API + Cron)
- **Database:** PostgreSQL (Aiven or any Postgres)
- **External APIs:** Helius (Solana), DexScreener, optional GMGN

## Production deploy (Vercel)

One project deploys everything from the repo root (`vercel.json`):

| Piece | How |
|---|---|
| Desk SPA | Vite build → `artifacts/crypsor/dist/public` |
| API `/api/*` | Express via `api/index.ts` (Fluid Compute, 300s) |
| Pipeline wake | Cron `* * * * *` → `GET /api/cron/tick` |

### Steps

1. Import this GitHub repo in [Vercel](https://vercel.com/new) (root directory `.`).
2. Set environment variables (Production + Preview as needed):

| Secret | Required | Notes |
|---|---|---|
| `AIVEN_DATABASE_URL` | yes | Postgres URL (`sslmode=require`) |
| `HELIUS_API_KEY` | yes | Wallet buy discovery |
| `CRON_SECRET` | yes | Protects `/api/cron/tick` (Vercel Cron sends `Bearer`) |
| `SESSION_SECRET` | yes | Session signing |
| `GMGN_API_KEY` | optional | Legacy / heavy routes |
| `TELEGRAM_PUSH_ENABLED` | optional | default on |
| `CORS_ORIGIN` | optional | same-origin deploy usually omits |
| `VITE_API_URL` | **omit** | same-origin `/api` |

3. Deploy. Open `https://<project>.vercel.app` — desk + API share the host.
4. Confirm: `GET /api/healthz` and Settings → save Helius → Verify.
5. Delete the old Render services (`crypsor-api`, `crypsor-web`) once traffic is on Vercel.

Local: see `.env.example`. Health check: `GET /api/healthz`. Cron: `GET /api/cron/tick`.

## How to run locally

| Service | Command |
|---|---|
| Desk | `pnpm --filter @workspace/crypsor run dev` |
| API | `pnpm --filter @workspace/api-server run dev` (needs `PORT`) |

## Architecture

See `ARCHITECTURE.md` for pipeline, routes, and schema.
