/**
 * SCAN — MC prints for wallet-buy tokens.
 * Young or running names: ~50s. Everyone else: 15 minutes.
 * Below $5k → archived. Peak MC stays our own prints (no pump ATH).
 */
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import {
  boostsOf, buys5mOf, buysH1Of, imageOf, liqOf, mcOf, pairsForMints,
  priceChgH1Of, priceChgM5Of, sells5mOf, sellsH1Of, vol5mOf, volH1Of,
} from "../sources/dexscreener";
import { coin as pumpCoin, coinsForMints, curveSol, pumpHolders, pumpMc } from "../sources/pumpfun";
import { holderBooks } from "../sources/holders";
import { rungOf, scoreStepOf, statusOf } from "../scoring/desk";
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
  notified_score: number | null;
  notified_holders_rug: boolean;
  discovered_at: string | Date | null;
};

async function dueBatch(): Promise<Row[]> {
  const due = await pool.query(
    `SELECT id, mint, symbol,
            detected_mc, admission_mc, last_mc, peak_mc,
            COALESCE(wallet_buys, 0) AS wallet_buys,
            COALESCE(notified_rung, 1) AS notified_rung,
            COALESCE(notified_score, 0) AS notified_score,
            COALESCE(notified_holders_rug, false) AS notified_holders_rug,
            discovered_at
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
  ).catch(() => pool.query(
    `SELECT id, mint, symbol,
            detected_mc, admission_mc, last_mc, peak_mc,
            COALESCE(wallet_buys, 0) AS wallet_buys,
            COALESCE(notified_rung, 1) AS notified_rung,
            0 AS notified_score,
            false AS notified_holders_rug,
            discovered_at
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
     ORDER BY last_scan_at ASC NULLS FIRST, id DESC
     LIMIT $1`,
    [BATCH],
  ));
  return due.rows as Row[];
}

function ageHours(discovered: string | Date | null | undefined): number | null {
  if (!discovered) return null;
  const t = new Date(discovered).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / 3_600_000);
}

async function printRows(rows: Row[]): Promise<{ dead: number; running: number; rungs: number; scores: number; rugs: number }> {
  const pairs = await pairsForMints(rows.map((r) => r.mint));
  const pumps = await coinsForMints(rows.map((r) => r.mint));
  const holderMints = rows
    .filter((r) => {
      const last = r.last_mc;
      if (last != null && last < 5_000) {
        const age = ageHours(r.discovered_at);
        if (age != null && age > 6) return false;
      }
      return true;
    })
    .map((r) => r.mint);
  const books = await holderBooks(holderMints);
  let dead = 0;
  let running = 0;
  let rungs = 0;
  let scores = 0;
  let rugs = 0;

  for (const row of rows) {
    const pair = pairs.get(row.mint);
    let pump = pumps.get(row.mint) ?? null;
    let mc = mcOf(pair) ?? pumpMc(pump);
    if (mc == null && !pump) {
      const fetched = await pumpCoin(row.mint);
      if (fetched) {
        pumps.set(row.mint, fetched);
        pump = fetched;
      }
      mc = pumpMc(fetched);
    }
    const liq = liqOf(pair);
    let image = imageOf(pair) ?? pump?.image_uri ?? null;
    image = image ?? dexTokenImage(row.mint);

    const detected = row.detected_mc ?? row.admission_mc;
    const freeze = detected ?? mc;
    const last = mc ?? row.last_mc;
    const status = statusOf(last, freeze);
    const wallets = row.wallet_buys || 0;
    const vol5m = vol5mOf(pair);
    const volH1 = volH1Of(pair);
    const buys5m = buys5mOf(pair);
    const sells5m = sells5mOf(pair);
    const book = books.get(row.mint);
    const holderN = book?.holders ?? pumpHolders(pump);
    const measured = book?.measured === true;
    const prevRung = row.notified_rung && row.notified_rung > 0 ? row.notified_rung : 1;
    const nowRung = rungOf(last, freeze);
    const fireRung = nowRung > prevRung;
    const prevScoreStep = scoreStepOf(row.notified_score);

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
        pair?.baseToken?.symbol ?? pump?.symbol ?? null,
        pair?.baseToken?.name ?? pump?.name ?? null,
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
      volH1,
      buys5m,
      sells5m,
      buysH1: buysH1Of(pair),
      sellsH1: sellsH1Of(pair),
      priceChgM5: priceChgM5Of(pair),
      priceChgH1: priceChgH1Of(pair),
      holders: holderN ?? null,
      top10Pct: measured ? book?.top10Pct ?? null : null,
      top10ExclLp: measured ? book?.top10ExclLp ?? null : null,
      top20Pct: measured ? book?.top20Pct ?? null : null,
      lpPct: measured ? book?.lpPct ?? null : null,
      clusterN: measured ? book?.clusterN ?? null : null,
      holdersRug: measured ? book?.holdersRug ?? null : null,
      boosts: boostsOf(pair),
      replies: pump?.reply_count ?? null,
      live: pump?.is_currently_live ?? null,
      graduated: pump?.complete ?? null,
      banned: pump?.is_banned ?? null,
      nsfw: pump?.nsfw ?? null,
      curveSol: curveSol(pump),
      ageHours: ageHours(row.discovered_at),
    });

    const nowScoreStep = scoreStepOf(stamp.score);
    const fireScore = nowScoreStep > prevScoreStep && nowScoreStep > 0;
    try {
      await pool.query(
        `UPDATE f2_tokens SET desk_label = $2, notified_score = $3 WHERE id = $1`,
        [row.id, stamp.label, fireScore ? nowScoreStep : prevScoreStep],
      );
    } catch {
      try {
        await pool.query(`UPDATE f2_tokens SET desk_label = $2 WHERE id = $1`, [row.id, stamp.label]);
      } catch {
        // desk_label lands after schema pass
      }
    }

    try {
      await pool.query(
        `INSERT INTO f2_scans (token_id, mc_usd, liq_usd, price_usd, vol_5m, buys_5m, sells_5m, holders, top10_pct, score, pass, fail_reasons, phase)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,'[]'::jsonb,$11)`,
        [row.id, mc, liq, pair?.priceUsd ? Number(pair.priceUsd) : null, vol5m, buys5m, sells5m, holderN ?? null, measured ? book?.top10Pct ?? null : null, stamp.score, status],
      );
    } catch {
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
    }

    const ticker = row.symbol || row.mint.slice(0, 6);
    const payload = {
      mint: row.mint,
      mc: last,
      detected: freeze,
      score: stamp.score,
      factors: stamp.factors,
      tags: stamp.tags,
      catalyst: stamp.catalyst,
    };

    if (fireRung) {
      await raiseAlert({
        tokenId: row.id,
        kind: "rung",
        title: `${nowRung}× $${ticker}`,
        body: stamp.catalyst,
        payload: { ...payload, rung: nowRung },
        lane: "call",
        score: stamp.score,
        screen: true,
        telegram: true,
      });
      rungs += 1;
    }

    if (fireScore) {
      await raiseAlert({
        tokenId: row.id,
        kind: "score",
        title: `Score ${nowScoreStep} $${ticker}`,
        body: stamp.catalyst,
        payload: { ...payload, scoreStep: nowScoreStep },
        lane: "call",
        score: stamp.score,
        screen: true,
        telegram: true,
      });
      scores += 1;
    }

    if (stamp.survival.holders_rug && !row.notified_holders_rug) {
      await raiseAlert({
        tokenId: row.id,
        kind: "rug",
        title: `Holders rug possible $${ticker}`,
        body: stamp.catalyst,
        payload: {
          ...payload,
          holdersRug: true,
          top10ExclLp: measured ? book?.top10ExclLp ?? null : null,
          clusterN: measured ? book?.clusterN ?? null : null,
        },
        lane: "call",
        score: stamp.score,
        screen: true,
        telegram: true,
      });
      rugs += 1;
      try {
        await pool.query(`UPDATE f2_tokens SET notified_holders_rug = true WHERE id = $1`, [row.id]);
      } catch {
        // column lands after schema pass
      }
    }

    if (status === "dead") dead += 1;
    if (status === "running") running += 1;
  }

  return { dead, running, rungs, scores, rugs };
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

export async function scanTick(): Promise<{ scanned: number; dead: number; running: number; rungs: number; scores: number; rugs: number }> {
  await catchMissedCalls();
  let scanned = 0;
  let dead = 0;
  let running = 0;
  let rungs = 0;
  let scores = 0;
  let rugs = 0;

  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await dueBatch();
    if (!rows.length) break;
    const r = await printRows(rows);
    scanned += rows.length;
    dead += r.dead;
    running += r.running;
    rungs += r.rungs;
    scores += r.scores;
    rugs += r.rugs;
  }

  if (scanned) {
    emitSse("desk:update", { scanned, dead, running, rungs, scores, rugs, at: new Date().toISOString() });
    await agentNote(
      "scan",
      "PRINT",
      `scanned ${scanned} · running ${running} · archived ${dead} · rungs ${rungs} · scores ${scores} · holder rugs ${rugs}`,
      { quiet: true },
    );
  }
  return { scanned, dead, running, rungs, scores, rugs };
}
