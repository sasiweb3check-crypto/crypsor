# HUNTER · private Solana research pilot

Hunter replaces the previous Crypsor application on branch `hunter/pilot-v0.2`.
It observes watched wallets and journals evidence-backed research. It has no
signing key, swap builder, order placement, GMGN integration, or execution path.
The supplied architecture v0.2 is preserved in [docs](docs/Hunter_Architecture_and_Pilot_Plan_v0_2.txt).
The referenced v0.1 documents were not supplied; their unspecified requirements
cannot be claimed as implemented.

## Run locally

Requirements: Node 22, pnpm 10.34.4 and PostgreSQL 16+.

```sh
pnpm install --frozen-lockfile
pnpm build
# Export DATABASE_URL and a random HUNTER_API_TOKEN (at least 24 characters)
# through your environment. .env.example documents configuration; .env is
# not automatically loaded by the production start command.
pnpm migrate
pnpm start
```

Open the application through your deployment's HTTPS origin. The unlock screen
uses your API token for private requests and keeps it only in this tab's session
storage. Clear it with Lock. Do not put credentials in links. All `/api/*` reads,
including health, require `Authorization: Bearer <HUNTER_API_TOKEN>`.

The application starts empty, in **WATCH_ONLY** mode. Add 10–20 watched Solana
addresses in Cabin/Memory. No example coins, performance figures or imagined
research are inserted. All configured wallets are discovery sensors without
spend thresholds or quality-based exclusion. Supported enhanced swap outputs
are token discoveries; other wallet activity is retained without claiming a buy.
Provider-reported swaps remain unverified until reconciled against finalized
signatures. Unsupported transaction layouts remain coverage gaps.

Frontend editing: `pnpm dev:web` starts Vite with `/api` forwarded to the API on
port 3000. Backend changes require `pnpm build:render` and a restart.
`pnpm start:api` and `pnpm start:worker` run separate roles. In production, do not
run both Cloudflare and Render background workers without checking connection,
quota and concurrency budgets.

## Components

| Component | Responsibility |
| --- | --- |
| `artifacts/api-server/src` | Private Express API, PostgreSQL persistence, durable jobs, bounded providers, rule gates and append-only journal |
| `artifacts/crypsor/src` | React/TypeScript Radar, Token Room, Decisions, Cabin/Memory, Operations |
| `cloudflare` | Authenticated webhook → Queue → Hyperdrive persistence; cron reconciliation and jobs independent of Render availability |
| `scripts` | Verified-TLS database backup and isolated restore drill |
| `tests` | Database/API/recovery/provider integration tests using clearly synthetic fixtures |

The retained artifact directory names are workspace paths, not the previous app.
All Hunter tables live in the separate `hunter` schema. Historical decisions,
evidence claims, outcomes and operator audit records reject updates/deletes.
Events are deduplicated by signature, instruction path and kind. Jobs use leases,
fenced completion, bounded retries and explicit dead-job replay. Raw source
payloads expire after seven days; normalized facts and source references remain.

Research separates **priority**, **structural risk**, and **confidence**. The
READ → THINK → GATE → JOURNAL → REVISIT loop always has a rule-only fallback.
Theses and counter-theses are hypotheses. Missing holder classifications,
creator affiliation, social evidence, originality, MEV attribution and cohort
calibration are UNKNOWN, never asserted as negative or invented.

## Operator modes and external calls

- **FULL:** bounded factual research and optional explicitly enabled free-tier AI.
- **WATCH_ONLY:** ingestion, reconciliation and factual discovery alerts; no new research.
- **PAUSE_RESEARCH:** retain incoming events; stop new research work.
- **STOP_ALL:** stop new ingestion/leasing/provider calls as far as in-flight work permits. Disable the upstream webhook and vendor billing manually when needed.

Changes require a reason and enter the operator audit log. STOP_ALL cannot recall
an already transmitted HTTP request or cancel vendor subscriptions.

Per-provider daily/monthly request caps and pacing reserve ledger capacity
*before* requests. Optional Gemini additionally needs explicit enablement,
free-tier confirmation, and a per-token cap. Paid-only social/graph/archival
sources are disabled. Local zero-cost estimates are not vendor billing receipts
or proof of free-tier entitlement. Use vendor-side limits; no paid plans are
automatically enabled.

Telegram is off by default. Enabling delivery requires the bot token, chat ID,
and a single matching allowed chat. Alerts have durable IDs. Ambiguous delivery
outcomes require manual verification to avoid automatic duplicate spam. This
repository's tests use fixtures and do not send real messages.

## Validate

```sh
pnpm build
pnpm test
# Destructive tests: ONLY the dedicated loopback hunter_pilot_test database.
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/hunter_pilot_test pnpm test:integration
pnpm backup
# Source writes must be paused for a stable row-content comparison.
# ONLY drops/restores the local hunter_restore_test schema.
RESTORE_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/hunter_restore_test pnpm restore:drill
```

Schedule `pnpm backup` daily outside the sleeping web service and store encrypted
copies off-host. The scripts do not pretend a local backup survives host loss.
Restore drills compare each table's row count and content fingerprint. Test
fixtures never enter the development database. See [validation](docs/VALIDATION.md)
for measured checks and remaining acceptance gates.

## Deploy only after configuration

See [deployment](docs/DEPLOYMENT.md) and [Cloudflare setup](cloudflare/README.md).
No deployment, webhook registration, paid upgrade or five-day live pilot is
implied by a local build. Cloudflare/Aiven/Helius/Telegram account access and
current quotas must be verified before enabling real traffic.
