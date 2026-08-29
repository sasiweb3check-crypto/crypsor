/**
 * Thin desk memory — one snapshot per scan print.
 * Score is frozen here (not on list poll). Diffs vs the previous row feed the next score.
 */
import { pool } from "../core/db";
import {
  alertLane, gainPct, labelOf, pctDelta, scoreAtPoint, statusOf, survives,
  type AlertLane, type DeskLabel,
} from "../scoring/desk";

export type DeskStampResult = {
  label: DeskLabel;
  score: number;
  prevScore: number | null;
  scoreDelta: number | null;
  lane: AlertLane;
};

type PrevRow = {
  mc_usd: number | null;
  liq_usd: number | null;
  detected_mc: number | null;
  wallets: number | null;
  label: string | null;
  survived: boolean | null;
  score: number | null;
};

export function deskStamp(opts: {
  lastMc: number | null | undefined;
  detectedMc: number | null | undefined;
  walletBuys: number;
}): { label: DeskLabel; status: ReturnType<typeof statusOf>; survived: boolean; gain: number | null } {
  const last = opts.lastMc ?? null;
  const det = opts.detectedMc ?? null;
  return {
    label: labelOf({ lastMc: last, detectedMc: det, walletBuys: opts.walletBuys }),
    status: statusOf(last, det),
    survived: survives(last, det),
    gain: gainPct(last, det),
  };
}

async function prevMemory(tokenId: number): Promise<PrevRow | null> {
  try {
    const r = await pool.query(
      `SELECT mc_usd, liq_usd, detected_mc, wallets, label, survived, score
       FROM desk_memory WHERE token_id = $1 ORDER BY at DESC LIMIT 1`,
      [tokenId],
    );
    return (r.rows[0] as PrevRow | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function insertDeskMemory(opts: {
  tokenId: number;
  mc: number | null;
  liq: number | null;
  detected: number | null;
  wallets: number;
}): Promise<DeskStampResult> {
  const stamp = deskStamp({ lastMc: opts.mc, detectedMc: opts.detected, walletBuys: opts.wallets });
  const lane = alertLane(opts.detected);
  const prev = await prevMemory(opts.tokenId);
  const prevPoint = prev
    ? {
      mc: prev.mc_usd,
      liq: prev.liq_usd,
      detected: prev.detected_mc,
      wallets: Number(prev.wallets ?? 0),
      label: (prev.label as DeskLabel) || stamp.label,
      survived: Boolean(prev.survived),
      score: prev.score,
    }
    : null;
  const score = scoreAtPoint(
    {
      mc: opts.mc,
      liq: opts.liq,
      detected: opts.detected,
      wallets: opts.wallets,
      label: stamp.label,
      survived: stamp.survived,
    },
    prevPoint,
  );
  const prevScore = prev?.score ?? null;
  const scoreDelta = prevScore != null ? score - prevScore : null;
  const mcDelta = pctDelta(opts.mc, prev?.mc_usd);
  const liqDelta = pctDelta(opts.liq, prev?.liq_usd);
  const walletDelta = prev ? opts.wallets - Number(prev.wallets ?? 0) : null;

  try {
    await pool.query(
      `INSERT INTO desk_memory
         (token_id, mc_usd, liq_usd, detected_mc, gain_pct, wallets, status, label, survived,
          score, prev_score, score_delta, mc_delta_pct, liq_delta_pct, wallet_delta, band)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        opts.tokenId,
        opts.mc,
        opts.liq,
        opts.detected,
        stamp.gain,
        opts.wallets,
        stamp.status,
        stamp.label,
        stamp.survived,
        score,
        prevScore,
        scoreDelta,
        mcDelta,
        liqDelta,
        walletDelta,
        lane,
      ],
    );
  } catch {
    try {
      await pool.query(
        `INSERT INTO desk_memory
           (token_id, mc_usd, liq_usd, detected_mc, gain_pct, wallets, status, label, survived)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          opts.tokenId, opts.mc, opts.liq, opts.detected, stamp.gain,
          opts.wallets, stamp.status, stamp.label, stamp.survived,
        ],
      );
    } catch {
      // table appears after schema pass
    }
  }

  try {
    await pool.query(
      `UPDATE f2_tokens SET desk_score = $2, desk_prev_score = $3, desk_score_at = NOW() WHERE id = $1`,
      [opts.tokenId, score, prevScore],
    );
  } catch {
    // columns land after schema pass
  }

  return { label: stamp.label, score, prevScore, scoreDelta, lane };
}
