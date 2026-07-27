# Crypsor — Architecture & Technical Review

> Stack: Node.js · Express v5 · TypeScript · PostgreSQL · Drizzle ORM · React · Vite · Tailwind  
> Pattern: Event-driven in-process pipeline · No Redis · EventEmitter bus · REST + SSE

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Server Entry Point](#2-server-entry-point)
3. [Token Intelligence Pipeline](#3-token-intelligence-pipeline)
4. [Wallet Scanner & Scheduler](#4-wallet-scanner--scheduler)
5. [Price Service](#5-price-service)
6. [Metadata Service](#6-metadata-service)
7. [Lifecycle Engine](#7-lifecycle-engine)
8. [Momentum Engine](#8-momentum-engine)
9. [Projection Engine](#9-projection-engine)
10. [Holders Refresh Service](#10-holders-refresh-service)
11. [Token Updater (SSOT)](#11-token-updater-ssot)
12. [Migration Checker](#12-migration-checker)
13. [SSE Gateway](#13-sse-gateway)
14. [Database Schema](#14-database-schema)
15. [API Routes](#15-api-routes)
16. [Frontend Data Refresh Intervals](#16-frontend-data-refresh-intervals)
17. [Service Timing Cheatsheet](#17-service-timing-cheatsheet)

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────┐
│                  Crypsor Frontend                    │
│        React · Vite · TanStack Query · SSE          │
└────────────────────────┬────────────────────────────┘
                         │ REST /api/* + GET /api/events (SSE)
┌────────────────────────▼────────────────────────────┐
│               Express API Server (:PORT)             │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │          Token Intelligence Pipeline         │   │
│  │                                              │   │
│  │  Scheduler ──► WalletScanner                │   │
│  │       │                                      │   │
│  │       ▼  token:bought (EventEmitter)         │   │
│  │  ┌────┴──────────────────────────────────┐  │   │
│  │  │  PriceService  MetadataService        │  │   │
│  │  │  LifecycleEngine  MomentumEngine      │  │   │
│  │  │  ProjectionEngine  HoldersRefresh     │  │   │
│  │  │  TokenUpdater  MigrationChecker       │  │   │
│  │  │  ImageService  SSEGateway             │  │   │
│  │  └───────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  PostgreSQL (Drizzle ORM)                           │
└─────────────────────────────────────────────────────┘
```

**Key design decisions:**
- No Redis — all state is PostgreSQL + in-process memory
- No message broker — plain Node.js `EventEmitter` as internal bus
- All pipeline services start inside the same process as the API server
- SSE replaces WebSockets for real-time push

---

## 2. Server Entry Point

**File:** `artifacts/api-server/src/index.ts` + `app.ts`

| Setting | Value |
|---------|-------|
| Port | `process.env.PORT` |
| Logger | `pino-http` |
| Middleware | `cors()`, `express.json()`, `express.urlencoded()` |
| Route prefix | `/api` (all routes via `routes/index.ts`) |
| Pipeline start | `startMonitor()` called at boot |

**Startup sequence** (`lib/monitor.ts`):
```
TokenUpdater → Scheduler → PriceService → MetadataService →
LifecycleEngine → MomentumEngine → ProjectionEngine →
ImageService → SSEGateway → MigrationChecker → HoldersRefresh
```

---

## 3. Token Intelligence Pipeline

**File:** `artifacts/api-server/src/lib/monitor.ts`

The pipeline is orchestrated by `startMonitor()`. It wires all services together and owns the main **scan loop**:

```
Boot
 └─► startMonitor()
       ├─ start all services (see §4–13)
       └─ scan loop: every 120,000ms (2 min), initial delay 5,000ms
             └─► runScan()
                   ├─ pull due wallets from Scheduler queue
                   ├─ call Helius/RPC for new transactions
                   └─ emit token:bought → triggers downstream services
```

**Event bus events:**

| Event | Emitted by | Consumed by |
|-------|-----------|-------------|
| `token:bought` | WalletScanner | MetadataService, MomentumEngine, ProjectionEngine, HoldersRefresh |
| `price:updated` | PriceService | ProjectionEngine, LifecycleEngine, SSEGateway |
| `holders:updated` | HoldersRefresh | TokenUpdater, SSEGateway |
| `token:updated` | TokenUpdater | SSEGateway |

---

## 4. Wallet Scanner & Scheduler

**Files:** `artifacts/api-server/src/pipeline/scheduler.ts`  
**Called by:** `lib/monitor.ts → runScan()`

### Scheduler polling
| Parameter | Value |
|-----------|-------|
| Queue poll interval | **30,000ms (30s)** |
| Wallets per cycle | All wallets where `next_scan_at <= now` |
| Priority ordering | `scan_priority` column (lower = higher priority) |

### Scan result & next-scan timing
| Outcome | Next scan delay |
|---------|----------------|
| Successful scan | **120,000ms (2 min)** |
| Failed — attempt 1 | 30,000ms |
| Failed — attempt 2 | 60,000ms |
| Failed — attempt 3 | 120,000ms |
| Failed — attempt 4 | 240,000ms |
| Failed — attempt 5+ | 300,000ms (cap) |

### Detection flow
```
Scheduler marks wallet as due
  └─► runScan() fetches transactions via Helius API
        └─► for each new token buy:
              ├─ upsert token into tracked_tokens
              ├─ insert into token_buys
              └─ emit token:bought
```

**Helius requirement:** `HELIUS_API_KEY` env var or `helius_api_key` row in `settings` table. Without it, scans run but find nothing.

---

## 5. Price Service

**File:** `artifacts/api-server/src/pipeline/price-service.ts`

| Parameter | Value |
|-----------|-------|
| Refresh cycle | **20,000ms (20s)** |
| Initial delay | **8,000ms** |
| Batch strategy | All active tokens in one batch |

### API fallback chain
```
DexScreener (batch)
  └─► if no price found AND chain === "solana":
        PumpFun API
          └─► if still missing:
                CoinGecko (via CG_PLATFORM mapping)
```

After a price update, emits `price:updated` → ProjectionEngine + LifecycleEngine react immediately.

---

## 6. Metadata Service

**File:** `artifacts/api-server/src/pipeline/metadata-service.ts`

| Parameter | Value |
|-----------|-------|
| Trigger | `token:bought` event OR startup missing-logo scan |
| Startup scan delay | **20,000ms** |
| Queue | `pipelineQueue` with `dedupKey: "metadata:<tokenId>"` |
| Max retries | 3 |
| Retry backoff | `1,500ms × (attempt + 1)` |

### API fallback chain
```
DexScreener (primary — name, symbol, logo, decimals)
  └─► if Solana token and missing data:
        PumpFun API (fallback)
```

---

## 7. Lifecycle Engine

**File:** `artifacts/api-server/src/pipeline/lifecycle-engine.ts`

Runs on every `price:updated` event + a full pass every **60,000ms (1 min)**.

### Status transition rules (market cap thresholds)

```
NEW (just detected)
  ├─► ACTIVE   if marketCap >= $50,000
  ├─► WATCH    if marketCap >= $10,000
  └─► ARCHIVE  if marketCap <  $4,500

ACTIVE / WATCH
  └─► ARCHIVE  if marketCap <  $4,500

ARCHIVE
  └─► REVIVED  if marketCap >= $12,000  ← revival threshold
```

| Status | Meaning |
|--------|---------|
| `new` | Freshly detected, not yet confirmed active |
| `active` | Strong market cap, high conviction |
| `watch` | Below active threshold, still worth monitoring |
| `archive` | Dropped below minimum — hidden by default |
| `revived` | Was archived but market cap recovered |
| `migrated` | Solana pump.fun token moved to Raydium |

---

## 8. Momentum Engine

**Files:** `artifacts/api-server/src/pipeline/momentum-engine.ts`  
`artifacts/api-server/src/lib/holder-intel.ts`

| Parameter | Value |
|-----------|-------|
| Full pass interval | **300,000ms (5 min)** |
| Also triggers on | `token:bought` event |

### Score formula (`holder-intel.ts`)
```
netFlow   = boughtMore + hold − soldPart − sold
flowTotal = boughtMore + hold + soldPart + sold

holderMomentumScore = (netFlow / flowTotal) × 100
```

### Score labels
| Score | Label |
|-------|-------|
| ≥ 8 | `strong` |
| ≥ 4 | `positive` |
| ≥ −3 | `neutral` |
| ≥ −7 | `negative` |
| < −7 | `weak` |

---

## 9. Projection Engine

**File:** `artifacts/api-server/src/pipeline/projection-engine.ts`

| Parameter | Value |
|-----------|-------|
| Full pass interval | **60,000ms (1 min)** |
| Initial delay | **3,000ms** |
| Also triggers on | `price:updated`, `token:bought` |

### Computed metrics
```
detectionGainPct  = ((currentPrice − detectedPrice) / detectedPrice) × 100
athGainPct        = ((athPrice − detectedPrice) / detectedPrice) × 100

buyPressure       = (m5 × 10) + (m15 × 5) + (m30 × 3) + (m1h × 2) + (m6h × 1)
```

---

## 10. Holders Refresh Service

**File:** `artifacts/api-server/src/pipeline/holders-refresh.ts`

| Parameter | Value |
|-----------|-------|
| Startup delay | **45,000ms (45s)** |
| Periodic cycle (active tokens) | **60,000ms (1 min)** |
| Initial discovery delay after `token:bought` | **12,000ms (12s)** |
| Per-token fetch cooldown | **300,000ms (5 min)** |
| Queue concurrency | **2** (simultaneous fetches) |

### Flow
```
token:bought event
  └─► schedule holder fetch in 12s (high priority)
        └─► after cooldown, fetch from GMGN
              └─► store snapshot in token_holder_snapshots
                    └─► emit holders:updated
                          └─► TokenUpdater aggregates + writes to tracked_tokens
```

**GMGN:** Scraped directly (no official API). Optional `GMGN_PROXIES` env var for proxy rotation.

---

## 11. Token Updater (SSOT)

**File:** `artifacts/api-server/src/pipeline/token-updater.ts`

- **Not a polling service** — purely event-driven
- Listens for `holders:updated` events
- Acts as the single source of truth (SSOT) for writing aggregated holder data back to `tracked_tokens`
- Also stores `raw_metadata` blobs
- Emits `token:updated` after writing → SSEGateway pushes to connected browsers

---

## 12. Migration Checker

**File:** `artifacts/api-server/src/pipeline/migration-checker.ts`

| Parameter | Value |
|-----------|-------|
| Check interval | **90,000ms (90s)** |
| Initial delay | **15,000ms** |
| Scope | Solana tokens with status `active` or `watch` |

### Detection sources (in order)
```
1. PumpFun API  →  check { complete: true } field
2. Helius RPC   →  inspect bonding curve PDA account
3. DexScreener  →  look for Raydium pair existence
```

When migration confirmed: token status set to `migrated`, `migrated: true` flag set.

---

## 13. SSE Gateway

**File:** `artifacts/api-server/src/pipeline/sse-gateway.ts`

| Parameter | Value |
|-----------|-------|
| Endpoint | `GET /api/events` |
| Content-Type | `text/event-stream` |
| Heartbeat ping | **25,000ms (25s)** |

### Events pushed to browser
| Event | Trigger |
|-------|---------|
| `token:updated` | TokenUpdater writes new state |
| `holders:updated` | HoldersRefresh completes a fetch |
| `token:deleted` | Token removed from DB |

---

## 14. Database Schema

**Location:** `lib/db/src/schema/`

### `walletdatasource`
| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `address` | text | wallet address |
| `label` | text | user-defined name |
| `chain` | text | solana / eth / base / etc |
| `next_scan_at` | timestamp | controls scan queue |
| `last_scan_at` | timestamp | |
| `scan_priority` | int | lower = higher priority |
| `health` | text | ok / degraded / down |

### `tracked_tokens`
| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `address` | text | contract address |
| `chain` | text | |
| `name` / `symbol` | text | |
| `logo_uri` | text | |
| `status` | text | new/active/watch/archive/revived |
| `migrated` | bool | pump.fun → Raydium |
| `detected_price_usd` | numeric | price at first detection |
| `current_price_usd` | numeric | live price |
| `market_cap_usd` | numeric | |
| `ath_market_cap_usd` | numeric | all-time high mcap |
| `detection_gain_pct` | numeric | gain since detection |
| `ath_gain_pct` | numeric | peak gain since detection |
| `buy_pressure` | numeric | weighted recent volume score |
| `holder_momentum_score` | int | −100 to +100 |
| `holder_momentum_label` | text | strong/positive/neutral/negative/weak |
| `holder_count` | int | GMGN aggregate total |
| `holder_kol_count` | int | KOL / renowned wallets |
| `holder_smart_count` | int | smart money wallets |
| `holder_top10_pct` | numeric | top-10 concentration % |
| `first_detected_at` | timestamp | |
| `last_buy_at` | timestamp | |
| `price_updated_at` | timestamp | |
| `raw_metadata` | jsonb | full DexScreener/PumpFun blob |

### `token_buys`
| Column | Notes |
|--------|-------|
| `wallet_id` | FK → walletdatasource |
| `token_id` | FK → tracked_tokens |
| `price_usd` | price at buy time |
| `tx_hash` | Solana/EVM tx hash |
| `bought_at` | timestamp |

### `token_holder_snapshots`
| Column | Notes |
|--------|-------|
| `token_id` | FK → tracked_tokens |
| `snapshot_at` | timestamp |
| `snapshot_type` | gmgn-live / cached |
| `holder_count` | total holders |
| `top_10_pct` | concentration |
| `smart_money_count` | |
| `dev_hold_pct` | |
| `total_pnl` | |

### `settings`
| Column | Notes |
|--------|-------|
| `key` | e.g. `helius_api_key` |
| `value` | stored value |
| `updated_at` | |

---

## 15. API Routes

**Base:** `/api`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health/healthz` | Health check |
| GET | `/settings` | List all settings |
| PUT | `/settings` | Upsert a setting |
| GET | `/wallets` | List monitored wallets |
| POST | `/wallets` | Add a wallet |
| DELETE | `/wallets/:id` | Remove a wallet |
| GET | `/tokens` | Paginated token list (sort, filter by status) |
| GET | `/tokens/:id` | Token detail |
| POST | `/tokens/:id/refresh` | Force metadata + price refresh |
| PATCH | `/tokens/:id/migrate` | Mark token as migrated |
| GET | `/tokens/:id/gmgn` | Live GMGN holder intelligence |
| GET | `/dashboard` | Summary stats (totals, lifecycle counts, hotCount) |
| GET | `/monitor/status` | Scanner status (running, lastScanAt, cycleCount) |
| POST | `/monitor/scan` | Trigger an immediate scan |
| GET | `/pipeline/health` | Per-service health (ok/degraded/down, latency) |
| GET | `/pipeline/status` | Full pipeline status |
| GET | `/assets/token/:id` | Token logo (proxied/cached) |
| GET | `/holders/list` | Paginated holder list (filter by label, search) |
| GET | `/holders/token/:tokenId` | Holders for a specific token |
| GET | `/holders/token/:tokenId/history` | Snapshot history |
| GET | `/holders/download` | Export holders as CSV |
| GET | `/queues` | Internal queue depths |
| GET | `/events` | SSE stream (real-time push) |

### `/api/tokens` query params
| Param | Options |
|-------|---------|
| `page` | integer |
| `limit` | integer (default 50) |
| `sort` | `name`, `detectionGainPct`, `athGainPct`, `marketCapUsd`, `holderMomentumScore`, `systemAge` |
| `order` | `asc`, `desc` |
| `status` | `new`, `active`, `watch`, `archive`, `revived`, `migrated` |

---

## 16. Frontend Data Refresh Intervals

**Location:** `artifacts/crypsor/src/`

### Dashboard (`pages/dashboard.tsx`)
| Query | `refetchInterval` | `staleTime` |
|-------|------------------|------------|
| `/api/dashboard` (summary stats) | **20,000ms** | 15,000ms |
| `/api/tokens` (live token list) | **20,000ms** | 10,000ms |
| `/api/tokens?sort=detectionGainPct` (top performers) | **30,000ms** | 15,000ms |

### Token Detail (`pages/token-detail.tsx`)
| Query | `refetchInterval` | `staleTime` |
|-------|------------------|------------|
| `/api/tokens/:id` (price, mcap, status) | **15,000ms** | — |
| `/api/tokens/:id/gmgn` (holder intel) | **60,000ms** | 15,000ms |

### Status Bar (`components/monitor-status-bar.tsx`)
| Query | `refetchInterval` | `staleTime` |
|-------|------------------|------------|
| `/api/monitor/status` | **15,000ms** | 10,000ms |

### Pipeline Health (`components/pipeline-health.tsx`)
| Query | `refetchInterval` | `staleTime` |
|-------|------------------|------------|
| `/api/pipeline/health` | **15,000ms** | 10,000ms |

### Layout sidebar (`components/layout.tsx`)
| Query | `refetchInterval` | `staleTime` |
|-------|------------------|------------|
| `/api/monitor/status` (mini — Helius badge) | **30,000ms** | 20,000ms |

### Holders Page (`pages/holders.tsx`)
| Query | `refetchInterval` | `staleTime` |
|-------|------------------|------------|
| `/api/holders/list` | — (manual only) | 30,000ms |

---

## 17. Service Timing Cheatsheet

```
Service                  Interval / Trigger
─────────────────────────────────────────────────────
Scan loop (monitor.ts)   120s  (+ 5s initial delay)
Wallet scheduler poll     30s
Price service             20s  (+ 8s initial delay)
Lifecycle engine          60s  (+ price:updated event)
Projection engine         60s  (+ 3s initial delay, + price:updated)
Momentum engine          300s  (+ token:bought event)
Holders refresh (cycle)   60s  (+ 45s initial delay)
Holders discovery         12s  after token:bought
Holders per-token cooldown 5min
Migration checker          90s  (+ 15s initial delay)
SSE heartbeat              25s

─────────────────────────────────────────────────────
Frontend polls (React)

Dashboard stats           20s
Dashboard token list      20s
Dashboard top performers  30s
Token detail (price)      15s
Token detail (GMGN)       60s
Monitor status bar        15s
Pipeline health           15s
Sidebar Helius badge      30s
─────────────────────────────────────────────────────

Wallet scan cooldown      120s (success) / 30s–300s (backoff)
```

---

*Generated from codebase review — July 2026*
