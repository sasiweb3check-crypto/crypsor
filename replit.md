# Crypsor

Solana token intelligence dashboard. Scans tracked wallets for new token buys via Helius, enriches each token with price/metadata/holder data, and surfaces it in a real-time React UI.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 19 · Vite 7 · TailwindCSS 4 · TanStack Query · Wouter |
| API Server | Node.js · Express v5 · TypeScript · ESBuild |
| Database | PostgreSQL (Replit built-in) · Drizzle ORM |
| Job queues | BullMQ · ioredis |
| External | Helius RPC (Solana), Aiven Redis, GMGN proxies (optional) |

## How to run

Both services start automatically via Replit workflows:

- **Frontend** (`artifacts/crypsor: web`) — Vite dev server, preview at `/`
- **API Server** (`artifacts/api-server: API Server`) — Express server, mounted at `/api`

### Required secrets

| Secret | Purpose |
|--------|---------|
| `HELIUS_API_KEY` | Solana RPC / wallet scanning |
| `AIVEN_REDIS_URL` | BullMQ job queues |

The Replit built-in PostgreSQL is used automatically via `DATABASE_URL` (runtime-managed — do not set manually).

### Schema

Push the Drizzle schema to the database:

```bash
pnpm --filter @workspace/db run push
```

## Monorepo layout

```
artifacts/
  crypsor/        # React/Vite frontend
  api-server/     # Express API + token intelligence pipeline
lib/
  db/             # Drizzle schema + client (@workspace/db)
  api-zod/        # Shared Zod schemas (@workspace/api-zod)
  api-client-react/ # TanStack Query hooks (@workspace/api-client-react)
```

## User preferences

- Keep existing project structure and stack — do not restructure or migrate.
