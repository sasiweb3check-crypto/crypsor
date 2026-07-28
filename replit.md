# Crypsor

Solana token intelligence dashboard. Monitors wallets via Helius, scores tokens through an in-process pipeline, and surfaces results in a real-time React UI.

## Stack

- **Frontend** — React 19 + Vite + Tailwind + TanStack Query + SSE (`artifacts/crypsor`)
- **API server** — Express v5 + TypeScript + Drizzle ORM + BullMQ (`artifacts/api-server`)
- **Database** — PostgreSQL via Aiven (Drizzle schema in `lib/db`)
- **Queue** — Redis via Aiven (BullMQ job queues)
- **Shared libs** — `lib/api-zod` (Zod schemas), `lib/api-client-react` (typed hooks), `lib/db` (Drizzle schema)

## Running locally on Replit

Both services start automatically via the configured workflows:

| Workflow | Command |
|---|---|
| `artifacts/crypsor: web` | `pnpm --filter @workspace/crypsor run dev` |
| `artifacts/api-server: API Server` | `pnpm --filter @workspace/api-server run dev` |

## Required secrets

| Secret | Purpose |
|---|---|
| `AIVEN_DATABASE_URL` | Aiven PostgreSQL connection string |
| `AIVEN_REDIS_URL` | Aiven Redis connection string (BullMQ) |
| `HELIUS_API_KEY` | Helius API key for Solana RPC / wallet scanning |
| `SESSION_SECRET` | Express session signing |

`DATABASE_URL` is also provided automatically by Replit's built-in PostgreSQL (unused when `AIVEN_DATABASE_URL` is set).

## DB schema

Push schema changes to the Aiven database:

```bash
pnpm --filter @workspace/db run push
```

## User preferences
