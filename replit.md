# Crypsor

A Solana token intelligence platform that scans wallets for new tokens, scores them via pump-fullend signals, and surfaces picks on a real-time desk.

## Stack

- **Frontend:** React + Vite + Tailwind + TanStack Query + Wouter (`artifacts/crypsor`)
- **API + pipeline:** Express v5 + TypeScript + Drizzle ORM (`artifacts/api-server`)
- **Host:** **Vercel Hobby (free)** — SPA + Fluid Compute API, same origin
- **Database:** PostgreSQL (Aiven free or any Postgres)
- **External APIs:** Helius (Solana), DexScreener, optional GMGN

## Production deploy (Vercel Hobby / free)

One project deploys everything from the repo root (`vercel.json`):

| Piece | How |
|---|---|
| Desk SPA | Vite build → `artifacts/crypsor/dist/public` |
| API `/api/*` | Express via `api/index.ts` (max 60s on Hobby) |
| Pipeline wake | Desk pings `GET /api/keepalive` every ~60s while open |

> **Hobby limit:** Vercel Cron cannot run more than once per day on free. We removed minute crons so deploys succeed. While the desk tab is open, keepalive keeps the pipeline warm. For 24/7 when nobody has the tab open, point a **free** external cron ([cron-job.org](https://cron-job.org)) at `GET /api/cron/tick` every 1–2 min with header `Authorization: Bearer <CRON_SECRET>`.

### Steps

1. Import this GitHub repo in [Vercel](https://vercel.com/new) (root directory `.`).
2. Set environment variables (Production):

| Secret | Required | Notes |
|---|---|---|
| `AIVEN_DATABASE_URL` | yes | Postgres URL (`sslmode=require`) |
| `HELIUS_API_KEY` | yes | Wallet buy discovery |
| `SESSION_SECRET` | yes | Session signing |
| `CRON_SECRET` | recommended | For optional external free cron |
| `GMGN_API_KEY` | optional | Legacy / heavy routes |
| `TELEGRAM_PUSH_ENABLED` | optional | default on |
| `CORS_ORIGIN` | optional | same-origin usually omits |
| `VITE_API_URL` | **omit** | same-origin `/api` |

3. Deploy. Open `https://<project>.vercel.app`.
4. Confirm: `GET /api/healthz` and Settings → Helius Save/Verify.
5. (Optional 24/7) Free cron → `https://<project>.vercel.app/api/cron/tick` every 1–2 min + Bearer secret.
6. Delete old Render services once live.

## How to run locally

| Service | Command |
|---|---|
| Desk | `pnpm --filter @workspace/crypsor run dev` |
| API | `pnpm --filter @workspace/api-server run dev` (needs `PORT`) |

## Architecture

See `ARCHITECTURE.md` for pipeline, routes, and schema.
