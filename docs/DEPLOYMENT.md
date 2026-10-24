# Pilot deployment and acceptance runbook

The uploaded v0.2 plan is a design target. Its five days are an acceptance
sequence, not a promise that elapsed time or vendor entitlements were verified.
The current implementation is private and read-only. Do not add signing secrets.

## Existing app and rollback

Before replacement the original checkout, Git metadata, dependencies and local
outputs were archived at `/workspace/backups/crypsor-before-hunter.tar.gz` and
verified against all 11,101 files. Work is on `hunter/pilot-v0.2`; existing
Git history and origin remain. No remote push or Render redeploy was performed.
Do not unpack the archive over uncommitted Hunter work. Extract to a separate
recovery location, compare files, and restore only the desired version.

## PostgreSQL

Use PostgreSQL 16+ and a separate `hunter` schema in the existing Aiven service.
Run `pnpm migrate` with an appropriate migration role. Give the application a
role limited to its own schema, sequences and functions; do not use a superuser
in production. The local test login is not production access guidance.

Remote Node PostgreSQL connections remove URL TLS overrides and always verify
certificates. If Aiven requires a private CA, supply `AIVEN_CA_CERT` securely.
Hyperdrive origin TLS must separately enforce certificate/hostname verification;
a local Node connection does not establish Hyperdrive readiness.

Budget all concurrent Node instances, Cloudflare consumers, Hyperdrive origin
pools, migrations and maintenance against the actual account limit. Node pools
allow 1–4 connections (default 2), but this is not a global account semaphore.
Set account/service concurrency limits and test overload before widening.

Monitor schema bytes and source/job retention in Operations against the actual
1 GB free allowance. Append-only memory grows; size retention to measured usage.
Archive raw source payloads before extending seven-day retention. Never silently
delete historical judgments to make a quota appear healthy.

## Render UI/private API

Keep the existing deployed app unchanged until reviewing and pushing this branch.
The provided `render.yaml` is an opt-in blueprint, not an action performed here.
Use `pnpm install --frozen-lockfile && pnpm build:render` to build, and
`pnpm start:api` to serve the private API and static frontend. Set the database
binding and random `HUNTER_API_TOKEN` in Render's secure settings.

The token unlock screen does not make the public HTML confidential; research
data is protected by authenticated APIs. Use HTTPS and rotate leaked tokens.
Authenticated `/api/healthz` is a functional readiness check; don't remove its
auth just to satisfy an unauthenticated platform health probe. The blueprint
omits a healthCheckPath; configure an authenticated check outside Render if needed.

Render Free can sleep. It is suitable for the review UI, not the sole ingress or
reconciliation worker. Static UI hosting is possible, but a separate origin needs
an intentional authenticated API proxy/CORS configuration; this build defaults
to same-origin private API access.

## Always-on event path

Follow `cloudflare/README.md`. Create real Queues and Hyperdrive bindings, run
migrations once, and validate TLS from Hyperdrive to Aiven. Configure the exact
webhook secret and selected wallet addresses in Helius. Consumer and cron operate
without a live Render process. The mobile pilot now runs background jobs in the Render process, even with start:api. Set HUNTER_DISABLE_BACKGROUND=true when Cloudflare becomes the sole background processor. Render Free sleep still interrupts these jobs. Do not run both workers indiscriminately.

Free-tier CPU, account quotas, queue retention, Helius replay coverage and API
entitlements require current vendor confirmation and staging measurements.
Wrangler dry runs and local fixture tests do not establish those results.

## Pilot acceptance sequence

1. Confirm account plans and restore access. Run secured API/DB checks and schema
   migration. Keep production unchanged until approved through your normal review.
2. Deliver a real known wallet transaction via Helius → Worker → Queue → Aiven.
   Replay it and verify one event/alert ID. Enable Telegram only after matching
   the single-user allowlist; verify one real delivery and its message ID.
3. Check exact mint identity and independently timestamped market data. Keep
   unknown provider update timestamps visible. Sample parsed holder owners and
   distinguish liquidity accounts before interpreting concentration.
4. Enable FULL, inspect thesis/counter-thesis, cited evidence and unknowns; cause
   a genuine evidence change and inspect the appended correction/revisit.
5. Pause source writes, create/export a backup, restore to an isolated database,
   compare content, force a worker lease expiry and replay a dead job. Measure
   event arrival latency, signature coverage, provider usage and external billing.

Record real latency percentiles and missed-event denominators. Never present
synthetic fixture timestamps as live performance, or local zero estimates as
confirmed vendor spend. A 10–20-wallet trial must precede wider coverage.

## Deliberate limits

Independent launch radar, ecosystem-wide originality, paid social collection,
advanced funding/MEV graph inference, statistically calibrated cohorts and
automated surprise discovery remain deferred. The pilot stores relevant unknowns
and bounded evidence for later research. It does not make guaranteed price or
sub-15-second alert predictions. Missing v0.1 specifications remain unreviewed.
