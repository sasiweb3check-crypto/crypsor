# Crypsor

A Solana token intelligence platform that scans wallets for new tokens, scores them via a multi-factor pipeline, and surfaces high-quality picks in a real-time dashboard.

## Stack

- **Frontend:** React + Vite + Tailwind + TanStack Query + Wouter (`artifacts/crypsor`) — deploy on **Vercel**
- **API Server:** Express v5 + TypeScript + Drizzle ORM + BullMQ (`artifacts/api-server`) — deploy on **Render**
- **Database:** PostgreSQL (Aiven)
- **Queue/Cache:** Redis (Aiven)
- **External APIs:** Helius (Solana RPC + tx data), GMGN (token stats)

## Production deploy

| Service | Platform | Notes |
|---|---|---|
| SPA (`artifacts/crypsor`) | Vercel | Set `VITE_API_URL` to the Render API URL |
| API + pipeline | Render (`render.yaml`) | Always-on web service; set Aiven + API keys + `CORS_ORIGIN` |

1. Create Render Blueprint from `render.yaml` (or New Web Service from this repo).
2. Set Render env: `AIVEN_DATABASE_URL`, `AIVEN_REDIS_URL`, `HELIUS_API_KEY`, `GMGN_API_KEY`, `CORS_ORIGIN`.
3. Deploy frontend on Vercel from this repo (root `vercel.json`). Set `VITE_API_URL=https://<render-service>.onrender.com`.
4. Set `CORS_ORIGIN` on Render to the Vercel URL and redeploy if needed.

Health check: `GET /api/healthz`

## How to run (local / Replit)

Both services start automatically via Replit workflows:

| Workflow | Command |
|---|---|
| `artifacts/crypsor: web` | `pnpm --filter @workspace/crypsor run dev` |
| `artifacts/api-server: API Server` | `pnpm --filter @workspace/api-server run dev` |

The frontend is served at `/` and the API at `/api`.

## Required secrets

| Secret | Where | Description |
|---|---|---|
| `AIVEN_DATABASE_URL` | Render | PostgreSQL (`postgres://...?sslmode=require`) |
| `AIVEN_REDIS_URL` | Render | Redis (`rediss://...`) |
| `HELIUS_API_KEY` | Render | Helius Solana RPC + enhanced tx API |
| `GMGN_API_KEY` | Render | GMGN token data API key |
| `GMGN_PROXIES` | Render | Comma-separated proxy URLs (optional) |
| `SESSION_SECRET` | Render | Express session signing secret |
| `CORS_ORIGIN` | Render | Vercel frontend origin(s), comma-separated |
| `VITE_API_URL` | Vercel | Render API public URL (no trailing slash) |

## Architecture

See `ARCHITECTURE.md` for a full breakdown of the token intelligence pipeline, services, API routes, and database schema.

## User preferences

- Keep existing pnpm workspace structure
- Do not migrate or replace the PostgreSQL database without explicit instruction
