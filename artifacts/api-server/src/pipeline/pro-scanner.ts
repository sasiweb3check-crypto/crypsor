/**
 * Pro Scanner
 *
 * Identifies tokens that qualify for the Pro Caller tier and registers them
 * in `pro_calls` (one record per token, never duplicated).
 *
 * Qualification criteria (looser than the legacy caller):
 *   • intelligence_score >= 80
 *   • holder_kol_count >= 1 OR holder_smart_count >= 1
 *   • market_cap_usd >= $5,000 at the time the score was computed
 *
 * Runs every 5 minutes with a 20-second startup delay (after the intelligence
 * engine's own first pass).
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const log = logger.child({ module: "pro-scanner" });

const SCAN_INTERVAL_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 20_000;

const MIN_INTEL = 80;
const MIN_MC    = 5_000;

async function scanOnce(): Promise<void> {
  try {
    // Find the earliest qualifying intel-log row per token, excluding tokens
    // already registered in pro_calls.
    const result = await db.execute(sql`
      INSERT INTO pro_calls (
        token_id,
        called_at,
        called_mc_usd,
        called_intel_score,
        called_kol_count,
        called_smart_count,
        called_kol_smart_score
      )
      SELECT DISTINCT ON (l.token_id)
        l.token_id,
        l.computed_at                    AS called_at,
        l.market_cap_usd                 AS called_mc_usd,
        l.intelligence_score             AS called_intel_score,
        l.holder_kol_count               AS called_kol_count,
        l.holder_smart_count             AS called_smart_count,
        l.kol_smart_score                AS called_kol_smart_score
      FROM token_intel_log l
      WHERE l.intelligence_score        >= ${MIN_INTEL}
        AND (l.holder_kol_count >= 1 OR l.holder_smart_count >= 1)
        AND l.market_cap_usd::numeric   >= ${MIN_MC}
        AND NOT EXISTS (
          SELECT 1 FROM pro_calls pc WHERE pc.token_id = l.token_id
        )
      ORDER BY l.token_id, l.computed_at ASC
      ON CONFLICT (token_id) DO NOTHING
    `);

    const inserted = Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
    if (inserted > 0) {
      log.info({ inserted }, "New pro calls registered");
    }
  } catch (err) {
    log.error({ err }, "Pro scanner error");
  }
}

export function startProScanner(): void {
  setTimeout(async () => {
    await scanOnce();
    setInterval(scanOnce, SCAN_INTERVAL_MS);
  }, STARTUP_DELAY_MS);

  log.info({ delayMs: STARTUP_DELAY_MS, intervalMs: SCAN_INTERVAL_MS }, "Pro scanner scheduled");
}
