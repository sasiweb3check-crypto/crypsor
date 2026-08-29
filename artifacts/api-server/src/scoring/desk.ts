/**
 * Wallet-buy desk — detected MC is frozen at the buy.
 * Gain is last print vs that freeze. No scoring.
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
