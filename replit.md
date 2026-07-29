# Crypsor — Token Intelligence Platform

Solana token intelligence platform. Scans smart/KOL wallets via Helius, scores tokens by momentum/holders/volume, and surfaces them in a real-time dashboard.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 19 · Vite · TanStack Query · Tailwind v4 · Wouter |
| API server | Express v5 · TypeScript · pino |
| Database | PostgreSQL via Drizzle ORM |
| Queue | BullMQ + ioredis (Redis) |
| Monorepo | pnpm workspaces |

## How to run

Both workflows start automatically. They can also be restarted manually:

| Workflow | Command | Port |
|----------|---------|------|
| `artifacts/api-server: API Server` | `pnpm --filter @workspace/api-server run dev` | `$PORT` (8080 in dev) |
| `artifacts/crypsor: web` | `pnpm --filter @workspace/crypsor run dev` | auto-assigned |

The API server builds with esbuild (`build.mjs`) then runs `dist/index.mjs`. The frontend is served by Vite in dev mode.

## Required secrets

| Secret | Purpose |
|--------|---------|
| `AIVEN_DATABASE_URL` | PostgreSQL connection string (`postgres://…`) |
| `AIVEN_REDIS_URL` | Redis connection string (`rediss://…`) |
| `HELIUS_API_KEY` | Helius RPC — Solana wallet scanning |
| `GMGN_API_KEY` | GMGN token data API |
| `GMGN_PROXIES` | Comma-separated proxy list for GMGN requests |
| `SESSION_SECRET` | Express session signing |

## Architecture

See `ARCHITECTURE.md` for a full breakdown of the pipeline services, DB schema, API routes, and service timing.

Key services (all in-process with the API):
- **WalletScanner / Scheduler** — polls due wallets via Helius RPC
- **PriceService** — DexScreener + PumpFun + CoinGecko (20s cycle)
- **LifecycleEngine** — archives/revives tokens by market cap thresholds
- **MomentumEngine** — buy-count and volume scoring (5 min batch)
- **ProjectionEngine** — score projection (60s cycle)
- **HoldersRefresh** — holder snapshots from GMGN (per-token cooldown 5 min)
- **SSEGateway** — real-time push to frontend via Server-Sent Events

## Workspace layout

```
artifacts/
  api-server/   — Express API + pipeline (TypeScript → esbuild)
  crypsor/      — React frontend (Vite)
lib/
  db/           — Drizzle schema + pool (shared)
  api-zod/      — Zod schemas for API contracts (shared)
  api-client-react/  — TanStack Query hooks (shared)
```

## User preferences

- Keep the project's existing structure and stack — do not restructure or migrate it.
