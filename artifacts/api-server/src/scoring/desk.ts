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
  label: DeskLabel;
  survived: boolean;
  score?: number | null;
};

export type FactorKey =
  | "multiple"
  | "mc_path"
  | "liquidity"
  | "volume"
  | "flow"
  | "holders"
  | "attention"
  | "tape";

export type FactorScores = Partial<Record<FactorKey, number>>;

export type ScoreBreakdown = {
  score: number;
  factors: FactorScores;
  tags: string[];
  catalyst: string;
};

/** Upward frozen-score callouts. Independent of 2×/3×/5× rungs. */
export const SCORE_STEPS = [40, 60, 80] as const;
export type ScoreStep = 0 | (typeof SCORE_STEPS)[number];

export function scoreStepOf(score: number | null | undefined): ScoreStep {
  if (score == null || !Number.isFinite(score)) return 0;
  let step: ScoreStep = 0;
  for (const t of SCORE_STEPS) {
    if (score >= t) step = t;
  }
  return step;
}

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

function num(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

/** Interpolate y along sorted x. */
export function band(x: number, xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length === 0) return 0;
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) {
      const span = xs[i] - xs[i - 1];
      const t = span === 0 ? 0 : (x - xs[i - 1]) / span;
      return ys[i - 1] + t * (ys[i] - ys[i - 1]);
    }
  }
  return ys[ys.length - 1];
}

function buyRatio(buys: number | null | undefined, sells: number | null | undefined): number | null {
  const b = num(buys) ?? 0;
  const s = num(sells) ?? 0;
  const n = b + s;
  if (n <= 0) return null;
  return b / n;
}

/**
 * Weights when that factor actually printed. Missing data is skipped and
 * the rest is renormalized — a blank holder crawl does not dump the score.
 * Tracked-wallet count is never a factor.
 */
export const FACTOR_WEIGHTS: Record<FactorKey, number> = {
  multiple: 22,
  mc_path: 16,
  liquidity: 14,
  volume: 12,
  flow: 12,
  holders: 10,
  attention: 8,
  tape: 6,
};

function multipleFactor(now: ScorePoint): number | null {
  const x = multipleOf(now.mc, now.detected);
  if (x == null) return null;
  return band(x, [1, 1.2, 2, 3, 5, 10, 20], [24, 36, 58, 74, 88, 95, 98]);
}

function mcPathFactor(now: ScorePoint, prev: ScorePoint | null): number | null {
  const d = pctDelta(now.mc, prev?.mc);
  if (d == null) return null;
  return band(d, [-40, -15, 0, 8, 20, 50], [12, 28, 50, 62, 76, 90]);
}

function liquidityFactor(now: ScorePoint, prev: ScorePoint | null): number | null {
  const liq = num(now.liq);
  const curve = num(now.curveSol);
  if (liq == null && curve == null) return null;
  let s: number;
  if (liq != null) {
    s = band(liq, [500, 2_000, 5_000, 8_000, 15_000, 40_000, 100_000], [12, 22, 38, 48, 58, 70, 78]);
    const mc = num(now.mc);
    if (mc != null && mc > 0) {
      const ratio = liq / mc;
      if (ratio < 0.04) s = Math.min(s, 28);
      else if (ratio >= 0.15) s = Math.min(100, s + 8);
    }
  } else {
    s = band(curve ?? 0, [2, 10, 20, 40, 80], [18, 40, 52, 66, 76]);
  }
  const liqD = pctDelta(now.liq, prev?.liq);
  if (liqD != null) {
    if (liqD <= -40) s -= 22;
    else if (liqD <= -20) s -= 10;
    else if (liqD >= 25) s += 6;
  }
  return Math.max(0, Math.min(100, s));
}

function volumeFactor(now: ScorePoint, prev: ScorePoint | null): number | null {
  const vol5 = num(now.vol5m);
  const volH1 = num(now.volH1);
  if (vol5 == null && volH1 == null) return null;
  const mc = num(now.mc);
  let s: number;
  if (vol5 != null && mc != null && mc > 0) {
    s = band(vol5 / mc, [0.002, 0.01, 0.03, 0.08, 0.2], [28, 42, 58, 75, 90]);
  } else if (vol5 != null) {
    s = band(vol5, [50, 400, 2_000, 8_000, 25_000], [22, 38, 55, 70, 84]);
  } else {
    s = band(volH1 ?? 0, [200, 2_000, 10_000, 40_000], [28, 48, 64, 78]);
  }
  if (volH1 != null && vol5 != null && volH1 > 0 && vol5 / volH1 >= 0.25) s = Math.min(100, s + 6);
  const volD = pctDelta(vol5, prev?.vol5m);
  if (volD != null && volD >= 40) s = Math.min(100, s + 8);
  else if (volD != null && volD <= -50) s = Math.max(0, s - 10);
  return s;
}

function flowFactor(now: ScorePoint): number | null {
  const m5 = buyRatio(now.buys5m, now.sells5m);
  const h1 = buyRatio(now.buysH1, now.sellsH1);
  if (m5 == null && h1 == null) return null;
  const ratio = m5 ?? h1 ?? 0.5;
  let s = band(ratio, [0.2, 0.4, 0.5, 0.62, 0.75, 0.9], [18, 35, 50, 64, 78, 90]);
  if (m5 != null && h1 != null) {
    if (m5 >= 0.62 && h1 >= 0.55) s = Math.min(100, s + 6);
    if (m5 <= 0.38 && h1 <= 0.45) s = Math.max(0, s - 8);
  }
  return s;
}

function holdersFactor(now: ScorePoint, prev: ScorePoint | null): number | null {
  const n = num(now.holders);
  if (n == null) return null;
  let s = band(n, [10, 50, 150, 400, 1_000, 5_000], [22, 38, 52, 64, 76, 88]);
  const d = pctDelta(n, prev?.holders);
  if (d != null) {
    if (d >= 20) s = Math.min(100, s + 12);
    else if (d >= 8) s = Math.min(100, s + 6);
    else if (d <= -20) s = Math.max(0, s - 18);
    else if (d <= -8) s = Math.max(0, s - 8);
  }
  const top = num(now.top10Pct);
  if (top != null && top >= 55) s = Math.max(0, s - 15);
  return s;
}

function attentionFactor(now: ScorePoint): number | null {
  const replies = num(now.replies);
  const boosts = num(now.boosts);
  const live = now.live === true;
  const graduated = now.graduated === true;
  const banned = now.banned === true || now.nsfw === true;
  if (replies == null && boosts == null && !live && !graduated && !banned) return null;
  if (banned) return 8;
  let s = replies != null ? band(replies, [0, 5, 20, 60, 200], [18, 35, 52, 68, 80]) : 40;
  if (live) s = Math.min(100, s + 18);
  if ((boosts ?? 0) > 0) s = Math.min(100, s + 10);
  if (graduated) s = Math.min(100, s + 6);
  return s;
}

function tapeFactor(now: ScorePoint): number | null {
  const m5 = num(now.priceChgM5);
  const h1 = num(now.priceChgH1);
  if (m5 == null && h1 == null) return null;
  const chg = m5 ?? h1 ?? 0;
  return band(chg, [-25, -10, 0, 10, 25], [18, 32, 50, 68, 82]);
}

function blendFactors(parts: FactorScores): { score: number; used: FactorScores } {
  let w = 0;
  let s = 0;
  const used: FactorScores = {};
  for (const key of Object.keys(FACTOR_WEIGHTS) as FactorKey[]) {
    const v = parts[key];
    if (v == null || !Number.isFinite(v)) continue;
    const wt = FACTOR_WEIGHTS[key];
    used[key] = Math.round(v);
    w += wt;
    s += wt * v;
  }
  if (w <= 0) return { score: 24, used };
  return { score: s / w, used };
}

function ageScale(now: ScorePoint): number {
  const hours = num(now.ageHours);
  const x = multipleOf(now.mc, now.detected) ?? 1;
  if (hours == null) return 1;
  if (hours < 0.25) return 0.94;
  if (hours <= 6) return 1.04;
  if (hours > 48 && x < 1.2) return 0.92;
  return 1;
}

export function factorTags(now: ScorePoint, prev: ScorePoint | null, factors: FactorScores): string[] {
  const tags: string[] = [];
  const x = multipleOf(now.mc, now.detected);
  if (x != null && x >= 2) tags.push("multiple");
  const mcD = pctDelta(now.mc, prev?.mc);
  if (mcD != null && mcD >= 8) tags.push("mc_up");
  if (mcD != null && mcD <= -15) tags.push("mc_down");
  const liqD = pctDelta(now.liq, prev?.liq);
  if (liqD != null && liqD <= -40) tags.push("liq_drain");
  if ((factors.volume ?? 0) >= 70) tags.push("volume");
  const ratio = buyRatio(now.buys5m, now.sells5m);
  if (ratio != null && ratio >= 0.62) tags.push("buy_pressure");
  if (ratio != null && ratio <= 0.38) tags.push("sell_pressure");
  if ((factors.holders ?? 0) >= 70) tags.push("holders");
  const holdD = pctDelta(now.holders, prev?.holders);
  if (holdD != null && holdD >= 8) tags.push("holder_in");
  if (holdD != null && holdD <= -8) tags.push("holder_out");
  if (now.live === true) tags.push("live");
  if ((now.boosts ?? 0) > 0) tags.push("dex_boost");
  if ((now.replies ?? 0) >= 10) tags.push("replies");
  if (now.graduated === true) tags.push("graduated");
  if ((factors.flow ?? 0) >= 70 && (factors.multiple ?? 100) < 50) tags.push("accumulation");
  return tags;
}

export type CatalystOpts = {
  lastMc: number | null | undefined;
  detectedMc: number | null | undefined;
  prevMc?: number | null;
  vol5m?: number | null;
  prevVol5m?: number | null;
  volH1?: number | null;
  liq?: number | null;
  prevLiq?: number | null;
  buys5m?: number | null;
  sells5m?: number | null;
  holders?: number | null;
  prevHolders?: number | null;
  boosts?: number | null;
  replies?: number | null;
  live?: boolean | null;
  tags?: string[];
};

/** Why this print is a call — named factors, not multiple-only. */
export function catalystOf(opts: CatalystOpts): string {
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
  const ratio = buyRatio(opts.buys5m, opts.sells5m);
  if (ratio != null) {
    const buys = num(opts.buys5m) ?? 0;
    const sells = num(opts.sells5m) ?? 0;
    parts.push(`5m ${buys}b/${sells}s`);
  }
  if (opts.liq != null && Number.isFinite(opts.liq) && opts.liq > 0) {
    parts.push(`liq ${fmtMc(opts.liq)}`);
  }
  const liqD = pctDelta(opts.liq, opts.prevLiq);
  if (liqD != null && liqD <= -20) parts.push(`liq ${liqD.toFixed(0)}%`);
  if (opts.holders != null && Number.isFinite(opts.holders) && opts.holders > 0) {
    const hD = pctDelta(opts.holders, opts.prevHolders);
    parts.push(hD != null && Math.abs(hD) >= 5
      ? `holders ${Math.round(opts.holders)} ${hD > 0 ? "+" : ""}${hD.toFixed(0)}%`
      : `holders ${Math.round(opts.holders)}`);
  }
  if (opts.live) parts.push("livestream");
  if ((opts.boosts ?? 0) > 0) parts.push(`dex boost ${opts.boosts}`);
  if ((opts.replies ?? 0) >= 5) parts.push(`${opts.replies} replies`);
  if (!parts.length) return "Waiting on the next MC print vs detected.";
  return parts.join(" · ");
}

/**
 * Frozen 0–100 for this print vs the previous memory row.
 * Same model for every wallet-buy token. Missing factors skip, not zero.
 * Tracked-wallet count is ignored.
 */
export function scoreBreakdown(now: ScorePoint, prev: ScorePoint | null): ScoreBreakdown {
  if (!now.survived || now.label === "dead") {
    return { score: 0, factors: {}, tags: ["dead"], catalyst: catalystOf({ lastMc: now.mc, detectedMc: now.detected }) };
  }

  const parts: FactorScores = {
    multiple: multipleFactor(now) ?? undefined,
    mc_path: mcPathFactor(now, prev) ?? undefined,
    liquidity: liquidityFactor(now, prev) ?? undefined,
    volume: volumeFactor(now, prev) ?? undefined,
    flow: flowFactor(now) ?? undefined,
    holders: holdersFactor(now, prev) ?? undefined,
    attention: attentionFactor(now) ?? undefined,
    tape: tapeFactor(now) ?? undefined,
  };
  const { score: blended, used } = blendFactors(parts);
  const prevScore = num(prev?.score);
  const carried = prevScore != null ? blended * 0.82 + prevScore * 0.18 : blended;
  const score = clampScore(carried * ageScale(now));
  const tags = factorTags(now, prev, used);
  const catalyst = catalystOf({
    lastMc: now.mc,
    detectedMc: now.detected,
    prevMc: prev?.mc,
    vol5m: now.vol5m,
    prevVol5m: prev?.vol5m,
    volH1: now.volH1,
    liq: now.liq,
    prevLiq: prev?.liq,
    buys5m: now.buys5m,
    sells5m: now.sells5m,
    holders: now.holders,
    prevHolders: prev?.holders,
    boosts: now.boosts,
    replies: now.replies,
    live: now.live,
    tags,
  });
  return { score, factors: used, tags, catalyst };
}

export function scoreAtPoint(now: ScorePoint, prev: ScorePoint | null): number {
  return scoreBreakdown(now, prev).score;
}
