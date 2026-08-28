# Running Crypsor 24/7

## Render Starter (recommended)

`render.yaml` deploys one always-on Node service. The funnel `setInterval`
loops keep running with no extra pinger. See [RENDER.md](./RENDER.md).

Skip the rest of this doc unless you are on **Render free** or **Vercel Hobby**.

## Why the system stops on serverless / free compute

Vercel serverless functions only execute **while handling a request**. The
scanner pipeline (wallet monitor → pump scanner → GEM engine → alerts) runs
inside the API function instance, and Vercel **freezes that instance when no
HTTP traffic arrives**. Vercel Hobby crons are daily-only, so they can't keep
it alive either.

Render **free** web services spin down after ~15 minutes idle — same symptom.

Observed effect (Vercel): the engine wrote snapshots while the desk was open,
then went completely silent (e.g. Aug 5 05:00 → Aug 6 04:30 UTC: zero activity)
until the next request instantly woke it.

## Wake endpoints (already built in)

| Endpoint | Auth | What it does |
|---|---|---|
| `GET /api/keepalive` | public, rate-limited (45s) | full pipeline tick, wallet scan at most every 2 min |
| `GET /api/cron/tick` | `Authorization: Bearer <CRON_SECRET>` | full pipeline tick incl. wallet scan |

One tick = wallet scan (Helius) + pump/GEM refresh + desk price refresh.
Pings every minute ≈ the engine effectively never sleeps.

## Recommended setup for free hosts

### 1. Primary: cron-job.org — every minute
1. Create a free account at https://cron-job.org
2. In Render/Vercel → Environment Variables add
   `CRON_SECRET` = any long random string → Redeploy
3. cron-job.org → **Create cronjob**:
   - URL: `https://<your-host>/api/cron/tick`
   - Schedule: **every 1 minute**
   - Advanced → Headers: `Authorization: Bearer <your CRON_SECRET>`
   - Request timeout: 30s (a tick can take a few seconds)
4. Save. Check the job log shows HTTP 200 with `"walletScan":"ok"`.

### 2. Backup: UptimeRobot — every 5 minutes
1. Free account at https://uptimerobot.com
2. **Add monitor** → HTTP(s):
   - URL: `https://<your-host>/api/keepalive`
   - Interval: 5 minutes
3. Bonus: it alerts you if the site itself goes down.

### 3. Baseline (already in this repo): GitHub Actions
`.github/workflows/keepalive.yml` pings every 30 minutes when repo variable
`APP_URL` is set (e.g. `https://crypsor.onrender.com`).
This alone guarantees the system never sleeps longer than ~30 min, but it is
NOT minute-level — it exists so the pipeline limps along even if the
external pingers are ever removed. Optionally add a `CRON_SECRET` repo
secret (Settings → Secrets → Actions) so it uses the authorized tick.

> Private-repo quota math: ~48 runs/day, billed 1–2 min each ≈ 1,400–2,000
> Actions minutes/month — inside the free tier. Don't schedule it tighter
> unless the repo is public (public repos have unlimited Actions minutes).

## Paid upgrades

- **Render Starter** (~$7/mo): always-on Node — this is the intended production host.
- **Vercel Pro** (~$20/mo): per-minute Vercel Crons pointing at
  `/api/cron/tick` — no external pinger needed.

## Verifying it works

- `https://<your-host>/api/healthz` → `ok: true` and a recent `lastScanAt`.
- Database check: `SELECT MAX(at) FROM f2_scans;` should always be
  within the last few minutes.
- The desk's **New tokens** log should keep filling overnight.
