# Render deployment

Use one Node Web Service, Node 22 and pnpm 10.

- Build: `pnpm install --frozen-lockfile --prod=false && pnpm run build:render`
- Start: `pnpm run start:render`
- Health check: `/api/healthz`

The page displays `clen`. No database or API credentials are needed by the placeholder.
Existing secure settings can remain for future development.
