# Crypsor

A Solana token intelligence and wallet monitoring platform. Scans watched wallets for new token buys, scores tokens using a multi-factor intel engine, and surfaces real-time data through a React dashboard.

## Stack

- **Frontend**: React + Vite + Tailwind CSS + TanStack Query (`artifacts/crypsor`)
- **API server**: Express v5 + TypeScript + Drizzle ORM (`artifacts/api-server`)
- **Database**: PostgreSQL (Replit-managed, via `DATABASE_URL`)
- **Queue / pub-sub**: Redis via `AIVEN_REDIS_URL` (BullMQ + ioredis)
- **Shared libs**: `lib/api-zod` (Zod schemas), `lib/api-client-react` (typed fetch hooks), `lib/db` (Drizzle schema + client)

## How to run

Both services are managed as Replit workflows and start automatically:

| Workflow | Command |
|---|---|
| `artifacts/crypsor: web` | `pnpm --filter @workspace/crypsor run dev` |
| `artifacts/api-server: API Server` | `pnpm --filter @workspace/api-server run dev` |

The frontend is served at `/` and proxies API calls to the backend at `/api`.

## Required secrets

| Secret | Purpose |
|---|---|
| `AIVEN_REDIS_URL` | Redis connection string (BullMQ queues) |
| `HELIUS_API_KEY` | Solana RPC / transaction data |
| `SESSION_SECRET` | Express session signing |

`DATABASE_URL` is provided automatically by Replit.

## Database

Schema is managed with Drizzle Kit. To push schema changes to the database:

```
pnpm --filter @workspace/db run push
```

## Package management

This is a pnpm workspace. Always use `pnpm` — never `npm` or `yarn`. Install all packages from the workspace root:

```
pnpm install
```

## User preferences

_None recorded yet._
