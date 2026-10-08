# Crypsor

Mobile-friendly Solana wallet-buy intelligence: confirmed swap discovery, fixed
entry prices, current/peak sampled gains, complete source attribution and token
identity enrichment. Tokens are retained without quality scores or spend thresholds.

## Development

Node 22, pnpm 10.34.4, PostgreSQL 16+ (with pg_trgm).

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm test
# Isolated loopback test database only; never a production connection:
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/crypsor_scale_test pnpm test:integration
# Set DATABASE_URL for development, optionally HELIUS_API_KEY for live ingestion:
pnpm run start:render
```

`start:render` supervises separate API and worker Node processes on the existing
web service. `start:api` and `start:worker` let them run on separate services later.
The worker restarts with backoff; API health remains independent. Each process
uses its own bounded database pool (API 2, worker 2 by default). The worker starts
after the API has initialized PostgreSQL and opened its port. Temporary connection
exhaustion retries at startup; invalid credentials and TLS failures still fail.
Budget connections
for overlapping instances during Render deployments; PG_POOL_MAX overrides each pool.

Wallet addition, removal and manual scans are public at the user's request.
There is no password, sign-in, session cookie or `/api/auth`. Public mutations
have a modest per-IP rate limit. A Helius webhook secret authenticates provider
requests; it is unrelated to wallet management.

## Reliability and scaling

PostgreSQL is the durable job/outbox source of truth. Jobs are deduplicated,
leased and fenced, with bounded concurrency, global provider request limits,
exponential backoff, Retry-After handling, dead jobs and restart recovery.
With REDIS_URL configured, BullMQ dispatches the same durable jobs. Without
Redis, PostgreSQL consumers process them. Redis downtime cannot erase the outbox.
Use the same queue backend across worker instances. Lease recovery and an elected
scheduler permit multiple worker consumers without duplicate scheduling.

The first scan imports the latest 100 SWAP transactions, using Helius's type filter
so incoming transfers do not consume the scan window. A one-time migration rechecks
buy-less wallets; wallet cards show how many swaps were examined. Subsequent backlogs
are processed in bounded chunks, saving progress and retaining the stable cursor
until caught up. Idempotent `(wallet, mint, signature)` records handle retries
and webhook duplicates. A signed Helius enhanced-transaction webhook can accelerate
discovery, with polling retained for reconciliation.

The dashboard uses 25-row keyset pages (maximum 50), indexed database search and
server sorting. Sharded counters and per-wallet materialized statistics avoid
scanning the entire catalogue for every page. Leaders are queried independently
of the visible page. Summaries have a five-second API cache. Views trigger a
bounded refresh request for the visible tokens.

New/viewed tokens target 30-second price updates, recently bought tokens 90 seconds,
inactive tokens 15 minutes and tokens older than 30 days daily. These are targets;
actual freshness depends on provider quotas and queue capacity. Missing prices
remain unknown. Peak is the highest observed price since tracking, not a lifetime
all-time high or realized wallet PnL. Historical SOL buys use a clearly marked USD
price at detection; stablecoin purchase prices assume the stablecoin's USD peg.

Metadata has an independent Helius DAS / parsed on-chain RPC pipeline. It stores
name, symbol, image, description, decimals, raw supply, authorities, creators,
metadata URI and sources/timestamps where available. Market venues supply optional
website/social links. Missing data stays unknown, and authority absence is shown
only when the source confirms it. Metadata is enrichment, never a discovery gate.

Versioned `facts-v1` intelligence stores wallet overlap, buy count, entry provenance,
current/peak performance and momentum across timestamped observed samples. The
underlying buy facts remain available for future intelligence versions.

Recent charts are bounded JSON histories (30 active / six inactive samples).
Raw provider receipts have seven-day retention; normalized buys and tokens remain.
Optional S3-compatible archival uploads gzip receipts before allowing their deletion.
When archival is configured and unavailable, unarchived receipts are retained.
Use storage lifecycle policies and provision disk for the actual retention workload.

## Production

Required: AIVEN_DATABASE_URL (or DATABASE_URL), HELIUS_API_KEY; AIVEN_CA_CERT when
Aiven uses a private CA. Remote TLS certificates are verified. Optional:

- REDIS_URL: BullMQ backend; managed Redis should use TLS.
- PROCESS_ROLE: all (default), api or worker.
- HELIUS_WEBHOOK_SECRET: match the Authorization header configured in Helius.
- WALLET_CONCURRENCY (4), HELIUS_RPS (3), DEXSCREENER_RPS (2), SOLANA_RPC_RPS (1).
- WALLET_POLL_SECONDS (30), WALLET_PAGES_PER_JOB (3), PG_POOL_MAX.
- ARCHIVE_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY;
  optional ARCHIVE_ENDPOINT and ARCHIVE_PATH_STYLE for compatible object stores.

Set credentials securely in Render. Do not commit `.env` values. No password is
needed for wallet management. See docs/RENDER.md and docs/BENCHMARK.md.

`/api/healthz` verifies database/API readiness with one query, so deployment
readiness does not compete with worker monitoring for scarce connection slots.
`/api/monitoring` exposes queue depth, age, failures, stale wallets and pool pressure.
The dashboard warns on failed jobs, missing workers and stale prices. Retry terminal
jobs with `/api/jobs/retry`. No old Settings, Ward, scoring or trading APIs remain.
