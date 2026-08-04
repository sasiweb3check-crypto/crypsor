/**
 * Vercel Cron + manual wake ticks — keep wallet scan / pump refresh / desk
 * prices alive when Fluid Compute instances go idle.
 *
 * Auth: Authorization Bearer CRON_SECRET, or Vercel’s x-vercel-cron header.
 */
import { Router, type Request, type Response } from "express";
import { runScan } from "../lib/monitor";
import { refreshRecentBuys } from "../pipeline/pump-buy-scanner";
import { refreshDeskPrices } from "../pipeline/price-service";
import { ensureVercelRuntime } from "../vercel-runtime";
import { apiFail, apiOk } from "../lib/api-envelope";
import { logger } from "../lib/logger";

const router = Router();

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    return (req.headers.authorization ?? "") === `Bearer ${secret}`;
  }
  // No secret yet: allow Vercel’s cron header, or any caller outside production.
  if (req.headers["x-vercel-cron"] === "1") return true;
  return process.env.NODE_ENV !== "production";
}

async function runTick(req: Request, res: Response) {
  if (!cronAuthorized(req)) {
    res.status(401).json(apiFail("Unauthorized cron", "cron_unauthorized"));
    return;
  }

  await ensureVercelRuntime();

  const jobs: Record<string, string> = {};
  const t0 = Date.now();

  try {
    await runScan();
    jobs.walletScan = "ok";
  } catch (err) {
    jobs.walletScan = err instanceof Error ? err.message : "error";
    logger.warn({ err }, "cron wallet scan failed");
  }

  try {
    await refreshRecentBuys();
    jobs.pumpRefresh = "ok";
  } catch (err) {
    jobs.pumpRefresh = err instanceof Error ? err.message : "error";
    logger.warn({ err }, "cron pump refresh failed");
  }

  try {
    await refreshDeskPrices();
    jobs.deskPrices = "ok";
  } catch (err) {
    jobs.deskPrices = err instanceof Error ? err.message : "error";
    logger.warn({ err }, "cron desk prices failed");
  }

  res.json(apiOk({
    ok: true,
    ms: Date.now() - t0,
    jobs,
    at: new Date().toISOString(),
  }));
}

router.get("/cron/tick", (req, res) => { void runTick(req, res); });
router.post("/cron/tick", (req, res) => { void runTick(req, res); });

export default router;
