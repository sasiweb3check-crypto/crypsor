/**
 * Vercel Fluid Compute bootstrap — start the in-process pipeline once per
 * warm instance. Cron (/api/cron/tick) keeps work moving when idle.
 */
import { logger } from "./lib/logger";
import { startMonitor } from "./lib/monitor";
import { ensureProIndexes } from "./lib/pro-indexes";
import { pool } from "@workspace/db";

let boot: Promise<void> | null = null;

export function ensureVercelRuntime(): Promise<void> {
  if (boot) return boot;
  boot = (async () => {
    try {
      await pool.query("select 1");
      await ensureProIndexes();
    } catch (err) {
      logger.warn({ err }, "Vercel runtime DB warmup failed");
    }
    startMonitor();
    logger.info("Vercel runtime ready — monitor started");
  })();
  return boot;
}
