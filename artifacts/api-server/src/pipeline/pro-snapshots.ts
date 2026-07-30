/**
 * Pro Snapshots
 *
 * Every 5 minutes, takes a lightweight snapshot of all pro-called tokens
 * by reading their current state from `tracked_tokens` (maintained by the
 * existing pipeline — no extra API calls).
 *
 * Also updates `pro_calls.ath_multiple` with the running max so that the
 * stats query can stay O(1).
 *
 * Runs every 5 minutes with a 40-second startup delay (after pro-scanner).
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const log = logger.child({ module: "pro-snapshots" });

const SNAP_INTERVAL_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 40_000;

async function snapshotOnce(): Promise<void> {
  try {
    // Read all pro_calls joined with current tracked_token state
    const rows = await db.execute(sql`
      SELECT
        pc.id              AS pro_call_id,
        pc.token_id,
        pc.called_mc_usd,
        pc.ath_multiple    AS prev_ath,
        t.market_cap_usd   AS current_mc,
        t.holder_kol_count AS kol_count,
        t.holder_smart_count AS smart_count,
        t.intelligence_score AS intel_score
      FROM pro_calls pc
      JOIN tracked_tokens t ON t.id = pc.token_id
    `);

    if (rows.rows.length === 0) return;

    type Row = {
      pro_call_id: number; token_id: number;
      called_mc_usd: string | null; prev_ath: number | null;
      current_mc: string | null; kol_count: number | null;
      smart_count: number | null; intel_score: number | null;
    };

    let snapCount = 0;
    for (const r of rows.rows as Row[]) {
      const calledMc  = parseFloat(r.called_mc_usd ?? "0") || 0;
      const currentMc = parseFloat(r.current_mc ?? "0") || 0;
      const multiple  = calledMc > 0 ? currentMc / calledMc : 1;
      const newAth    = Math.max(r.prev_ath ?? 1, multiple);

      // Insert snapshot row
      await db.execute(sql`
        INSERT INTO pro_snapshots (pro_call_id, token_id, mc_usd, kol_count, smart_count, intel_score, ath_multiple)
        VALUES (
          ${r.pro_call_id},
          ${r.token_id},
          ${r.current_mc ?? null},
          ${r.kol_count ?? 0},
          ${r.smart_count ?? 0},
          ${r.intel_score ?? null},
          ${multiple}
        )
      `);

      // Update running ATH in pro_calls
      await db.execute(sql`
        UPDATE pro_calls
        SET ath_multiple = ${newAth}, last_snapshot_at = NOW()
        WHERE id = ${r.pro_call_id}
          AND (ath_multiple IS NULL OR ath_multiple < ${newAth})
      `);

      // Always bump last_snapshot_at even when ath didn't change
      await db.execute(sql`
        UPDATE pro_calls SET last_snapshot_at = NOW()
        WHERE id = ${r.pro_call_id} AND (last_snapshot_at IS NULL OR last_snapshot_at < NOW() - INTERVAL '4 minutes')
      `);

      snapCount++;
    }

    log.info({ snapCount }, "Pro snapshots written");
  } catch (err) {
    log.error({ err }, "Pro snapshots error");
  }
}

export function startProSnapshots(): void {
  setTimeout(async () => {
    await snapshotOnce();
    setInterval(snapshotOnce, SNAP_INTERVAL_MS);
  }, STARTUP_DELAY_MS);

  log.info({ delayMs: STARTUP_DELAY_MS, intervalMs: SNAP_INTERVAL_MS }, "Pro snapshots scheduled");
}
