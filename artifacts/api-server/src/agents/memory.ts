/**
 * Thin desk memory — one snapshot per scan print.
 * Score is frozen here (not on list poll). Diffs vs the previous row feed the next score.
 */
import { pool } from "../core/db";
import {
  alertLane, catalystOf, gainPct, labelOf, pctDelta, scoreBreakdown, statusOf, survives,
  type AlertLane, type DeskLabel, type FactorScores, type ScorePoint,
} from "../scoring/desk";

export type DeskStampResult = {
  label: DeskLabel;
  score: number;
  prevScore: number | null;
  scoreDelta: number | null;
  lane: AlertLane;
  catalyst: string;
  factors: FactorScores;
  tags: string[];
};

type PrevRow = {
  mc_usd: number | null;
  liq_usd: number | null;
  detected_mc: number | null;
  wallets: number | null;
  label: string | null;
  survived: boolean | null;
  score: number | null;
  vol_5m?: number | null;
  vol_h1?: number | null;
  buys_5m?: number | null;
  sells_5m?: number | null;
  holders?: number | null;
  boosts?: number | null;
  replies?: number | null;
  price_chg_m5?: number | null;
};

export type MemoryPrint = {
  tokenId: number;
  mc: number | null;
  liq: number | null;
  detected: number | null;
  wallets: number;
  vol5m?: number | null;
  volH1?: number | null;
  buys5m?: number | null;
  sells5m?: number | null;
  buysH1?: number | null;
  sellsH1?: number | null;
  priceChgM5?: number | null;
  priceChgH1?: number | null;
  holders?: number | null;
  top10Pct?: number | null;
  boosts?: number | null;
  replies?: number | null;
  live?: boolean | null;
  graduated?: boolean | null;
  banned?: boolean | null;
  nsfw?: boolean | null;
  curveSol?: number | null;
  ageHours?: number | null;
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

function pointFromPrev(prev: PrevRow, fallback: DeskLabel): ScorePoint {
  return {
    mc: prev.mc_usd,
    liq: prev.liq_usd,
    detected: prev.detected_mc,
    vol5m: prev.vol_5m ?? null,
    volH1: prev.vol_h1 ?? null,
    buys5m: prev.buys_5m ?? null,
    sells5m: prev.sells_5m ?? null,
    holders: prev.holders ?? null,
    boosts: prev.boosts ?? null,
    replies: prev.replies ?? null,
    priceChgM5: prev.price_chg_m5 ?? null,
    label: (prev.label as DeskLabel) || fallback,
    survived: Boolean(prev.survived),
    score: prev.score,
  };
}

function pointFromPrint(opts: MemoryPrint, stamp: ReturnType<typeof deskStamp>): ScorePoint {
  return {
    mc: opts.mc,
    liq: opts.liq,
    detected: opts.detected,
    vol5m: opts.vol5m ?? null,
    volH1: opts.volH1 ?? null,
    buys5m: opts.buys5m ?? null,
    sells5m: opts.sells5m ?? null,
    buysH1: opts.buysH1 ?? null,
    sellsH1: opts.sellsH1 ?? null,
    priceChgM5: opts.priceChgM5 ?? null,
    priceChgH1: opts.priceChgH1 ?? null,
    holders: opts.holders ?? null,
    top10Pct: opts.top10Pct ?? null,
    boosts: opts.boosts ?? null,
    replies: opts.replies ?? null,
    live: opts.live ?? null,
    graduated: opts.graduated ?? null,
    banned: opts.banned ?? null,
    nsfw: opts.nsfw ?? null,
    curveSol: opts.curveSol ?? null,
    ageHours: opts.ageHours ?? null,
    label: stamp.label,
    survived: stamp.survived,
  };
}

async function prevMemory(tokenId: number): Promise<PrevRow | null> {
  const selects = [
    `SELECT mc_usd, liq_usd, detected_mc, wallets, label, survived, score,
            vol_5m, vol_h1, buys_5m, sells_5m, holders, boosts, replies, price_chg_m5
     FROM desk_memory WHERE token_id = $1 ORDER BY at DESC LIMIT 1`,
    `SELECT mc_usd, liq_usd, detected_mc, wallets, label, survived, score, vol_5m
     FROM desk_memory WHERE token_id = $1 ORDER BY at DESC LIMIT 1`,
    `SELECT mc_usd, liq_usd, detected_mc, wallets, label, survived, score
     FROM desk_memory WHERE token_id = $1 ORDER BY at DESC LIMIT 1`,
  ];
  for (const sql of selects) {
    try {
      const r = await pool.query(sql, [tokenId]);
      return (r.rows[0] as PrevRow | undefined) ?? null;
    } catch {
      // older desk_memory shape
    }
  }
  return null;
}

function buyRatio(buys: number | null | undefined, sells: number | null | undefined): number | null {
  const b = buys != null && Number.isFinite(buys) ? buys : 0;
  const s = sells != null && Number.isFinite(sells) ? sells : 0;
  if (b + s <= 0) return null;
  return b / (b + s);
}

export async function insertDeskMemory(opts: MemoryPrint): Promise<DeskStampResult> {
  const stamp = deskStamp({ lastMc: opts.mc, detectedMc: opts.detected, walletBuys: opts.wallets });
  const lane = alertLane(opts.detected);
  const prev = await prevMemory(opts.tokenId);
  const prevPoint = prev ? pointFromPrev(prev, stamp.label) : null;
  const nowPoint = pointFromPrint(opts, stamp);
  const broken = scoreBreakdown(nowPoint, prevPoint);
  const score = broken.score;
  const prevScore = prev?.score ?? null;
  const scoreDelta = prevScore != null ? score - prevScore : null;
  const mcDelta = pctDelta(opts.mc, prev?.mc_usd);
  const liqDelta = pctDelta(opts.liq, prev?.liq_usd);
  const walletDelta = prev ? opts.wallets - Number(prev.wallets ?? 0) : null;
  const catalyst = broken.catalyst || catalystOf({
    lastMc: opts.mc,
    detectedMc: opts.detected,
    prevMc: prev?.mc_usd,
    vol5m: opts.vol5m,
    prevVol5m: prev?.vol_5m,
    liq: opts.liq,
  });
  const ratio = buyRatio(opts.buys5m, opts.sells5m);

  try {
    await pool.query(
      `INSERT INTO desk_memory
         (token_id, mc_usd, liq_usd, detected_mc, gain_pct, wallets, status, label, survived,
          score, prev_score, score_delta, mc_delta_pct, liq_delta_pct, wallet_delta, band,
          vol_5m, catalyst, factors, vol_h1, buys_5m, sells_5m, holders, buy_ratio, boosts, replies, price_chg_m5)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
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
        opts.vol5m ?? null,
        catalyst,
        JSON.stringify(broken.factors),
        opts.volH1 ?? null,
        opts.buys5m ?? null,
        opts.sells5m ?? null,
        opts.holders ?? null,
        ratio,
        opts.boosts ?? null,
        opts.replies ?? null,
        opts.priceChgM5 ?? null,
      ],
    );
  } catch {
    try {
      await pool.query(
        `INSERT INTO desk_memory
           (token_id, mc_usd, liq_usd, detected_mc, gain_pct, wallets, status, label, survived,
            score, prev_score, score_delta, mc_delta_pct, liq_delta_pct, wallet_delta, band,
            vol_5m, catalyst)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          opts.tokenId, opts.mc, opts.liq, opts.detected, stamp.gain,
          opts.wallets, stamp.status, stamp.label, stamp.survived,
          score, prevScore, scoreDelta, mcDelta, liqDelta, walletDelta, lane,
          opts.vol5m ?? null, catalyst,
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
  }

  try {
    await pool.query(
      `UPDATE f2_tokens SET desk_score = $2, desk_prev_score = $3, desk_score_at = NOW(),
         last_holders = COALESCE($4, last_holders) WHERE id = $1`,
      [opts.tokenId, score, prevScore, opts.holders ?? null],
    );
  } catch {
    try {
      await pool.query(
        `UPDATE f2_tokens SET desk_score = $2, desk_prev_score = $3, desk_score_at = NOW() WHERE id = $1`,
        [opts.tokenId, score, prevScore],
      );
    } catch {
      // columns land after schema pass
    }
  }

  return {
    label: stamp.label,
    score,
    prevScore,
    scoreDelta,
    lane,
    catalyst,
    factors: broken.factors,
    tags: broken.tags,
  };
}
