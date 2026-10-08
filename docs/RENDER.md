# Render deployment

Use the existing Node Web Service at https://crypsor-xxgm.onrender.com.
The older https://crypsor.onrender.com is a separate deployment.

- Build: `pnpm install --frozen-lockfile --prod=false && pnpm run build:render`
- Start: `pnpm run start:render`
- Health: `/api/healthz`
- Node 22, pnpm 10.34.4, paid always-on plan.

The existing service starts separate API and worker processes. No new paid service
or Redis instance is automatically created. Wallet management is public; old
WALLET_ADMIN_PASSWORD / SESSION_SECRET settings are unused and can be removed.

Set AIVEN_DATABASE_URL, HELIUS_API_KEY, and the complete Aiven PEM CA certificate
as AIVEN_CA_CERT when required. Certificate verification stays enabled. AIVEN URL
has precedence over DATABASE_URL. PostgreSQL must permit the trusted pg_trgm extension.
Only cw_* tables are migrated; old application tables are not read or deleted.

Small Aiven plans have limited PostgreSQL connection slots. Set PG_POOL_MAX=2
on the existing Render service if an older setting overrides the default. API and
worker then use at most four connections together; a rolling deployment can use
eight. Other services, SQL consoles and tools consume additional slots. The API
starts before its worker and retries temporary startup failures (including 53300).
If slots remain exhausted, close unused database clients or upgrade capacity.
The "no open ports" message follows database startup failure; keep Render's PORT.
Readiness performs one database query; worker state is available in the dashboard
and /api/monitoring.

For additional throughput, run the web service with PROCESS_ROLE=api and deploy
an independently provisioned Render background worker with PROCESS_ROLE=worker
and start `pnpm run start:worker`. Give both the same database and queue settings.
Adding that paid worker requires a hosting-plan choice; the current default does
not provision it. Budget total database pool connections across all instances.

Optional Redis/BullMQ: provision Redis separately and enter REDIS_URL securely
on API and workers. Use the same backend everywhere. PostgreSQL persists the outbox;
Redis unavailability is visible as unhealthy workers/queued jobs.

Optional Helius webhook: create an enhanced-transactions webhook for the tracked
addresses, URL https://crypsor-xxgm.onrender.com/api/webhooks/helius and Authorization
matching HELIUS_WEBHOOK_SECRET. Update the provider subscription when your wallet
list changes; polling continues to reconcile all tracked wallets even without it.
Helius subscription creation and its billing are not automated by this deployment.

Optional archival: configure ARCHIVE_BUCKET and AWS-compatible credentials/region
(or ARCHIVE_ENDPOINT for another compatible provider). Set bucket retention and
lifecycle policies. Failed uploads retain unarchived receipts.

Monitor /api/monitoring and the dashboard worker/queue indicators. Configure your
monitoring service to alert on missing workers, persistent dead jobs and queue age.
Defaults do not constitute a production quota or ten-million-token live-feed guarantee.
Provision Aiven storage, IOPS, backups and provider quotas for the measured workload.
