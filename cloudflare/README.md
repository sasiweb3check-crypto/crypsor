# Hunter always-on intake

This Worker receives Helius enhanced webhook deliveries at `POST /webhooks/helius`, authenticates the configured **exact Authorization header**, checks `hunter.operator_state`, and enqueues a maximum 96 KiB / 10-transaction envelope before returning 202. It performs no AI or normalization on the HTTP path. Do not send a Bearer prefix unless it is part of the Helius configured secret. Secrets must contain at least 24 characters.

The Queue consumer connects through Hyperdrive with a single connection, invokes the same idempotent ingestion code as the API, and acknowledges only after persistence and background dispatch succeed. A separate tick handles one durable database job. Duplicate queue deliveries retain original event IDs. Helius shared-header authentication does not prove per-request freshness; processing deduplication resists replay amplification in memory, but does not prevent repeated intake/queue costs.

Cron schedules wallet reconciliation and overdue jobs every two minutes, with a 20-wallet pilot batch limit. Database cursors/checkpoints are authoritative. It dispatches bounded queue ticks directly, so the event path and basic background jobs do not depend on a sleeping Render API. Mode `STOP_ALL` refuses new ingress and retries existing queue messages without executing jobs; the provider webhook may still attempt delivery until disabled in Helius. Configure vendor controls separately.

## Configure, then validate before a real pilot

Nothing has been deployed by creating these files. No Cloudflare, Aiven, Helius or Telegram credentials are included.

1. Create the existing Aiven database's `hunter` schema through the server migration command. Give the origin login only required access to this schema. Confirm the service's free quota and connection budget; this consumer uses one connection per invocation, not a global one-connection ceiling. Limit competing consumer/Render concurrency at the account and pool level to remain below Aiven's 20-connection limit.
2. Create Cloudflare Queues `hunter-events` and `hunter-events-dead`. Inspect the current account's retention and free quotas; the pilot design assumes up to 24 hours, not indefinite retention. The sample caps consumer concurrency at two (plus other services must fit the account budget) and uses `max_batch_size=1`, five retries, and a dead-letter destination. Replay dead letters through this consumer only after fixing the cause. Pausing for long enough can exhaust retries/retention; reconcile Helius after resumption.
3. Create a Hyperdrive binding to Aiven using TLS with **certificate and hostname verification**. Supply the Aiven CA through supported Hyperdrive origin settings if needed. Do not use an insecure SSL override. The generated local Hyperdrive connection string is a proxy endpoint; origin TLS is controlled and must be verified in Hyperdrive settings. Replace `REPLACE_WITH_VERIFIED_HYPERDRIVE_ID` in `wrangler.toml`. Query the secured `/healthz` endpoint after deployment to test actual origin connectivity. A successful local PostgreSQL test does not verify Hyperdrive/Aiven TLS.
4. Set Worker secrets using secure Cloudflare settings or `wrangler secret put`: `HELIUS_WEBHOOK_SECRET`, `HUNTER_API_TOKEN`; optional provider keys follow the root `.env.example`. `TELEGRAM_CHAT_ID` must equal the single allowed chat. Bind no signing key. Node compatibility after the configured compatibility date populates string Worker variables/secrets into `process.env`; shared provider modules use these supported bindings. Hyperdrive itself is passed explicitly.
5. Configure Helius to send enhanced transactions only for the 10–20 watched wallets to the real deployed Worker URL. Set its Authorization header to the exact webhook secret. The body limit intentionally rejects large batches; configure a batch size up to 10 and confirm real serialized transaction sizes before enabling all addresses. If real deliveries exceed these bounds, split deliveries upstream or implement streaming/chunking after measuring CPU and queue size limits.
6. Run the build and fixture tests below, then a staging controlled delivery, duplicate replay, failed-database retry, STOP_ALL/resume, durable cursor catch-up, Telegram allowlist, certificate validation, and dead-letter recovery drill. Measure Cloudflare CPU in the real runtime before claiming it meets the Workers Free CPU budget. Local Node unit tests are not a free-tier performance benchmark.

## Local checks

From repository root, with the pinned Node/pnpm active:

```sh
pnpm --filter @workspace/hunter-edge typecheck
pnpm --filter @workspace/hunter-edge build
pnpm --filter @workspace/hunter-edge test
```

`build` runs the pinned Wrangler deployment dry-run, bundling the real Worker entry and shared services with `nodejs_compat`. It does not upload or validate remote bindings. The dry-run accepts the explicit placeholder Hyperdrive ID; a real deployment still requires replacing it with a verified binding and staging tests. No real deployment was performed.

`GET /healthz` requires `Authorization: Bearer <HUNTER_API_TOKEN>` and tests the database and current operator mode. Do not put tokens in URLs, copy them into logs, or expose an unauthenticated dynamic API. UI hosting and the private Render API are separate from this intake endpoint.
