import pg from 'pg';

let connectionString = process.env.AIVEN_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
const remote = connectionString ? !['localhost', '127.0.0.1', '::1'].includes(new URL(connectionString).hostname) : false;
if (connectionString && remote) {
  const url = new URL(connectionString);
  // Explicit TLS configuration preserves certificate verification and an optional Aiven CA.
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(key);
  connectionString = url.toString();
}
export const pool = new pg.Pool({
  connectionString,
  ssl: remote ? { rejectUnauthorized: true, ...(process.env.AIVEN_CA_CERT ? { ca: process.env.AIVEN_CA_CERT.replace(/\\n/g, '\n') } : {}) } : undefined,
  max: 5, connectionTimeoutMillis: 10_000,
});
export const configured = Boolean(connectionString);
export async function initialize() {
  if (!configured) throw new Error('Set AIVEN_DATABASE_URL or DATABASE_URL');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cw_wallets (
      address text PRIMARY KEY, label text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
      cursor text, synced_at timestamptz, sync_error text
    );
    CREATE TABLE IF NOT EXISTS cw_tokens (
      mint text PRIMARY KEY, symbol text, name text, image text,
      entry_price double precision, entry_source text, entry_at timestamptz NOT NULL,
      detected_at timestamptz NOT NULL DEFAULT now(), current_price double precision,
      peak_price double precision, priced_at timestamptz
    );
    ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS price_checked_at timestamptz;
    CREATE TABLE IF NOT EXISTS cw_buys (
      wallet text NOT NULL, mint text NOT NULL REFERENCES cw_tokens(mint), signature text NOT NULL,
      bought_at timestamptz NOT NULL, purchase_price double precision,
      PRIMARY KEY (wallet, mint, signature)
    );
    CREATE INDEX IF NOT EXISTS cw_buys_mint ON cw_buys(mint);
    CREATE TABLE IF NOT EXISTS cw_prices (
      id bigserial PRIMARY KEY, mint text NOT NULL REFERENCES cw_tokens(mint),
      price double precision NOT NULL, at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS cw_prices_mint ON cw_prices(mint, id DESC);
  `);
}
export async function overview() {
  const wallets = await pool.query(`SELECT w.address, w.label, w.created_at, w.synced_at, w.sync_error,
    COUNT(b.signature)::int AS buys, COUNT(DISTINCT b.mint)::int AS tokens
    FROM cw_wallets w LEFT JOIN cw_buys b ON b.wallet=w.address GROUP BY w.address ORDER BY w.created_at DESC`);
  const tokens = await pool.query(`SELECT t.*, COUNT(b.signature)::int AS buys,
    COALESCE(jsonb_agg(DISTINCT jsonb_build_object('address', b.wallet, 'label', COALESCE(w.label, ''))) FILTER (WHERE b.wallet IS NOT NULL), '[]') AS wallets,
    (SELECT COALESCE(jsonb_agg(p.price ORDER BY p.id), '[]') FROM
      (SELECT price,id FROM cw_prices WHERE mint=t.mint ORDER BY id DESC LIMIT 30) p) AS history
    FROM cw_tokens t LEFT JOIN cw_buys b ON b.mint=t.mint LEFT JOIN cw_wallets w ON w.address=b.wallet
    GROUP BY t.mint ORDER BY t.detected_at DESC LIMIT 1000`);
  return { wallets: wallets.rows, tokens: tokens.rows.map(t => ({ ...t,
    gain: t.entry_price > 0 && t.current_price != null ? (t.current_price / t.entry_price - 1) * 100 : null,
    peak_gain: t.entry_price > 0 && t.peak_price != null ? (t.peak_price / t.entry_price - 1) * 100 : null,
  })) };
}
