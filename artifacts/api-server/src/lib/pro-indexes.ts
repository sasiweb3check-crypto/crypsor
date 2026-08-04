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
  // GEM engine — evidence tape + final trusted score
  `CREATE TABLE IF NOT EXISTS gem_snapshots (
     id serial PRIMARY KEY,
     token_id integer NOT NULL,
     at timestamptz NOT NULL DEFAULT NOW(),
     mc_usd real,
     liq_usd real,
     price_usd real,
     vol_5m real,
     vol_1h real,
     vol_24h real,
     buys_5m integer,
     sells_5m integer,
     buys_1h integer,
     sells_1h integer,
     price_change_5m real,
     price_change_1h real,
     holder_count integer
   )`,
  `CREATE INDEX IF NOT EXISTS idx_gem_snapshots_token_at ON gem_snapshots (token_id, at DESC)`,
  `ALTER TABLE gem_snapshots ADD COLUMN IF NOT EXISTS top10_pct real`,
  `ALTER TABLE gem_snapshots ADD COLUMN IF NOT EXISTS smart_count integer`,
  `ALTER TABLE gem_snapshots ADD COLUMN IF NOT EXISTS kol_count integer`,
  `ALTER TABLE gem_snapshots ADD COLUMN IF NOT EXISTS smart_hold_pct real`,
  `ALTER TABLE gem_snapshots ADD COLUMN IF NOT EXISTS kol_hold_pct real`,
  `ALTER TABLE gem_snapshots ADD COLUMN IF NOT EXISTS sniper_hold_pct real`,
  `ALTER TABLE gem_snapshots ADD COLUMN IF NOT EXISTS bundler_hold_pct real`,
  `CREATE TABLE IF NOT EXISTS gem_scores (
     id serial PRIMARY KEY,
     token_id integer NOT NULL UNIQUE,
     score real NOT NULL,
     verdict text NOT NULL,
     confidence real NOT NULL,
     components jsonb NOT NULL,
     vetoes jsonb,
     snapshots_used integer NOT NULL DEFAULT 0,
     gem_streak integer NOT NULL DEFAULT 0,
     first_gem_at timestamptz,
     gem_call_mc_usd real,
     peak_after_call_mc real,
     updated_at timestamptz NOT NULL DEFAULT NOW(),
     created_at timestamptz NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS kol_smart_source text`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS verified_at timestamptz`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS verified_wallets text`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS call_alert_sent_at timestamptz`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS milestone_alerts_sent text DEFAULT ''`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS runner_score real`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS runner_phase text`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS runner_alert_sent_at timestamptz`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS cto_alert_sent_at timestamptz`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS last_snap_mc_usd text`,
  `ALTER TABLE pro_calls ADD COLUMN IF NOT EXISTS observation_snap_count integer DEFAULT 0`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS holder_count integer`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS mc_growth_score real`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS volume_intensity_score real`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS liquidity_usd text`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS kol_delta integer DEFAULT 0`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS smart_delta integer DEFAULT 0`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS runner_score real`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS runner_phase text`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS velocity real`,
  `ALTER TABLE pro_snapshots ADD COLUMN IF NOT EXISTS phase_changed integer DEFAULT 0`,
  // Dex Autopilot paper agent
  `CREATE TABLE IF NOT EXISTS dex_agent_state (
     id serial PRIMARY KEY,
     enabled boolean NOT NULL DEFAULT true,
     bankroll_usd real NOT NULL DEFAULT 1000,
     realized_pnl_usd real NOT NULL DEFAULT 0,
     trades_opened integer NOT NULL DEFAULT 0,
     trades_closed integer NOT NULL DEFAULT 0,
     hits_3x integer NOT NULL DEFAULT 0,
     updated_at timestamptz NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS dex_positions (
     id serial PRIMARY KEY,
     token_id integer NOT NULL,
     pro_call_id integer,
     address text NOT NULL,
     symbol text,
     stake_usd real NOT NULL,
     remaining_stake_usd real NOT NULL,
     entry_mc_usd real NOT NULL,
     entry_at timestamptz NOT NULL DEFAULT NOW(),
     entry_phase text,
     entry_score real,
     entry_velocity real,
     entry_snap_count integer,
     pattern_key text,
     peak_multiple real DEFAULT 1,
     moon_bag_taken boolean NOT NULL DEFAULT false,
     status text NOT NULL DEFAULT 'open',
     exit_mc_usd real,
     exit_at timestamptz,
     exit_reason text,
     realized_pnl_usd real DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS dex_agent_events (
     id serial PRIMARY KEY,
     created_at timestamptz NOT NULL DEFAULT NOW(),
     kind text NOT NULL,
     level text NOT NULL DEFAULT 'info',
     msg text NOT NULL,
     token_id integer,
     symbol text,
     meta text
   )`,
  `CREATE TABLE IF NOT EXISTS dex_patterns (
     id serial PRIMARY KEY,
     pattern_key text NOT NULL UNIQUE,
     samples integer NOT NULL DEFAULT 0,
     wins_3x integer NOT NULL DEFAULT 0,
     losses integer NOT NULL DEFAULT 0,
     sum_exit_multiple real NOT NULL DEFAULT 0,
     best_multiple real DEFAULT 1,
     last_seen_at timestamptz NOT NULL DEFAULT NOW(),
     notes text
   )`,
  `ALTER TABLE dex_agent_state ADD COLUMN IF NOT EXISTS last_tick_at timestamptz`,
  `ALTER TABLE dex_positions ADD COLUMN IF NOT EXISTS entry_feedback text`,
  `ALTER TABLE dex_positions ADD COLUMN IF NOT EXISTS exit_feedback text`,
  // Pump-SDK buy scanner payload (grade / tags / buy+intra signals)
  `ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS pump_scan jsonb`,
  `ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS pump_scan_updated_at timestamptz`,
  // Pump signal + MC capture tape (gain-since-detection verification)
  `CREATE TABLE IF NOT EXISTS pump_scan_snapshots (
     id serial PRIMARY KEY,
     token_id integer NOT NULL REFERENCES tracked_tokens(id) ON DELETE CASCADE,
     snapshot_at timestamptz NOT NULL DEFAULT NOW(),
     score real,
     grade text,
     buy_signal text,
     intra_signal text,
     buy_pass_count integer,
     intra_pass_count integer,
     price_usd text,
     market_cap_usd text,
     liquidity_usd text,
     volume_24h_usd text,
     txns_24h integer,
     price_at_detection text,
     mc_at_detection text,
     gain_since_detection real,
     ath_gain real,
     mc_gain_since_detection real,
     ath_mc_gain real,
     payload jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS pump_scan_snapshots_token_snap_idx
     ON pump_scan_snapshots (token_id, snapshot_at DESC)`,
  // Pump desk alerts (BUY / INTRA / grade / EEI / gain milestones)
  `CREATE TABLE IF NOT EXISTS pump_alerts (
     id serial PRIMARY KEY,
     token_id integer NOT NULL REFERENCES tracked_tokens(id) ON DELETE CASCADE,
     kind text NOT NULL,
     label text NOT NULL,
     title text NOT NULL,
     body text,
     score real,
     grade text,
     buy_signal text,
     intra_signal text,
     market_cap_usd text,
     mc_at_detection text,
     gain_pct real,
     ath_gain_pct real,
     symbol text,
     name text,
     address text,
     telegram_sent boolean NOT NULL DEFAULT false,
     telegram_error text,
     read_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT NOW()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS pump_alerts_token_kind_uidx
     ON pump_alerts (token_id, kind)`,
  `CREATE INDEX IF NOT EXISTS pump_alerts_created_idx
     ON pump_alerts (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS pump_alerts_unread_idx
     ON pump_alerts (read_at, created_at DESC)`,
  // Crypsor-owned wallet intel (separate from GMGN KOL/smart)
  `CREATE TABLE IF NOT EXISTS crypsor_wallet_intel (
     wallet_address text PRIMARY KEY,
     our_label text NOT NULL DEFAULT 'noise',
     behaviour_score real NOT NULL DEFAULT 0,
     weightage real NOT NULL DEFAULT 0,
     win_rate real,
     wins integer NOT NULL DEFAULT 0,
     losses integer NOT NULL DEFAULT 0,
     tokens_seen integer NOT NULL DEFAULT 0,
     sightings integer NOT NULL DEFAULT 0,
     avg_hold_pct real,
     last_token_id integer,
     last_reason text,
     first_seen_at timestamptz NOT NULL DEFAULT NOW(),
     last_seen_at timestamptz NOT NULL DEFAULT NOW(),
     updated_at timestamptz NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS crypsor_wallet_token_events (
     id serial PRIMARY KEY,
     wallet_address text NOT NULL,
     token_id integer NOT NULL,
     role text NOT NULL,
     our_label_at text,
     behaviour_score_at real,
     hold_pct real,
     buy_count integer,
     sell_count integer,
     realized_pnl real,
     snapshot_id integer,
     created_at timestamptz NOT NULL DEFAULT NOW(),
     updated_at timestamptz NOT NULL DEFAULT NOW(),
     CONSTRAINT crypsor_wte_wallet_token_role UNIQUE (wallet_address, token_id, role)
   )`,
  `CREATE INDEX IF NOT EXISTS crypsor_wallet_intel_label_idx ON crypsor_wallet_intel (our_label)`,
  `CREATE INDEX IF NOT EXISTS crypsor_wallet_intel_weight_idx ON crypsor_wallet_intel (weightage)`,
  `CREATE INDEX IF NOT EXISTS crypsor_wte_token_idx ON crypsor_wallet_token_events (token_id)`,
  `CREATE INDEX IF NOT EXISTS crypsor_wte_wallet_idx ON crypsor_wallet_token_events (wallet_address)`,
  // Pump.fun creator / graduation enrich on tracked_tokens
  `ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS creator_username text`,
  `ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS pump_ath_market_cap_usd text`,
  `ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS creator_stats jsonb`,
  `ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS creator_stats_fetched_at timestamptz`,
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
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS pro_calls_runner_phase_idx
     ON pro_calls (runner_phase, runner_score DESC NULLS LAST)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS pro_calls_runner_alert_idx
     ON pro_calls (runner_alert_sent_at DESC NULLS LAST)`,
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
           OR (COALESCE(pc.called_smart_count, 0) < 1 AND COALESCE(pc.called_kol_count, 0) < 1)
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
         AND (COALESCE(called_smart_count, 0) >= 1 OR COALESCE(called_kol_count, 0) >= 1)
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
  // Schema ALTERs/CREATEs first (Dex agent needs tables before first tick).
  for (const sqlText of SCHEMA_STATEMENTS) {
    try {
      await pool.query(sqlText);
    } catch (err) {
      logger.warn({ err, sqlText }, "pro schema ensure failed");
    }
  }
  // Indexes + quarantine in the background — CONCURRENTLY must not block boot.
  void (async () => {
    for (const sqlText of STATEMENTS) {
      try {
        await pool.query(sqlText);
      } catch (err) {
        logger.warn({ err, sqlText }, "pro index ensure failed");
      }
    }
    await quarantineBadMcOutcomes();
    logger.info("pro schema + indexes ensured");
  })();
}
