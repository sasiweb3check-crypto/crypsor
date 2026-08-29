/**
 * Wallet-buy desk — detected MC is frozen at the buy.
 * Gain is last print vs that freeze. Snapshot score is frozen at each print.
 */

export const MC_DEAD = 5_000;
export const EARLY_MIN = 5_000;
export const EARLY_MAX = 30_000;
export const LATE_MC = 80_000;
/** Multiples vs the buy freeze. 3× is the missed MONA-style call. */
export const RUNGS = [2, 3, 5, 10, 20] as const;
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

/** Last print under $5k is archived. Detected-under-5k is still a live watch. */
export function statusOf(lastMc: number | null | undefined, detectedMc: number | null | undefined): TokenStatus {
  const last = lastMc != null && Number.isFinite(lastMc) ? lastMc : null;
  const det = detectedMc != null && Number.isFinite(detectedMc) ? detectedMc : null;
  if (last != null && last < MC_DEAD) return "dead";
  if (last != null && det != null && det > 0 && last > det) return "running";
  return "live";
}

/** Highest 2/3/5/10/20 multiple last print has cleared vs detected. ATH is not used. */
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
 * Label from last print vs detected. Tracked-wallet count is not used —
 * wallets are only how the name entered the book.
 */
export function labelOf(opts: {
  lastMc: number | null | undefined;
  detectedMc: number | null | undefined;
  walletBuys?: number;
}): DeskLabel {
  const last = opts.lastMc != null && Number.isFinite(opts.lastMc) ? opts.lastMc : null;
  const det = opts.detectedMc != null && Number.isFinite(opts.detectedMc) ? opts.detectedMc : null;
  if (last != null && last < MC_DEAD) return "dead";
  const x = multipleOf(last ?? det, det) ?? 1;
  if (x >= 3) return "runner";
  if (x >= 2) return "call";
  if (det != null && det > LATE_MC) return "late";
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

export type AlertLane = "early" | "high" | "call";

export type ScorePoint = {
  mc: number | null | undefined;
  liq: number | null | undefined;
  detected: number | null | undefined;
  wallets?: number;
  vol5m?: number | null;
  label: DeskLabel;
  survived: boolean;
  score?: number | null;
};

export const SCORE_BUCKETS = ["0-19", "20-39", "40-59", "60-79", "80-100"] as const;
export type ScoreBucketName = (typeof SCORE_BUCKETS)[number];

export function alertLane(_detectedMc?: number | null): AlertLane {
  return "call";
}

/** Confidence rungs and admits always hit the desk. Wallet-count confirms do not. */
export function screenAlert(lane: AlertLane): boolean {
  return lane !== "high";
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
 * Multiple vs detected is the call. Volume / MC diffs from memory support it.
 * Tracked-wallet count is ignored.
 */
export function scoreAtPoint(now: ScorePoint, prev: ScorePoint | null): number {
  if (!now.survived || now.label === "dead") return 0;

  const x = multipleOf(now.mc, now.detected) ?? 1;
  let s = 24;
  if (x >= 1.2) s = 36;
  if (x >= 2) s = 58;
  if (x >= 3) s = 74;
  if (x >= 5) s = 88;
  if (x >= 10) s = 95;

  if (prev) {
    const mcD = pctDelta(now.mc, prev.mc);
    if (mcD != null) {
      if (mcD >= 15) s += 8;
      else if (mcD >= 5) s += 4;
      else if (mcD <= -35) s -= 16;
      else if (mcD <= -15) s -= 8;
    }
    const liqD = pctDelta(now.liq, prev.liq);
    if (liqD != null) {
      if (liqD <= -40) s -= 12;
      else if (liqD >= 20) s += 3;
    }
    const volD = pctDelta(now.vol5m, prev.vol5m);
    if (volD != null && volD >= 40) s += 6;
    if (prev.survived && now.mc != null && prev.mc != null && now.mc >= prev.mc) s += 3;
  }

  return clampScore(s);
}

/** Why this print is a call — MC vs the buy freeze, then snapshot diffs / 5m volume. */
export function catalystOf(opts: {
  lastMc: number | null | undefined;
  detectedMc: number | null | undefined;
  prevMc?: number | null;
  vol5m?: number | null;
  prevVol5m?: number | null;
  liq?: number | null;
}): string {
  const parts: string[] = [];
  const x = multipleOf(opts.lastMc, opts.detectedMc);
  if (x != null) parts.push(`${x.toFixed(1)}× vs detected ${fmtMc(opts.detectedMc)}`);
  const mcD = pctDelta(opts.lastMc, opts.prevMc);
  if (mcD != null && Math.abs(mcD) >= 8) {
    parts.push(`MC ${mcD > 0 ? "+" : ""}${mcD.toFixed(0)}% since last print`);
  }
  if (opts.vol5m != null && Number.isFinite(opts.vol5m) && opts.vol5m > 0) {
    parts.push(`5m vol ${fmtMc(opts.vol5m)}`);
  }
  const volD = pctDelta(opts.vol5m, opts.prevVol5m);
  if (volD != null && volD >= 40) parts.push(`vol +${volD.toFixed(0)}%`);
  if (!parts.length) return "Waiting on the next MC print vs detected.";
  return parts.join(" · ");
}
