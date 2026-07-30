# Crypsor — Token Intelligence Platform

Solana token intelligence platform. Scans smart/KOL wallets via Helius, scores tokens by momentum/holders/volume, and surfaces them in a real-time Pro Caller dashboard.

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
- **ProScanner + ProSnapshots** — Pro Caller tier: qualifies tokens, snapshots ATH performance every 5 min
- **CallerAlerts** — Telegram alerts when tokens qualify or hit milestones
- **SSEGateway** — real-time push to frontend via Server-Sent Events

## Workspace layout

```
artifacts/
  api-server/   — Express API + pipeline (TypeScript → esbuild)
    src/
      pipeline/
        lifecycle-engine.ts   — status transitions (new/active/watch/archive/revived/dumped)
        pro-scanner.ts        — qualifies tokens for Pro Caller tier
        pro-snapshots.ts      — snapshots ATH + milestone tracking every 5 min
        caller-alerts.ts      — Telegram alerts for calls + milestone hits
      routes/
        caller.ts             — /api/caller/* (legacy caller endpoints)
        pro.ts                — /api/pro/* (Pro tier endpoints)
  crypsor/      — React frontend (Vite)
    src/
      pages/
        caller.tsx            — Main dashboard: Pro stats, quality tokens, history
        token-detail.tsx      — Per-token intel, GMGN, security, history, milestones
        settings.tsx          — Telegram config + app settings
lib/
  db/           — Drizzle schema + pool (shared)
    src/schema/
      pro_calls.ts            — One record per Pro-called token (immutable entry point)
      pro_snapshots.ts        — Periodic ATH/MC snapshots per Pro call
      tracked_tokens.ts       — Main token table with lifecycle status
  api-zod/      — Zod schemas for API contracts (shared)
  api-client-react/  — TanStack Query hooks (shared)
```

---

## Pro Caller System — Design

### Token Lifecycle Status
`tracked_tokens.status` valid values:
- `new` — just detected, no price data yet
- `active` — MC ≥ $50K
- `watch` — MC $10K–$50K
- `archive` — MC < $4.5K for 2 consecutive price cycles (hysteresis)
- `revived` — previously archived, MC recovered to ≥ $8K
- `dumped` — dropped >75% from ATH (smart archive — distinct from low-MC archive)

### Pro Call Entry Point (Immutable)
When a token first qualifies (Intel ≥80, KOL/Smart ≥1, MC ≥$5K), a `pro_calls` row is created with:
- `called_mc_usd` — market cap at call time. **Never updated. All P&L calculated from this.**
- `called_at` — timestamp of qualification
- `called_intel_score`, `called_kol_count`, `called_smart_count`

All future metrics anchor to `called_mc_usd`:
- Gain % = `(current_mc - called_mc) / called_mc * 100`
- ATH multiple = `max(historical_mc) / called_mc`
- Milestone hits: 2x, 3x, 5x, 10x, 100x

### Milestone Tracking
`pro_calls` columns (boolean + timestamp pairs):
- `hit_2x` / `hit_2x_at` — token reached 2× called MC
- `hit_3x` / `hit_3x_at`
- `hit_5x` / `hit_5x_at`
- `hit_10x` / `hit_10x_at`
- `hit_100x` / `hit_100x_at`

Set by `pro-snapshots.ts` whenever `ath_multiple` crosses a new threshold.

### Pro Score & Quality Labels
- **Very Good** — Pro Score ≥ 75
- **Good** — Pro Score 55–74
- **Below** — Pro Score < 55

Score components: Intel strength · MC/Liq ratio · ATH multiple · Gain momentum · Run status · Risk/security

### Win Rate Definition
A call is a **win** if `ath_multiple ≥ 2` (token reached at least 2× the called MC).
Win rate = wins / total Pro calls.

### Smart Archiving / Dump Detection
Tokens are marked `dumped` when:
- Current MC < 25% of ATH MC (i.e., >75% drawdown from ATH), **and**
- ATH was at least 1.5× called MC (confirmed the token had a real run)

Tokens are marked `archive` (standard) when:
- MC < $4.5K for 2 consecutive price-update cycles (no ATH context)

Archived/dumped tokens are **never deleted**. They remain in `pro_calls` and contribute to all-time stats.

### Caller History — Persistence Rule
`/api/caller/history` and `/api/pro/history` return **all** ever-called tokens, regardless of current MC.
The current-MC ≥ $5K filter must only apply to the **live tokens** endpoint (`/api/caller/tokens`), never to history.

---

## Pending Implementation Plan

### P1 — Fix Token Persistence (Root Cause: 22→20 Drop) ✅ Critical
**File:** `artifacts/api-server/src/routes/caller.ts`
- Remove `.filter(t => currentMc >= MIN_CALLED_MC)` from the `GET /caller/history` handler (~line 207)
- History must show all historically-called tokens, not just those with current MC ≥ $5K
- The live `/caller/tokens` endpoint can keep the MC filter

### P2 — Milestone Tracking Columns
**Files:** `lib/db/src/schema/pro_calls.ts`, `artifacts/api-server/src/pipeline/pro-snapshots.ts`
- Add 10 new columns to `pro_calls`: `hit_2x boolean`, `hit_2x_at timestamp`, `hit_3x boolean`, `hit_3x_at timestamp`, `hit_5x boolean`, `hit_5x_at timestamp`, `hit_10x boolean`, `hit_10x_at timestamp`, `hit_100x boolean`, `hit_100x_at timestamp`
- Write a DB migration (`ALTER TABLE pro_calls ADD COLUMN …`)
- In `pro-snapshots.ts`: after computing `athMultiple`, check each threshold — if newly crossed, `UPDATE pro_calls SET hit_Nx = true, hit_Nx_at = NOW()`
- Expose milestones in `GET /api/pro/history` and `GET /api/pro/stats` responses

### P3 — Dump Status + Smarter Archiving
**Files:** `artifacts/api-server/src/pipeline/lifecycle-engine.ts`, `lib/db/src/schema/tracked_tokens.ts`
- Add `dumped` to the `LifecycleStatus` type
- In `lifecycle-engine.ts`: after updating ATH MC, compute drawdown = `(athMc - currentMc) / athMc`. If drawdown > 0.75 and `athMc > calledMc * 1.5`, transition to `dumped`
- `tracked_tokens` has `ath_market_cap_usd` already — use it for the calculation

### P4 — Win Rate Fix
**File:** `artifacts/api-server/src/routes/caller.ts`
- Stats query: change win condition from `ath_gain_pct > 0` to `ath_multiple >= 2`
- This aligns caller stats with Pro stats (both use ≥2x as the win threshold)

### P5 — Frontend: History Toggle + Milestone Stats
**File:** `artifacts/crypsor/src/pages/caller.tsx`
- Add "Live Quality" / "All Time" tab toggle on the history section
- "Live Quality" = current behaviour (quality filter applied)
- "All Time" = shows all historical calls including dumped/archived
- Stats row: add 2x / 3x / 5x / 10x hit counts (pull from `/api/pro/stats`)

### P6 — Token Detail: Milestone Tracker
**File:** `artifacts/crypsor/src/pages/token-detail.tsx`
- Add a milestone timeline section: shows when (date/time) 2x, 3x, 5x, 10x were hit
- Pull from pro_calls data returned in token detail endpoint

---

## User preferences

- Keep the project's existing structure and stack — do not restructure or migrate it.
- No DB deletions — all called tokens are permanent records.
- `called_mc_usd` is immutable — never update it after the initial Pro call record is created.
- Win = ≥2x from called MC (not just any positive ATH gain).
- History endpoints must not filter by current MC — only live-token endpoints may do that.
