# Local edge validation record

Executed on 2026-10-24 with Node 22.23.4 and Wrangler 4.152.0. These checks used only synthetic fixtures in an isolated `hunter_edge_test` loopback PostgreSQL database. They do not establish a deployed service, live-chain coverage, vendor quota eligibility, a latency guarantee, or Aiven TLS verification.

- TypeScript check passed.
- Fourteen Node fixture tests passed, including unauthorized intake, malformed/oversized bodies, STOP_ALL, queue failure/retry/ack, and a mode-switch race that must retry rather than discard events.
- Pinned Wrangler deployment **dry-run** passed; final bundle was approximately 249 KiB / 55 KiB gzip. Nothing was uploaded.
- Real local `workerd` started with `nodejs_compat`, local Queue and Hyperdrive simulation connected to PostgreSQL. This caught a global-scope random generation error in the shared worker; the backend made worker ID initialization lazy, then the runtime started successfully.
- Secured health returned 401 without a bearer token and 200 with a local test token and live database.
- Synthetic enhanced webhook returned 202. Local Queue consumer persisted one `WALLET_ACTIVITY` and one `SWAP_BUY`, both accurately marked `provider_reported`.
- The separate dispatch tick processed the alert job; without Telegram configuration the alert remained `awaiting_configuration`. No Telegram message or other external notification was sent.
- Repeated delivery retained exactly two events and one alert, confirming deduplication through the actual local Queue/database path.
- STOP_ALL returned 503 at ingress and blocked scheduled work. Resumption processed later duplicate messages without adding events.
- The local scheduled handler completed; no Helius key was configured, so no live reconciliation request occurred.
- Local runtimes started for these checks were stopped. The dedicated synthetic test database remains separate from the development database.

Wall-clock timings in Wrangler logs ranged from tens of milliseconds to seconds during local startup; no invocation CPU measurements were collected. The Workers Free CPU budget, real origin certificate validation, remote dead-letter retention/re-drive, live Helius reconciliation, and live Telegram delivery still require a configured staging pilot.
