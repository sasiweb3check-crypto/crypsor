/**
 * SCAN — MC prints for wallet-buy tokens.
 * Young or running names: ~50s. Everyone else: 15 minutes.
 * Below $5k → archived. Peak MC stays our own prints (no pump ATH).
 */
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { imageOf, mcOf, pairsForMints, vol5mOf, buys5mOf } from "../sources/dexscreener";
import { coin as pumpCoin, pumpMc } from "../sources/pumpfun";
import { catalystOf, rungOf, statusOf } from "../scoring/desk";
import { dexTokenImage } from "../scoring/image";
import { insertDeskMemory } from "./memory";
import { agentNote } from "./log";
import { raiseAlert } from "./alerts";

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
  wallet_buys: number;
  notified_rung: number | null;
};

async function dueBatch(): Promise<Row[]> {
  const due = await pool.query(
    `SELECT id, mint, symbol,
            detected_mc, admission_mc, last_mc, peak_mc,
            COALESCE(wallet_buys, 0) AS wallet_buys,
            COALESCE(notified_rung, 1) AS notified_rung
     FROM f2_tokens
     WHERE wallet_buys > 0
       AND (
         last_scan_at IS NULL
         OR last_scan_at < NOW() - INTERVAL '14 minutes'
         OR (
           last_scan_at < NOW() - INTERVAL '50 seconds'
           AND (
             discovered_at > NOW() - INTERVAL '6 hours'
             OR COALESCE(last_mc, 0) > COALESCE(detected_mc, admission_mc, 0)
           )
         )
       )
     ORDER BY CASE
       WHEN last_scan_at IS NULL THEN 0
       WHEN discovered_at > NOW() - INTERVAL '6 hours' THEN 1
       WHEN COALESCE(last_mc, 0) > COALESCE(detected_mc, admission_mc, 0) THEN 1
       ELSE 2
     END,
     last_scan_at ASC NULLS FIRST, id DESC
     LIMIT $1`,
    [BATCH],
  );
  return due.rows as Row[];
}

async function printRows(rows: Row[]): Promise<{ dead: number; running: number; rungs: number }> {
  const pairs = await pairsForMints(rows.map((r) => r.mint));
  let dead = 0;
  let running = 0;
  let rungs = 0;

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
    const wallets = row.wallet_buys || 0;
    const vol5m = vol5mOf(pair);
    const buys5m = buys5mOf(pair);
    const prevRung = row.notified_rung && row.notified_rung > 0 ? row.notified_rung : 1;
    const nowRung = rungOf(last, freeze);
    const fireRung = nowRung > prevRung;

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
         notified_rung = $9,
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
        fireRung ? nowRung : prevRung,
      ],
    );

    const stamp = await insertDeskMemory({
      tokenId: row.id,
      mc: last,
      liq,
      detected: freeze,
      wallets,
      vol5m,
    });

    try {
      await pool.query(`UPDATE f2_tokens SET desk_label = $2 WHERE id = $1`, [row.id, stamp.label]);
    } catch {
      // desk_label lands after schema pass
    }

    try {
      await pool.query(
        `INSERT INTO f2_scans (token_id, mc_usd, liq_usd, price_usd, vol_5m, buys_5m, pass, fail_reasons, phase)
         VALUES ($1,$2,$3,$4,$5,$6,true,'[]'::jsonb,$7)`,
        [row.id, mc, liq, pair?.priceUsd ? Number(pair.priceUsd) : null, vol5m, buys5m, status],
      );
    } catch {
      try {
        await pool.query(
          `INSERT INTO f2_scans (token_id, mc_usd, liq_usd, price_usd, pass, fail_reasons, phase)
           VALUES ($1,$2,$3,$4,true,'[]'::jsonb,$5)`,
          [row.id, mc, liq, pair?.priceUsd ? Number(pair.priceUsd) : null, status],
        );
      } catch {
        // scan table always exists after schema pass
      }
    }

    if (fireRung) {
      const ticker = row.symbol || row.mint.slice(0, 6);
      const catalyst = catalystOf({
        lastMc: last,
        detectedMc: freeze,
        prevMc: row.last_mc,
        vol5m,
        liq,
      });
      await raiseAlert({
        tokenId: row.id,
        kind: "rung",
        title: `${nowRung}× $${ticker}`,
        body: catalyst,
        payload: { mint: row.mint, rung: nowRung, mc: last, detected: freeze, score: stamp.score, catalyst },
        lane: "call",
        score: stamp.score,
        screen: true,
        telegram: true,
      });
      rungs += 1;
    }

    if (status === "dead") dead += 1;
    if (status === "running") running += 1;
  }

  return { dead, running, rungs };
}

let catchupDone = false;

/** Names that already 2×+ vs detected but never got a rung alert (MONA-style miss). */
async function catchMissedCalls(): Promise<void> {
  if (catchupDone) return;
  catchupDone = true;
  try {
    await pool.query(
      `UPDATE f2_tokens t SET notified_rung = 1
       WHERE t.wallet_buys > 0
         AND COALESCE(t.last_mc, 0) >= COALESCE(t.detected_mc, t.admission_mc, 1) * 2
         AND COALESCE(t.notified_rung, 1) > 1
         AND NOT EXISTS (
           SELECT 1 FROM ward_alerts a WHERE a.token_id = t.id AND a.kind = 'rung'
         )`,
    );
  } catch {
    // alerts table / columns
  }
}

export async function scanTick(): Promise<{ scanned: number; dead: number; running: number; rungs: number }> {
  await catchMissedCalls();
  let scanned = 0;
  let dead = 0;
  let running = 0;
  let rungs = 0;

  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await dueBatch();
    if (!rows.length) break;
    const r = await printRows(rows);
    scanned += rows.length;
    dead += r.dead;
    running += r.running;
    rungs += r.rungs;
  }

  if (scanned) {
    emitSse("desk:update", { scanned, dead, running, rungs, at: new Date().toISOString() });
    await agentNote(
      "scan",
      "PRINT",
      `scanned ${scanned} · running ${running} · archived ${dead} · rungs ${rungs}`,
      { quiet: true },
    );
  }
  return { scanned, dead, running, rungs };
}
