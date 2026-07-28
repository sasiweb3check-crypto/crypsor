# Crypsor

A Solana token intelligence dashboard that monitors wallets, scores tokens in real-time, and surfaces KOL/smart-money signals.

## Stack

- **Frontend**: React + Vite + Tailwind + TanStack Query + Wouter (`artifacts/crypsor`)
- **Backend**: Express v5 + TypeScript + Drizzle ORM + PostgreSQL (`artifacts/api-server`)
- **Jobs/Queues**: BullMQ + Redis (`AIVEN_REDIS_URL`)
- **Database**: Aiven PostgreSQL (`AIVEN_DATABASE_URL`) — Replit's built-in `DATABASE_URL` also supported
- **Solana RPC**: Helius (`HELIUS_API_KEY`)
- **Shared libs**: `lib/db`, `lib/api-zod`, `lib/api-client-react`

## Running Locally on Replit

Both workflows start automatically:

| Workflow | Command |
|---|---|
| `artifacts/crypsor: web` | `pnpm --filter @workspace/crypsor run dev` |
| `artifacts/api-server: API Server` | `pnpm --filter @workspace/api-server run dev` |

The frontend is served at `/` and the API at `/api`.

## Required Secrets

| Secret | Purpose |
|---|---|
| `HELIUS_API_KEY` | Solana RPC + wallet scanning |
| `AIVEN_REDIS_URL` | BullMQ job queues + SSE pub/sub |
| `AIVEN_DATABASE_URL` | Primary Aiven PostgreSQL database |
| `SESSION_SECRET` | Express session signing |

## Database Schema

Push schema changes with:
```
pnpm --filter @workspace/db run push
```

## Architecture

See `ARCHITECTURE.md` for the full pipeline breakdown. Key points:
- No message broker — plain Node.js `EventEmitter` as internal bus
- All pipeline services run in the same process as the API server
- SSE replaces WebSockets for real-time push to the frontend
- Scan loop runs every 120s; price updates every 20s

## User Preferences
