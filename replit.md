# Crypsor — Token Intelligence

Solana token monitoring and intelligence platform. Watches wallet activity, scores tokens by momentum/holder quality, and surfaces early signals.

## Stack

- **Frontend**: React + Vite + Tailwind + TanStack Query + SSE (artifacts/crypsor)
- **Backend**: Express v5 + TypeScript + Drizzle ORM + PostgreSQL (artifacts/api-server)
- **Monorepo**: pnpm workspaces
- **Database**: Replit built-in PostgreSQL (schema managed by Drizzle)

## How to run

Both workflows start automatically:

| Workflow | Command | URL |
|---|---|---|
| `artifacts/crypsor: web` | `pnpm --filter @workspace/crypsor run dev` | `/` |
| `artifacts/api-server: API Server` | `pnpm --filter @workspace/api-server run dev` | `/api` |

## Required secrets

| Key | Purpose |
|---|---|
| `HELIUS_API_KEY` | Solana RPC + wallet scan data |
| `SESSION_SECRET` | Session signing |
| `GMGN_PROXIES` | (optional) Proxy config for GMGN market data API |

`DATABASE_URL` is provisioned automatically by Replit.

## Schema

Push schema changes to the dev database:
```
pnpm --filter @workspace/db run push
```

## Architecture

See `ARCHITECTURE.md` for a full breakdown of the event-driven pipeline:
- No Redis — all state in PostgreSQL + in-process EventEmitter bus
- Price cycle: 20s | Scheduler poll: 30s | Lifecycle: 2 consecutive checks to archive
- SSE replaces WebSockets for real-time push to the frontend

## User preferences

_No preferences recorded yet._
