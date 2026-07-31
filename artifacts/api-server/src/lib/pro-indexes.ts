import { pool } from "@workspace/db";
import { logger } from "./logger";

/** Idempotent indexes that make /api/pro/history + stats cheap on Aiven. */
const STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS pro_snapshots_call_snap_idx
     ON pro_snapshots (pro_call_id, snapshot_at DESC)`,
  `CREATE INDEX IF NOT EXISTS pro_calls_quality_score_idx
     ON pro_calls (quality_label, pro_score DESC NULLS LAST)`,
  `CREATE INDEX IF NOT EXISTS pro_calls_quality_called_idx
     ON pro_calls (quality_label, called_at DESC)`,
  `CREATE INDEX IF NOT EXISTS pro_calls_called_at_idx
     ON pro_calls (called_at DESC)`,
];

export async function ensureProIndexes(): Promise<void> {
  for (const sqlText of STATEMENTS) {
    try {
      await pool.query(sqlText);
    } catch (err) {
      logger.warn({ err, sqlText }, "pro index ensure failed");
    }
  }
  logger.info("pro indexes ensured");
}
