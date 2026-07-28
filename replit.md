# Crypsor — Token Intelligence Dashboard

A Solana token intelligence platform that monitors wallets, detects new token purchases, and runs a real-time analysis pipeline.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 19 · Vite · Tailwind v4 · TanStack Query · Wouter |
| Backend | Node.js · Express v5 · TypeScript |
| Database | PostgreSQL (Drizzle ORM) |
| Job queue | BullMQ (backed by Redis) |
| Real-time | SSE (Server-Sent Events) |

## Project structure

```
artifacts/
  api-server/   Express API + Token Intelligence Pipeline
  crypsor/      React/Vite frontend
lib/
  db/           Drizzle schema + migrations
  api-zod/      Shared Zod schemas
  api-client-react/  Type-safe React query hooks
```

## Running locally

Two workflows run in parallel:

- **API Server** — `pnpm --filter @workspace/api-server run dev`  
  Builds TypeScript with esbuild then starts the server.
- **Crypsor (frontend)** — `pnpm --filter @workspace/crypsor run dev`  
  Vite dev server with HMR.

## Required secrets

| Secret | Description |
|---|---|
| `AIVEN_REDIS_URL` | Redis connection string (`redis://` or `rediss://`) for BullMQ job queues and pub/sub |
| `HELIUS_API_KEY` | Helius API key for Solana RPC / wallet transaction data |

PostgreSQL is provided automatically by Replit (`DATABASE_URL`).

**Optional:**
- `GMGN_PROXIES` — comma-separated proxy URLs for GMGN metadata requests

## Database

Schema is managed with Drizzle Kit. To push schema changes to the database:

```bash
pnpm --filter @workspace/db run push
```

## User preferences

- Keep the existing pnpm monorepo structure
