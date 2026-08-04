/**
 * Pipeline wake endpoints for Vercel Hobby (free).
 *
 * Hobby forbids sub-daily Vercel Cron — so we do NOT register minute crons.
 * Instead:
 *   GET/POST /api/keepalive  — public, rate-limited; desk UI pings while open
 *   GET/POST /api/cron/tick  — optional external free cron (cron-job.org) with CRON_SECRET
 */
import { Router, type Request, type Response } from "express";
import { runScan } from "../lib/monitor";
import { refreshRecentBuys } from "../pipeline/pump-buy-scanner";
import { refreshDeskPrices } from "../pipeline/price-service";
import { ensureVercelRuntime } from "../vercel-runtime";
import { apiFail, apiOk } from "../lib/api-envelope";
import { logger } from "../lib/logger";

const router = Router();

const KEEPALIVE_MIN_MS = 45_000;
let lastKeepaliveAt = 0;
let lastFullScanAt = 0;
const FULL_SCAN_EVERY_MS = 120_000;

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    return (req.headers.authorization ?? "") === `Bearer ${secret}`;
  }
  if (req.headers["x-vercel-cron"] === "1") return true;
  return process.env.NODE_ENV !== "production";
}

async function runPipelineTick(opts: { fullScan: boolean }) {
  await ensureVercelRuntime();
  const jobs: Record<string, string> = {};
  const t0 = Date.now();

  if (opts.fullScan) {
    try {
      await runScan();
      jobs.walletScan = "ok";
      lastFullScanAt = Date.now();
    } catch (err) {
      jobs.walletScan = err instanceof Error ? err.message : "error";
      logger.warn({ err }, "tick wallet scan failed");
    }
  } else {
    jobs.walletScan = "skipped";
  }

  try {
    await refreshRecentBuys();
    jobs.pumpRefresh = "ok";
  } catch (err) {
    jobs.pumpRefresh = err instanceof Error ? err.message : "error";
    logger.warn({ err }, "tick pump refresh failed");
  }

  try {
    await refreshDeskPrices();
    jobs.deskPrices = "ok";
  } catch (err) {
    jobs.deskPrices = err instanceof Error ? err.message : "error";
    logger.warn({ err }, "tick desk prices failed");
  }

  return { jobs, ms: Date.now() - t0 };
}

/** Full tick — for external free cron services (Bearer CRON_SECRET). */
async function runCronTick(req: Request, res: Response) {
  if (!cronAuthorized(req)) {
    res.status(401).json(apiFail("Unauthorized cron", "cron_unauthorized"));
    return;
  }
  const result = await runPipelineTick({ fullScan: true });
  res.json(apiOk({
    ok: true,
    ...result,
    at: new Date().toISOString(),
    mode: "cron",
  }));
}

/**
 * Public keepalive — desk pings this while open (Hobby-safe).
 * Rate-limited; runs full wallet scan at most every ~2 min.
 */
async function runKeepalive(_req: Request, res: Response) {
  const now = Date.now();
  if (now - lastKeepaliveAt < KEEPALIVE_MIN_MS) {
    res.json(apiOk({
      ok: true,
      skipped: true,
      reason: "rate_limited",
      retryInMs: KEEPALIVE_MIN_MS - (now - lastKeepaliveAt),
      at: new Date().toISOString(),
    }));
    return;
  }
  lastKeepaliveAt = now;

  const fullScan = now - lastFullScanAt >= FULL_SCAN_EVERY_MS;
  const result = await runPipelineTick({ fullScan });
  res.json(apiOk({
    ok: true,
    ...result,
    fullScan,
    at: new Date().toISOString(),
    mode: "keepalive",
  }));
}

router.get("/cron/tick", (req, res) => { void runCronTick(req, res); });
router.post("/cron/tick", (req, res) => { void runCronTick(req, res); });
router.get("/keepalive", (req, res) => { void runKeepalive(req, res); });
router.post("/keepalive", (req, res) => { void runKeepalive(req, res); });

export default router;
