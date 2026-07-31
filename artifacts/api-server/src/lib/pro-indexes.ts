import { pool } from "@workspace/db";
import { logger } from "./logger";
import {
  BLOCKED_SYMBOLS,
  MAX_ABSURD_MC_USD,
  MAX_DISCOVERY_MC_USD,
  MAX_PRO_ENTRY_MC_USD,
  SOLANA_BLOCKED_MINTS,
} from "./solana-memecoin-gate";

/** Idempotent schema patches for Pro GMGN verify freeze + alerts + snapshots. */
const SCHEMA_STATEMENTS = [
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS kol_smart_source text`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS verified_at timestamptz`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS verified_wallets text`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS call_alert_sent_at timestamptz`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS milestone_alerts_sent text DEFAULT ''`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS holder_count integer`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS mc_growth_score real`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS volume_intensity_score real`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS liquidity_usd text`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS kol_delta integer DEFAULT 0`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS smart_delta integer DEFAULT 0`,
];

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

/** One-shot demote / ignore USD1, cbBTC, absurd MC, Track-C (smart=0) junk. */
async function quarantineBadMcOutcomes(): Promise<void> {
  const mints = [...SOLANA_BLOCKED_MINTS];
  const symbols = [...BLOCKED_SYMBOLS];
  try {
    const ignored = await pool.query(
      `UPDATE tracked_tokens
       SET status = 'ignored', last_status_change_at = NOW()
       WHERE COALESCE(status, '') <> 'ignored'
         AND (
           address = ANY($1::text[])
           OR UPPER(COALESCE(symbol, '')) = ANY($2::text[])
           OR COALESCE(NULLIF(market_cap_usd, '')::numeric, 0) > $3
         )`,
      [mints, symbols, MAX_ABSURD_MC_USD],
    );
    // True junk only — clear surfaced_at so sticky desk does not keep them.
    const demoted = await pool.query(
      `UPDATE pro_calls pc
       SET quality_label = 'below',
           surfaced_at = NULL
       FROM tracked_tokens t
       WHERE pc.token_id = t.id
         AND COALESCE(pc.quality_label, '') IN ('good', 'very_good', 'average')
         AND (
           t.address = ANY($1::text[])
           OR UPPER(COALESCE(t.symbol, '')) = ANY($2::text[])
           OR COALESCE(NULLIF(pc.called_mc_usd, '')::numeric, 0) > $3
           OR COALESCE(NULLIF(pc.called_mc_usd, '')::numeric, 0) > $4
           OR COALESCE(pc.called_smart_count, 0) < 1
           OR COALESCE(NULLIF(t.market_cap_usd, '')::numeric, 0) > $5
           OR t.sec_is_honeypot IS TRUE
         )`,
      [mints, symbols, MAX_PRO_ENTRY_MC_USD, MAX_DISCOVERY_MC_USD, MAX_ABSURD_MC_USD],
    );

    // Sticky rescue: calls that entered the desk then got demoted by DEAD/score
    // decay come back — outcome UI explains death; membership stays.
    const rescued = await pool.query(
      `UPDATE pro_calls
       SET quality_label = CASE
             WHEN COALESCE(pro_score, 0) >= 75 THEN 'very_good'
             ELSE 'good'
           END
       WHERE surfaced_at IS NOT NULL
         AND quality_label = 'below'
         AND COALESCE(called_smart_count, 0) >= 1
         AND COALESCE(NULLIF(called_mc_usd, '')::numeric, 0) <= $1
         AND COALESCE(NULLIF(called_mc_usd, '')::numeric, 0) >= 5000`,
      [MAX_PRO_ENTRY_MC_USD],
    );

    logger.info(
      {
        ignoredTokens: ignored.rowCount ?? 0,
        demotedProCalls: demoted.rowCount ?? 0,
        rescuedSticky: rescued.rowCount ?? 0,
      },
      "quarantined junk + rescued sticky Pro desk membership",
    );
  } catch (err) {
    logger.warn({ err }, "quarantineBadMcOutcomes failed (non-fatal)");
  }
}

export async function ensureProIndexes(): Promise<void> {
  // Don't block boot/health — schema + indexes in the background.
  void (async () => {
    for (const sqlText of SCHEMA_STATEMENTS) {
      try {
        await pool.query(sqlText);
      } catch (err) {
        logger.warn({ err, sqlText }, "pro schema ensure failed");
      }
    }
    for (const sqlText of STATEMENTS) {
      try {
        // CONCURRENTLY cannot run inside a transaction; use bare pool.query.
        await pool.query(sqlText);
      } catch (err) {
        logger.warn({ err, sqlText }, "pro index ensure failed");
      }
    }
    await quarantineBadMcOutcomes();
    logger.info("pro schema + indexes ensured");
  })();
}
