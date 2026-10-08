# Render

One paid always-on Node Web Service, Node 22, pnpm 10, one instance.

- Build: `pnpm install --frozen-lockfile --prod=false && pnpm run build:render`
- Start: `pnpm run start:render`
- Health: `/api/healthz`

Set `AIVEN_DATABASE_URL`, `HELIUS_API_KEY`, `WALLET_ADMIN_PASSWORD` and
`SESSION_SECRET` in Render's secure Environment settings. Add the service's
PEM CA as `AIVEN_CA_CERT` if its TLS certificate needs a private CA.
The application verifies database TLS certificates; do not disable verification.

Add wallets in the dashboard after signing in with `WALLET_ADMIN_PASSWORD`.
Only confirmed wallet swaps become token discoveries. No minimum spend or scoring.
The initial scan reads the latest 100 transactions, not a wallet's full history.
See README.md for performance and parser limits.

Do not set VITE_API_URL, CORS_ORIGIN or REDIS_URL. The frontend and API share an origin.
Use the new service at https://crypsor-xxgm.onrender.com; the earlier
https://crypsor.onrender.com remains a separate deployment and is not this dashboard.
