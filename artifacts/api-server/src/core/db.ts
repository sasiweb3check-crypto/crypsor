/**
 * Funnel schema — created idempotently at boot (Vercel Hobby friendly:
 * no migration step, safe to run on every cold start).
 *
 * Naming: f2_* — the v2 funnel pipeline owns these tables. Legacy tables
 * from v1 remain in the database untouched; nothing here reads them except
 * `settings` (API keys) and `walletdatasource` (tracked wallet list), which
 * carry over user configuration.
 */
import { pool } from "@workspace/db";
import { logger } from "./log";

export { pool };

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS f2_tokens (
     id            serial PRIMARY KEY,
     mint          text NOT NULL UNIQUE,
     symbol        text,
     name          text,
     image         text,
     source        text NOT NULL,              -- pump_live | pump_new | wallet_buy
     stage         text NOT NULL DEFAULT 'tracking', -- tracking | deepdive | called | killed
     kill_reason   text,
     created_ts    timestamptz,                -- token creation time
     discovered_at timestamptz NOT NULL DEFAULT NOW(),
     mc_at_discovery real,
     wallet_buys   integer NOT NULL DEFAULT 0, -- distinct tracked wallets that bought
     scans_total   integer NOT NULL DEFAULT 0,
     scans_passed  integer NOT NULL DEFAULT 0,
     pass_streak   integer NOT NULL DEFAULT 0,
     fail_streak   integer NOT NULL DEFAULT 0,
     last_scan_at  timestamptz,
     graduated     boolean NOT NULL DEFAULT false,
     meta          jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS idx_f2_tokens_stage ON f2_tokens (stage, last_scan_at)`,
  `CREATE INDEX IF NOT EXISTS idx_f2_tokens_discovered ON f2_tokens (discovered_at DESC)`,

  `CREATE TABLE IF NOT EXISTS f2_scans (
     id           serial PRIMARY KEY,
     token_id     integer NOT NULL REFERENCES f2_tokens(id),
     at           timestamptz NOT NULL DEFAULT NOW(),
     mc_usd       real,
     liq_usd      real,
     price_usd    real,
     holders      integer,
     top10_pct    real,
     buys_5m      integer,
     sells_5m     integer,
     vol_5m       real,
     bundler_pct  real,
     sniper_pct   real,
     bot_pct      real,
     smart_count  integer,
     kol_count    integer,
     pass         boolean NOT NULL,
     fail_reasons jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS idx_f2_scans_token_at ON f2_scans (token_id, at DESC)`,

  `CREATE TABLE IF NOT EXISTS f2_calls (
     id            serial PRIMARY KEY,
     token_id      integer NOT NULL UNIQUE REFERENCES f2_tokens(id),
     called_at     timestamptz NOT NULL DEFAULT NOW(),
     alert_mc      real NOT NULL,
     peak_mc       real NOT NULL,
     peak_at       timestamptz,
     last_mc       real,
     last_seen_at  timestamptz,
     safe          boolean NOT NULL DEFAULT false, -- passed the tight scam filter
     deep          jsonb,                          -- deep-dive evidence
     telegram_sent boolean NOT NULL DEFAULT false,
     journal_until timestamptz
   )`,
  `CREATE INDEX IF NOT EXISTS idx_f2_calls_called ON f2_calls (called_at DESC)`,

  `CREATE TABLE IF NOT EXISTS f2_journal (
     id          serial PRIMARY KEY,
     call_id     integer NOT NULL REFERENCES f2_calls(id),
     at          timestamptz NOT NULL DEFAULT NOW(),
     price_usd   real,
     mc_usd      real,
     liq_usd     real,
     holders     integer,
     bot_pct     real,
     smart_count integer,
     whale_pct   real,
     buys_5m     integer,
     sells_5m    integer,
     vol_5m      real
   )`,
  `CREATE INDEX IF NOT EXISTS idx_f2_journal_call_at ON f2_journal (call_id, at DESC)`,

  `CREATE TABLE IF NOT EXISTS settings (
     id serial PRIMARY KEY,
     key text NOT NULL UNIQUE,
     value text,
     updated_at timestamptz NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS walletdatasource (
     id serial PRIMARY KEY,
     address text NOT NULL UNIQUE,
     label text,
     chain text NOT NULL DEFAULT 'solana',
     created_at timestamptz NOT NULL DEFAULT NOW()
   )`,

  // ── Ward (hospital) columns on existing patients ──
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS phase text`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS survival_score integer`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS admission_mc real`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS peak_mc real`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS last_mc real`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS last_liq real`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS last_holders integer`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS last_verdict text`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS last_reasons jsonb`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS tape_lead text`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS deceased_at timestamptz`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS revived_at timestamptz`,
  `UPDATE f2_tokens SET phase = CASE
      WHEN stage = 'killed' THEN 'deceased'
      WHEN stage = 'called' THEN 'ward'
      ELSE COALESCE(phase, 'intake')
    END
    WHERE phase IS NULL`,
  `UPDATE f2_tokens
     SET phase = 'deceased',
         stage = 'killed',
         kill_reason = COALESCE(kill_reason, 'not_wallet_buy'),
         deceased_at = COALESCE(deceased_at, NOW())
   WHERE source NOT IN ('wallet_buy','public_tape','dex_boost','pump_mover','gecko','pump_live')
     AND COALESCE(wallet_buys, 0) = 0
     AND COALESCE(phase, 'intake') <> 'deceased'`,
  `ALTER TABLE f2_scans ADD COLUMN IF NOT EXISTS tape jsonb`,
  `ALTER TABLE f2_scans ADD COLUMN IF NOT EXISTS score integer`,
  `ALTER TABLE f2_scans ADD COLUMN IF NOT EXISTS phase text`,
  `ALTER TABLE f2_scans ADD COLUMN IF NOT EXISTS whale_pct real`,
  `CREATE INDEX IF NOT EXISTS idx_f2_tokens_phase ON f2_tokens (phase, last_scan_at)`,
  `CREATE INDEX IF NOT EXISTS idx_f2_tokens_source_scan ON f2_tokens (source, last_scan_at)`,

  `CREATE TABLE IF NOT EXISTS ward_admissions (
     id serial PRIMARY KEY,
     token_id integer NOT NULL REFERENCES f2_tokens(id),
     wallet text NOT NULL,
     sig text,
     at timestamptz NOT NULL DEFAULT NOW(),
     UNIQUE (token_id, wallet, sig)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ward_admissions_token ON ward_admissions (token_id, at DESC)`,

  `CREATE TABLE IF NOT EXISTS ward_alerts (
     id serial PRIMARY KEY,
     token_id integer NOT NULL REFERENCES f2_tokens(id),
     kind text NOT NULL,
     title text NOT NULL,
     body text,
     payload jsonb,
     telegram_sent boolean NOT NULL DEFAULT false,
     at timestamptz NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ward_alerts_at ON ward_alerts (at DESC)`,

  `CREATE TABLE IF NOT EXISTS ward_agent_log (
     id serial PRIMARY KEY,
     agent text NOT NULL,
     action text NOT NULL,
     token_id integer,
     mint text,
     detail text NOT NULL,
     at timestamptz NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ward_agent_log_at ON ward_agent_log (at DESC)`,

  `CREATE TABLE IF NOT EXISTS ward_weights (
     factor text PRIMARY KEY,
     weight real NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT NOW(),
     note text
   )`,
  `CREATE TABLE IF NOT EXISTS ward_reports (
     id serial PRIMARY KEY,
     census jsonb NOT NULL,
     survival real,
     trades_24h integer,
     paper jsonb,
     detail text NOT NULL,
     at timestamptz NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE ward_reports ADD COLUMN IF NOT EXISTS suggestions jsonb`,
  `ALTER TABLE ward_reports ADD COLUMN IF NOT EXISTS quality jsonb`,

  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS last_quality integer`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS cap_band text`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS last_snapshot_at timestamptz`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS last_suggestion text`,
  `ALTER TABLE f2_scans ADD COLUMN IF NOT EXISTS quality integer`,
  `ALTER TABLE f2_scans ADD COLUMN IF NOT EXISTS sources jsonb`,

  `CREATE TABLE IF NOT EXISTS ward_source_reads (
     id serial PRIMARY KEY,
     token_id integer NOT NULL REFERENCES f2_tokens(id),
     source text NOT NULL,
     ok boolean NOT NULL,
     mc_usd real,
     liq_usd real,
     holders integer,
     top10_pct real,
     latency_ms integer,
     extra jsonb,
     at timestamptz NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ward_source_reads_token ON ward_source_reads (token_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ward_source_reads_src ON ward_source_reads (source, at DESC)`,

  `CREATE TABLE IF NOT EXISTS ward_snapshots (
     id serial PRIMARY KEY,
     token_id integer NOT NULL REFERENCES f2_tokens(id),
     band text NOT NULL,
     mc_usd real,
     liq_usd real,
     holders integer,
     top10_pct real,
     score integer,
     phase text,
     quality integer,
     tape_lead text,
     mc_slope real,
     liq_slope real,
     holder_slope real,
     sources jsonb,
     flags jsonb,
     suggestions jsonb,
     at timestamptz NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ward_snapshots_token ON ward_snapshots (token_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ward_snapshots_band ON ward_snapshots (band, at DESC)`,
  `ALTER TABLE ward_snapshots ADD COLUMN IF NOT EXISTS kind text`,
  `UPDATE ward_snapshots SET kind = 'confirm' WHERE kind IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_ward_snapshots_kind ON ward_snapshots (token_id, kind, at DESC)`,
  `ALTER TABLE ward_snapshots ADD COLUMN IF NOT EXISTS narrative text`,
  `ALTER TABLE ward_snapshots ADD COLUMN IF NOT EXISTS incomplete boolean`,
  `ALTER TABLE ward_snapshots ADD COLUMN IF NOT EXISTS filled jsonb`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS last_narrative text`,

  `CREATE TABLE IF NOT EXISTS ward_memory (
     token_id integer PRIMARY KEY REFERENCES f2_tokens(id),
     caution jsonb NOT NULL DEFAULT '{}'::jsonb,
     pulse jsonb NOT NULL DEFAULT '{}'::jsonb,
     confirm jsonb NOT NULL DEFAULT '{}'::jsonb,
     narrative text,
     updated_at timestamptz NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE ward_memory ADD COLUMN IF NOT EXISTS hour jsonb NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS last_momentum text`,
  `ALTER TABLE f2_tokens ADD COLUMN IF NOT EXISTS hotness integer`,
  `CREATE INDEX IF NOT EXISTS idx_f2_tokens_hotness ON f2_tokens (hotness DESC NULLS LAST)`,

  `CREATE TABLE IF NOT EXISTS ward_watch (
     id serial PRIMARY KEY,
     token_id integer NOT NULL UNIQUE REFERENCES f2_tokens(id),
     status text NOT NULL DEFAULT 'watching',
     yes_votes integer NOT NULL DEFAULT 0,
     no_votes integer NOT NULL DEFAULT 0,
     hold_votes integer NOT NULL DEFAULT 0,
     agreed boolean NOT NULL DEFAULT false,
     entry_ok boolean NOT NULL DEFAULT false,
     headline text,
     votes jsonb,
     last_mc real,
     last_liq real,
     last_score integer,
     seen_at timestamptz NOT NULL DEFAULT NOW(),
     updated_at timestamptz NOT NULL DEFAULT NOW(),
     locked_at timestamptz
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ward_watch_status ON ward_watch (status, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS ward_trades (
     id serial PRIMARY KEY,
     token_id integer NOT NULL UNIQUE REFERENCES f2_tokens(id),
     alert_id integer REFERENCES ward_alerts(id),
     entry_mc real NOT NULL,
     entry_liq real,
     entry_holders integer,
     entry_score integer,
     called_at timestamptz NOT NULL DEFAULT NOW(),
     peak_mc real NOT NULL,
     peak_at timestamptz,
     last_mc real,
     last_liq real,
     last_holders integer,
     status text NOT NULL DEFAULT 'open',
     exit_action text,
     exit_take_pct real,
     exit_title text,
     exit_body text,
     closed_at timestamptz,
     close_mc real,
     judged boolean NOT NULL DEFAULT false,
     ath_x real,
     gain_x real,
     extra jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ward_trades_status ON ward_trades (status, called_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ward_trades_called_at ON ward_trades (called_at DESC)`,
  `ALTER TABLE ward_trades ADD COLUMN IF NOT EXISTS gain_pct real`,
  `ALTER TABLE ward_trades ADD COLUMN IF NOT EXISTS ath_pct real`,
  `ALTER TABLE ward_trades ADD COLUMN IF NOT EXISTS archived_at timestamptz`,
  `UPDATE ward_trades SET gain_pct = (gain_x - 1) * 100 WHERE gain_pct IS NULL AND gain_x IS NOT NULL`,
  `UPDATE ward_trades SET ath_pct = (ath_x - 1) * 100 WHERE ath_pct IS NULL AND ath_x IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS ward_day_stats (
     day date PRIMARY KEY,
     passed_n integer NOT NULL DEFAULT 0,
     live_n integer NOT NULL DEFAULT 0,
     archived_n integer NOT NULL DEFAULT 0,
     dead_n integer NOT NULL DEFAULT 0,
     avg_gain_pct real,
     avg_ath_pct real,
     hit_2x_n integer NOT NULL DEFAULT 0,
     best_ath_pct real,
     updated_at timestamptz NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE ward_day_stats ADD COLUMN IF NOT EXISTS hit_5x_n integer NOT NULL DEFAULT 0`,
  `ALTER TABLE ward_day_stats ADD COLUMN IF NOT EXISTS hit_10x_n integer NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS ward_stats_stash (
     id serial PRIMARY KEY,
     reason text NOT NULL,
     payload jsonb,
     at timestamptz NOT NULL DEFAULT NOW()
   )`,
];

let ensured = false;

export async function ensureSchema(): Promise<void> {
  if (ensured) return;
  for (const stmt of SCHEMA) {
    try {
      await pool.query(stmt);
    } catch (err) {
      logger.warn({ err, stmt: stmt.slice(0, 60) }, "schema statement failed");
    }
  }
  ensured = true;
}
