# Validation record

Local validation on 24 October 2026. These results are measured development
checks, not a five-day live pilot, vendor billing audit or production approval.

| Check | Observed result |
| --- | --- |
| Original checkout preservation | Archive verified against all 11,101 files, including Git metadata and local outputs |
| Full TypeScript checks | API, React UI and Cloudflare packages pass |
| Node and frontend build | Real API bundle and Vite production assets build successfully |
| Cloudflare build | Pinned Wrangler 4.152.0 `deploy --dry-run` passes; nothing uploaded |
| Unit/ingress tests | 15 backend/parser/gate/provider tests + 14 ingress/queue tests pass |
| PostgreSQL/API tests | 7 functional subtests plus 5 provider integration tests pass (Node reports 13 including the parent test) |
| Browser | Chromium exercises all five pages, unlock, wallet addition, discovery, STOP_ALL/FULL, decisions and evidence; zero page errors; 390px mobile fits without horizontal overflow |
| Cloudflare local runtime | Actual local workerd + Queue + PostgreSQL emulator test passes for auth, persistence, duplicate deliveries, STOP_ALL and scheduled dispatch |
| Backup/restore | Custom-format `pg_dump` archive created; restored 17 Hunter tables into isolated `hunter_restore_test`; row counts and content fingerprints match |
| Reusable setup | Saved script executes frozen install, builds, tests and local migration without modifying manifests/lockfile |
| Development data | `hunter_dev` starts empty in WATCH_ONLY; synthetic fixtures are isolated in test databases |

Functional tests exercise authentication, no invented initial data, exact Solana
public-key length, three concurrent copies of one webhook, transfer/failed-swap
exclusion, source commitment upgrade, append-only evidence and decisions, rule
journal versions/rechecks, lease expiry/fencing, dead-job recovery, atomic daily
and monthly request caps, STOP_ALL before network I/O, Telegram allowlist, and
single-connection reconciliation interrupted by STOP_ALL.

The backup helper initially failed because a URL in `PGDATABASE` did not supply
the CLI connection parameters. It now parses the URI into libpq variables, keeps
passwords out of command arguments/logs, and requires verified TLS for remote
hosts. The corrected backup and actual restore/content comparison passed.

Browser captures are generated under ignored `test-results/`. The token-room
capture uses a **synthetic fixture in `hunter_browser_test`**, never real market
evidence. Run `pnpm test:browser` only against that isolated database and a local
API-only process, with `DATABASE_URL`, `HUNTER_API_TOKEN`, and optionally
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` configured. The runner resets only that
database's Hunter schema before each run. Chromium is a test prerequisite.

## Remaining external acceptance gates

- Existing Aiven service access, actual plan/storage/connection entitlement and
  origin TLS from a real Hyperdrive binding.
- Deployed Cloudflare Queue/Worker behavior, measured CPU budget and account
  usage, real Helius webhook delivery and signature reconciliation coverage.
- Authorized single-chat Telegram delivery and live latency/duplicate checks.
- Jupiter/Helius/Gemini credentials, service entitlement, actual response
  timestamps/quotas and vendor-side spend safeguards.
- Daily off-host backup scheduling and recovery after host loss. The local
  backup and restore drill do not establish an external recovery service.
- Five-day observations of 10–20 real watched wallets, missed-event denominator,
  latency percentiles, failed-job recovery and actual external cost records.

No vendor credentials were supplied, no remote deployment/push was performed,
no Telegram messages were sent, and no paid service was activated. Local
synthetic tests do not establish genuine market discoveries or production
reliability. Independent launch radar, advanced originality/social/MEV graphs,
surprise discovery and calibrated cohort predictions remain deliberate deferrals
described in the supplied plan. Unsupported raw program layouts (including a
full Pump instruction fallback) remain an explicit parser coverage gap.

See [Cloudflare runtime evidence](../cloudflare/LOCAL_VALIDATION.md) and
[deployment acceptance sequence](DEPLOYMENT.md).

## Mobile settings update

The subsequent mobile update adds encrypted database-backed Helius settings,
Solana-only network validation, source-backed token images/briefs/market facts,
search/risk filters and mobile cards. Full builds, 29 unit/ingress checks, the
14-test reported database suite (including parent) and Chromium five-page/mobile
checks pass. New settings tests use mocked read-only RPC responses to verify
authentication, validation of a replacement key rather than the old key, encrypted
storage, subsequent runtime loading, secret omission from status/audit, and
rejection of other network selections. No live provider key was supplied or
real metadata completeness certified. The added runtime settings table brings
the schema to 18 tables; the earlier 17-table restore result above predates it.
Render now runs jobs by default in start:api; disable using
HUNTER_DISABLE_BACKGROUND=true for sole-Cloudflare or API-only test setups.
