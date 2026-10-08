# Crypsor

Clean development starting point. The page displays `clen`.

Deployment configuration and dependency lockfile are retained. Application logic,
background agents, database schemas, tests, and old assets have been removed.
The placeholder does not connect to the database or external APIs.

## Build and run

Use Node 22 and pnpm 10.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build:render
pnpm run start:render
```

Render uses one Node Web Service. The health check is `/api/healthz`, which
returns `{"ok":true}`. Existing Render environment values can stay configured.
No database data is deleted by this reset.
