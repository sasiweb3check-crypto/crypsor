# Crypsor — Token Intelligence

Solana token monitoring and intelligence platform. Watches wallet activity, scores tokens by momentum/holder quality, and surfaces early signals.

## Stack

- **Frontend**: React + Vite + Tailwind + TanStack Query + SSE (artifacts/crypsor)
- **Backend**: Express v5 + TypeScript + Drizzle ORM + PostgreSQL (artifacts/api-server)
- **Monorepo**: pnpm workspaces
- **Database**: Aiven PostgreSQL (schema managed by Drizzle)
- **Cache/queues**: Aiven Redis is configured for a future durable queue migration; the current pipeline still uses in-process queues

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

`AIVEN_DATABASE_URL` is the primary database connection and is stored as a Replit Secret. The app falls back to Replit's runtime-managed `DATABASE_URL` only when the Aiven secret is unavailable.

`AIVEN_REDIS_URL` is stored as a Replit Secret but is not used by the current implementation yet. The current pipeline queue and event bus are in-process.

## Schema

Push schema changes to the configured database:
```
pnpm --filter @workspace/db run push
```

## Architecture

See `ARCHITECTURE.md` for a full breakdown of the event-driven pipeline:
- Aiven PostgreSQL stores durable state; queue and event delivery currently use in-process memory
- Price cycle: 20s | Scheduler poll: 30s | Lifecycle: 2 consecutive checks to archive
- SSE replaces WebSockets for real-time push to the frontend

## User preferences

_No preferences recorded yet._
