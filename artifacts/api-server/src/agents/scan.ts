/**
 * SCAN — refresh MC for wallet-buy tokens.
 * Each name is printed at most every 15 minutes.
 * Below $5k → archived (dead). Above detected MC → running.
 */
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { imageOf, mcOf, pairsForMints } from "../sources/dexscreener";
import { coin as pumpCoin, pumpMc } from "../sources/pumpfun";
import { statusOf } from "../scoring/desk";
import { dexTokenImage } from "../scoring/image";
import { agentNote } from "./log";

const BATCH = 40;
const MAX_BATCHES = 8;

type Row = {
  id: number;
  mint: string;
  symbol: string | null;
  detected_mc: number | null;
  admission_mc: number | null;
  last_mc: number | null;
  peak_mc: number | null;
};

async function dueBatch(): Promise<Row[]> {
  const due = await pool.query(
    `SELECT id, mint, symbol,
            detected_mc, admission_mc, last_mc, peak_mc
     FROM f2_tokens
     WHERE wallet_buys > 0
       AND (last_scan_at IS NULL OR last_scan_at < NOW() - INTERVAL '14 minutes')
     ORDER BY last_scan_at ASC NULLS FIRST, id DESC
     LIMIT $1`,
    [BATCH],
  );
  return due.rows as Row[];
}

async function printRows(rows: Row[]): Promise<{ dead: number; running: number }> {
  const pairs = await pairsForMints(rows.map((r) => r.mint));
  let dead = 0;
  let running = 0;

  for (const row of rows) {
    const pair = pairs.get(row.mint);
    let mc = mcOf(pair);
    let liq = pair?.liquidity?.usd ?? null;
    let image = imageOf(pair);
    if (mc == null) {
      const p = await pumpCoin(row.mint);
      mc = pumpMc(p);
      image = image ?? (p?.image_uri ?? null);
    }
    image = image ?? dexTokenImage(row.mint);

    const detected = row.detected_mc ?? row.admission_mc;
    const freeze = detected ?? mc;
    const last = mc ?? row.last_mc;
    const status = statusOf(last, freeze);

    await pool.query(
      `UPDATE f2_tokens SET
         last_mc = COALESCE($2, last_mc),
         last_liq = COALESCE($3, last_liq),
         peak_mc = GREATEST(COALESCE(peak_mc, 0), COALESCE($2, 0)),
         detected_mc = COALESCE(detected_mc, admission_mc, $4),
         admission_mc = COALESCE(admission_mc, $4),
         image = CASE
           WHEN image IS NULL OR image = '' OR image NOT LIKE 'https://%' THEN COALESCE($5, image)
           ELSE image END,
         symbol = COALESCE(symbol, $6),
         name = COALESCE(name, $7),
         phase = $8,
         stage = CASE WHEN $8 = 'dead' THEN 'killed' ELSE 'tracking' END,
         kill_reason = CASE WHEN $8 = 'dead' THEN 'mc_below_5k' ELSE kill_reason END,
         deceased_at = CASE WHEN $8 = 'dead' THEN COALESCE(deceased_at, NOW()) ELSE deceased_at END,
         last_scan_at = NOW(),
         scans_total = scans_total + 1
       WHERE id = $1`,
      [
        row.id,
        mc,
        liq,
        freeze,
        image,
        pair?.baseToken?.symbol ?? null,
        pair?.baseToken?.name ?? null,
        status,
      ],
    );

    try {
      await pool.query(
        `INSERT INTO f2_scans (token_id, mc_usd, liq_usd, price_usd, pass, fail_reasons, phase)
         VALUES ($1,$2,$3,$4,true,'[]'::jsonb,$5)`,
        [row.id, mc, liq, pair?.priceUsd ? Number(pair.priceUsd) : null, status],
      );
    } catch {
      // scan table always exists after schema pass
    }

    if (status === "dead") dead += 1;
    if (status === "running") running += 1;
  }

  return { dead, running };
}

export async function scanTick(): Promise<{ scanned: number; dead: number; running: number }> {
  let scanned = 0;
  let dead = 0;
  let running = 0;

  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await dueBatch();
    if (!rows.length) break;
    const r = await printRows(rows);
    scanned += rows.length;
    dead += r.dead;
    running += r.running;
  }

  if (scanned) {
    emitSse("desk:update", { scanned, dead, running, at: new Date().toISOString() });
    await agentNote("scan", "PRINT", `scanned ${scanned} · running ${running} · archived ${dead}`, { quiet: true });
  }
  return { scanned, dead, running };
}
