# Deploy Crypsor on Render

One **Web Service** runs the Express API, the funnel loops, and the desk SPA
on the same origin (`https://<service>.onrender.com`). That is the setup this
app needs: the scanner is an in-process `setInterval` loop, so it has to live
in a long-running Node process — not a serverless function.

## 1. Create the service

**Blueprint (recommended)**

1. Push this repo to GitHub (this branch or `main` after merge).
2. Open [Render → New Blueprint](https://dashboard.render.com/select-repo?type=blueprint).
3. Select the `crypsor` repo. Render reads `render.yaml`.
4. When prompted, set the secrets below.
5. Create Blueprint. First deploy takes a few minutes (pnpm install + API + Vite build).

**Manual Web Service**

1. Render Dashboard → **New +** → **Web Service** → this repo.
2. Runtime: **Node**.
3. Build command: `pnpm install --no-frozen-lockfile --prod=false && pnpm run build:render`
4. Start command: `pnpm run start:render`
5. Health check path: `/api/healthz`
6. Instance type: **Starter** (always-on). Keep **1** instance.
7. Add the env vars below.

## 2. Environment variables

| Key | Required | Notes |
|---|---|---|
| `AIVEN_DATABASE_URL` | yes | Postgres URL (`sslmode=require`). `DATABASE_URL` also works. |
| `HELIUS_API_KEY` | yes | Wallet buy discovery |
| `GMGN_API_KEY` | optional | Holder intel |
| `GMGN_PROXIES` | optional | Proxy list for GMGN |
| `SESSION_SECRET` | auto | Blueprint generates one |
| `CRON_SECRET` | auto | Protects `/api/cron/tick` |
| `TELEGRAM_PUSH_ENABLED` | optional | default `true`; bot token / chat id live in Settings |
| `VITE_API_URL` | **omit** | Same-origin `/api`. Setting this usually breaks the desk. |
| `CORS_ORIGIN` | omit | Only if the desk is on a different host |
| `REDIS_URL` | **omit** | Not needed on 1 instance. In-memory TTL + SSE is the cache. Add Redis only if you ever run 2+ processes. |

Do **not** set `VITE_API_URL` on this service. The desk is built and served
from the same process, so the browser should call `/api` on the current host.

## 3. After deploy

1. Open `https://<service>.onrender.com` — you should see the desk.
2. `https://<service>.onrender.com/api/healthz` → `"ok": true` and a `db` ping.
3. Settings → paste Helius (and Telegram) if they are not already in the DB.
4. Confirm the ward board is moving (new patients / scans). Wallets live in Settings.

Custom domain: Render → service → **Custom Domains**. Same-origin still applies.

## 4. Plan / 24/7

| Plan | Pipeline |
|---|---|
| **Starter** (blueprint default) | Always on. No keepalive needed. |
| Free | Sleeps after ~15 min idle. Point cron-job.org at `GET /api/keepalive` every 1–2 min, or upgrade. |

Do not scale above **1** instance. Two Node processes would run two funnels
against the same DB (duplicate alerts).

## 5. GitHub keepalive (optional)

`.github/workflows/keepalive.yml` is a safety net for serverless. On Render
Starter you can disable it, or set repo variable `APP_URL` to the Render URL
if you stay on the free instance.

## Local same shape as Render

```bash
pnpm install
export AIVEN_DATABASE_URL=postgres://...
export HELIUS_API_KEY=...
export PORT=3000
pnpm run build:render
pnpm run start:render
# desk + API at http://localhost:3000
```
