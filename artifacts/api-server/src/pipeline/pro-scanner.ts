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
 *
 * Auto-backfill (runs before every INSERT pass):
 *   The intelligence engine logs KOL/smart = 0 on the first pass because GMGN
 *   holder data hasn't arrived yet (typical delay: 12–60 s after detection).
 *   The scanner picks the EARLIEST qualifying log row per token — so if that
 *   first entry has kol = 0 it never qualifies, even after GMGN data arrives.
 *   The backfill step copies current kol/smart counts from tracked_tokens into
 *   any intel-log entry where kol/smart were still 0, unblocking the INSERT.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const log = logger.child({ module: "pro-scanner" });

const SCAN_INTERVAL_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 20_000;

const MIN_INTEL = 80;
const MIN_MC    = 5_000;

// ── Step 0: backfill KOL/smart counts in intel log ───────────────────────────
// Fixes the timing gap where GMGN data arrives after the first intel log entry.

async function backfillKolSmartCounts(): Promise<void> {
  try {
    const result = await db.execute(sql`
      UPDATE token_intel_log l
      SET
        holder_kol_count   = t.holder_kol_count,
        holder_smart_count = t.holder_smart_count,
        kol_smart_score    = LEAST(100.0, GREATEST(0.0, (
          (t.holder_kol_count::float / NULLIF(t.holder_count, 0)) * 250.0 +
          (t.holder_smart_count::float / NULLIF(t.holder_count, 0)) * 200.0
        )::real))
      FROM tracked_tokens t
      WHERE l.token_id = t.id
        AND (l.holder_kol_count IS NULL OR l.holder_kol_count = 0)
        AND (l.holder_smart_count IS NULL OR l.holder_smart_count = 0)
        AND (t.holder_kol_count >= 1 OR t.holder_smart_count >= 1)
        AND l.intelligence_score >= ${MIN_INTEL}
    `);
    const updated = Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
    if (updated > 0) {
      log.info({ updated }, "KOL/smart backfill: intel log entries updated");
    }
  } catch (err) {
    log.warn({ err }, "KOL/smart backfill error (non-fatal)");
  }
}

async function scanOnce(): Promise<void> {
  // Backfill before every scan: ensures intel-log rows that were written with
  // kol=0 (GMGN data not yet arrived) get their real counts before the INSERT.
  await backfillKolSmartCounts();

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
        AND l.status_after IN ('new', 'active', 'watch')
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
