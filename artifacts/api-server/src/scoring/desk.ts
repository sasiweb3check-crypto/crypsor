/**
 * Wallet-buy desk — detected MC is frozen at the buy.
 * Gain is last print vs that freeze. Snapshot score is frozen at each print.
 */

export const MC_DEAD = 5_000;
export const EARLY_MIN = 5_000;
export const EARLY_MAX = 30_000;
export const LATE_MC = 80_000;
export const RUNGS = [2, 5, 10, 20] as const;
export const MATRIX_RUNGS = [2, 5, 10] as const;

export type TokenStatus = "live" | "running" | "dead";
export type Rung = 1 | (typeof RUNGS)[number];
/** Surviving label. Does not hide a name from the desk. */
export type DeskLabel = "dead" | "late" | "runner" | "call" | "heat" | "watch";

export function gainPct(lastMc: number | null | undefined, detectedMc: number | null | undefined): number | null {
  if (lastMc == null || detectedMc == null || !Number.isFinite(lastMc) || !Number.isFinite(detectedMc) || detectedMc <= 0) {
    return null;
  }
  return ((lastMc / detectedMc) - 1) * 100;
}

/** MC under $5k is archived. Positive gain vs detected is running. Else live. */
export function statusOf(lastMc: number | null | undefined, detectedMc: number | null | undefined): TokenStatus {
  const last = lastMc != null && Number.isFinite(lastMc) ? lastMc : null;
  const det = detectedMc != null && Number.isFinite(detectedMc) ? detectedMc : null;
  const mc = last ?? det;
  if (mc != null && mc < MC_DEAD) return "dead";
  if (last != null && det != null && det > 0 && last > det) return "running";
  return "live";
}

/** Highest 2/5/10/20 multiple last print has cleared vs detected. ATH is not used. */
export function rungOf(lastMc: number | null | undefined, detectedMc: number | null | undefined): Rung {
  if (lastMc == null || detectedMc == null || !Number.isFinite(lastMc) || !Number.isFinite(detectedMc) || detectedMc <= 0) {
    return 1;
  }
  const x = lastMc / detectedMc;
  let rung: Rung = 1;
  for (const t of RUNGS) {
    if (x >= t) rung = t;
  }
  return rung;
}

export function inEarlyBand(detectedMc: number | null | undefined): boolean {
  return detectedMc != null && Number.isFinite(detectedMc) && detectedMc >= EARLY_MIN && detectedMc <= EARLY_MAX;
}

export function multipleOf(lastMc: number | null | undefined, detectedMc: number | null | undefined): number | null {
  if (lastMc == null || detectedMc == null || !Number.isFinite(lastMc) || !Number.isFinite(detectedMc) || detectedMc <= 0) {
    return null;
  }
  return lastMc / detectedMc;
}

export function survives(lastMc: number | null | undefined, detectedMc: number | null | undefined): boolean {
  return statusOf(lastMc, detectedMc) !== "dead";
}

/**
 * Current label from last print vs detected. Peak is not used (ATH stays a separate number).
 * late = detected above $80k — still tracked, never an "early" call.
 */
export function labelOf(opts: {
  lastMc: number | null | undefined;
  detectedMc: number | null | undefined;
  walletBuys: number;
}): DeskLabel {
  const last = opts.lastMc != null && Number.isFinite(opts.lastMc) ? opts.lastMc : null;
  const det = opts.detectedMc != null && Number.isFinite(opts.detectedMc) ? opts.detectedMc : null;
  if (statusOf(last, det) === "dead") return "dead";
  const x = multipleOf(last ?? det, det) ?? 1;
  const wallets = opts.walletBuys || 0;
  const high = det != null && det > LATE_MC;
  if (x >= 5 || (wallets >= 3 && x >= 1.5)) return "runner";
  if (x >= 2) return "call";
  if (high) return "late";
  if (wallets >= 2 && last != null && det != null && last >= 0.8 * det && last >= MC_DEAD) return "heat";
  return "watch";
}

export type GainMatrix = {
  n: number;
  now: Record<string, { n: number; pct: number }>;
  peak: Record<string, { n: number; pct: number }>;
};

export function gainMatrix(
  cards: Array<{ gain_pct: number | null; ath_pct: number | null }>,
): GainMatrix {
  const n = cards.length;
  const bucket = (pct: number | null, m: number) => pct != null && 1 + pct / 100 >= m;
  const now: GainMatrix["now"] = {};
  const peak: GainMatrix["peak"] = {};
  for (const m of MATRIX_RUNGS) {
    const nowN = cards.filter((c) => bucket(c.gain_pct, m)).length;
    const peakN = cards.filter((c) => bucket(c.ath_pct, m)).length;
    now[String(m)] = { n: nowN, pct: n ? (nowN / n) * 100 : 0 };
    peak[String(m)] = { n: peakN, pct: n ? (peakN / n) * 100 : 0 };
  }
  return { n, now, peak };
}

export function fmtMc(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

export type AlertLane = "early" | "high";

export type ScorePoint = {
  mc: number | null | undefined;
  liq: number | null | undefined;
  detected: number | null | undefined;
  wallets: number;
  label: DeskLabel;
  survived: boolean;
  score?: number | null;
};

export const SCORE_BUCKETS = ["0-19", "20-39", "40-59", "60-79", "80-100"] as const;
export type ScoreBucketName = (typeof SCORE_BUCKETS)[number];

export function alertLane(detectedMc: number | null | undefined): AlertLane {
  return inEarlyBand(detectedMc) ? "early" : "high";
}

/** Desk toasts + Telegram. High-MC prints stay off the screen. */
export function screenAlert(lane: AlertLane): boolean {
  return lane === "early";
}

export function scoreBucket(score: number | null | undefined): ScoreBucketName | null {
  if (score == null || !Number.isFinite(score)) return null;
  if (score < 20) return "0-19";
  if (score < 40) return "20-39";
  if (score < 60) return "40-59";
  if (score < 80) return "60-79";
  return "80-100";
}

export function pctDelta(now: number | null | undefined, prev: number | null | undefined): number | null {
  if (now == null || prev == null || !Number.isFinite(now) || !Number.isFinite(prev) || prev === 0) {
    return null;
  }
  return ((now - prev) / prev) * 100;
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Score this print against the previous snapshot. Frozen until the next print.
 * Uses label + detected band + diffs (MC / liq / wallets) + last frozen score.
 */
export function scoreAtPoint(now: ScorePoint, prev: ScorePoint | null): number {
  if (!now.survived || now.label === "dead") return 0;

  let s = 22;
  if (now.label === "watch") s = 28;
  else if (now.label === "heat") s = 44;
  else if (now.label === "late") s = 32;
  else if (now.label === "call") s = 64;
  else if (now.label === "runner") s = 84;

  if (inEarlyBand(now.detected)) s += 8;
  else if (now.detected != null && now.detected > EARLY_MAX) s -= 6;

  const x = multipleOf(now.mc, now.detected);
  if (x != null) {
    if (x >= 1) s += 6;
    if (x >= 1.5) s += 6;
    if (x < 0.6) s -= 12;
  }

  if (prev) {
    const mcD = pctDelta(now.mc, prev.mc);
    if (mcD != null) {
      if (mcD >= 15) s += 10;
      else if (mcD >= 5) s += 5;
      else if (mcD <= -35) s -= 18;
      else if (mcD <= -15) s -= 8;
    }
    const liqD = pctDelta(now.liq, prev.liq);
    if (liqD != null) {
      if (liqD <= -40) s -= 15;
      else if (liqD >= 20) s += 4;
    }
    const w = (now.wallets || 0) - (prev.wallets || 0);
    if (w > 0) s += Math.min(20, w * 12);
    if (prev.survived && now.mc != null && prev.mc != null && now.mc >= prev.mc) s += 4;

    const prevScore = prev.score;
    if (prevScore != null && Number.isFinite(prevScore)) {
      if (prevScore >= 60 && mcD != null && mcD >= 5) s += 6;
      if (prevScore >= 60 && mcD != null && mcD <= -15) s -= 10;
    }
  }

  return clampScore(s);
}
