import { pool } from "@workspace/db";
import { logger } from "./logger";

/** Idempotent indexes that make /api/pro/history + stats cheap on Aiven. */
const STATEMENTS = [
  // CONCURRENTLY avoids blocking writes/reads during first deploy index build.
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS pro_calls_quality_score_idx
     ON pro_calls (quality_label, pro_score DESC NULLS LAST)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS pro_calls_quality_called_idx
     ON pro_calls (quality_label, called_at DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS pro_calls_called_at_idx
     ON pro_calls (called_at DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS pro_calls_ath_idx
     ON pro_calls (ath_multiple DESC NULLS LAST)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS pro_calls_survival_idx
     ON pro_calls (survival_score DESC NULLS LAST)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS pro_calls_hit5_qual_idx
     ON pro_calls (quality_label, ath_multiple DESC)
     WHERE quality_label IN ('good','very_good') AND ath_multiple >= 5`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS pro_snapshots_call_snap_idx
     ON pro_snapshots (pro_call_id, snapshot_at DESC)`,
];

export async function ensureProIndexes(): Promise<void> {
  // Don't block boot/health — build indexes in the background.
  void (async () => {
    for (const sqlText of STATEMENTS) {
      try {
        // CONCURRENTLY cannot run inside a transaction; use bare pool.query.
        await pool.query(sqlText);
      } catch (err) {
        logger.warn({ err, sqlText }, "pro index ensure failed");
      }
    }
    logger.info("pro indexes ensured");
  })();
}
