# Crypsor

A Solana token intelligence platform that scans wallets for new tokens, scores them via a multi-factor pipeline, and surfaces high-quality picks in a real-time dashboard.

## Stack

- **Frontend:** React + Vite + Tailwind + TanStack Query + Wouter (`artifacts/crypsor`)
- **API Server:** Express v5 + TypeScript + Drizzle ORM + BullMQ (`artifacts/api-server`)
- **Database:** PostgreSQL (Aiven)
- **Queue/Cache:** Redis (Aiven)
- **External APIs:** Helius (Solana RPC + tx data), GMGN (token stats)

## How to run

Both services start automatically via Replit workflows:

| Workflow | Command |
|---|---|
| `artifacts/crypsor: web` | `pnpm --filter @workspace/crypsor run dev` |
| `artifacts/api-server: API Server` | `pnpm --filter @workspace/api-server run dev` |

The frontend is served at `/` and the API at `/api`.

## Required secrets

Set these in Replit Secrets before running:

| Secret | Description |
|---|---|
| `AIVEN_DATABASE_URL` | PostgreSQL connection string (`postgres://...?sslmode=require`) |
| `AIVEN_REDIS_URL` | Redis connection string (`rediss://...`) |
| `HELIUS_API_KEY` | Helius API key for Solana RPC + enhanced tx API |
| `GMGN_API_KEY` | GMGN token data API key |
| `GMGN_PROXIES` | Comma-separated proxy URLs for GMGN requests (optional) |
| `SESSION_SECRET` | Express session signing secret |

## Architecture

See `ARCHITECTURE.md` for a full breakdown of the token intelligence pipeline, services, API routes, and database schema.

## User preferences

- Keep existing pnpm workspace structure
- Do not migrate or replace the PostgreSQL database without explicit instruction
