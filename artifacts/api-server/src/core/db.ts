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
