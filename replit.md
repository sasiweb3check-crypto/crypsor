# Crypsor

Real-time cryptocurrency token intelligence and monitoring platform focused on Solana. Scans blockchain wallets for new trades, tracks token performance (market cap, price, gains), and aggregates holder intelligence (KOLs, smart money) via GMGN scraping.

## Stack

- **Frontend:** React + Vite + Tailwind CSS + TanStack Query + Radix UI + Wouter — `artifacts/crypsor/`
- **Backend:** Node.js + Express v5 + TypeScript + PostgreSQL (Drizzle ORM) — `artifacts/api-server/`
- **DB schema:** `lib/db/` — Drizzle schema + push scripts
- **Shared libs:** `lib/` (api-zod types, api-client-react)
- **Monorepo:** pnpm workspaces

## How to run

Both workflows start automatically:

| Workflow | Command |
|---|---|
| `artifacts/crypsor: web` | `pnpm --filter @workspace/crypsor run dev` |
| `artifacts/api-server: API Server` | `pnpm --filter @workspace/api-server run dev` |

The API server builds with esbuild (`build.mjs`) then runs `dist/index.mjs`.

## Required secrets

| Secret | Purpose |
|---|---|
| `HELIUS_API_KEY` | Solana RPC — wallet transaction scanning |
| `AIVEN_REDIS_URL` | BullMQ job queue (rediss:// TLS connection string) |
| `SESSION_SECRET` | Express session signing |

`DATABASE_URL` is provided automatically by Replit's built-in PostgreSQL.

## Database

Schema is managed via Drizzle ORM. To push schema changes to the dev database:

```bash
pnpm --filter @workspace/db run push
```

## Architecture

See `ARCHITECTURE.md` for the full pipeline breakdown (Price, Metadata, Lifecycle, Momentum, Intelligence engines, SSE gateway, wallet scheduler).

## User preferences

_None yet._
