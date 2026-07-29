/**
 * scoringEngine.ts
 *
 * New composite scoring system, built alongside (not replacing) intel_score.
 * Derived from statistical analysis of crypsor-score-log-ALL-2026-07-29.csv
 * (116,768 rows). Do not merge assumptions from any other dataset.
 *
 * Source stats used to set weights/thresholds (all percentiles from that file):
 *   score_delta correlation to component:
 *     holder_velocity  r=0.536  <- dominant driver of score movement
 *     mc_growth        r=0.160
 *     liquidity_health r=0.032
 *     age_multiplier   r=0.012
 *     kol_smart        r=0.019
 *     vol_intensity    r=0.005
 *   liquidity_health deciles: p10=10, p50=20, p90=20 (mostly bimodal 10/20)
 *   kol_smart deciles: p10=0, p50=18.5, p75=48, p90=70
 *   mc_growth: p50=15, p75=45, p90=51.9, p95=70.6
 *   vol_intensity: p50=59.8, p75=86.6, p90=100
 */

export interface RawSignal {
  tokenAddress: string;
  mcGrowth: number; // 0-100
  volIntensity: number; // 0-100
  holderVelocity: number; // 0-100
  kolSmart: number; // 0-100
  liquidityHealth: number; // 0-100
  ageMultiplier: number; // ~0-1.3
  ageHours: number;
  holderCount: number;
  holderKolCount: number;
  holderSmartCount: number;
  totalBuys: number;
  smartBuys: number;
  labeledFraction: number;
  marketCapUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
}

export type FactorTag =
  | "GOOD_MOMENTUM" // strong holder velocity, the single best predictor of continued score gain
  | "GOOD_LIQUIDITY" // liquidity_health in top decile, low rug risk
  | "GOOD_SMART_MONEY" // real, price-confirmed smart/KOL buying
  | "SURPRISE_ACCUMULATION" // kol/smart activity spiking while price hasn't moved yet — leading indicator
  | "SURPRISE_HOLDER_SURGE" // holder_velocity jumps disproportionate to mc_growth
  | "DUMP_LIQUIDITY_DRAIN" // liquidity_health low + volume spike = classic rug pattern
  | "DUMP_HOLDER_EXODUS" // holder_velocity collapsing while volume stays high (sell pressure)
  | "DUMP_STALE_PUMP"; // mc_growth high but holder_velocity + liquidity both weak — unsustainable pump

export interface ScoreResult {
  tokenAddress: string;
  compositeScore: number; // 0-100
  factors: FactorTag[];
  breakdown: Record<string, number>;
}

// Weights normalized from |correlation to score_delta|, floor applied so no
// component goes to zero (they still carry information for factor tagging
// even where their correlation to *movement* is weak).
const WEIGHTS = {
  holderVelocity: 0.40,
  mcGrowth: 0.22,
  liquidityHealth: 0.16,
  kolSmart: 0.13,
  volIntensity: 0.09,
};

// Thresholds pulled from percentiles above.
const T = {
  liquidityHealthLow: 15, // below p50(20)/p10(10) midpoint — thin/fragile pool
  liquidityHealthHigh: 20, // effectively "top band" given the 10/20 bimodal distribution
  kolSmartHigh: 70, // p90
  kolSmartMid: 48, // p75
  mcGrowthLow: 15, // p50 — "price hasn't really moved"
  mcGrowthHigh: 51.9, // p90
  volIntensityHigh: 86.6, // p75
  holderVelocityHigh: 90, // near max band, matches pump-cohort mean (97.3)
  holderVelocityLow: 40, // below dump-cohort mean (53.1), clearly decelerating
};

export function computeCompositeScore(sig: RawSignal): ScoreResult {
  const breakdown = {
    holderVelocity: sig.holderVelocity * WEIGHTS.holderVelocity,
    mcGrowth: sig.mcGrowth * WEIGHTS.mcGrowth,
    liquidityHealth: sig.liquidityHealth * WEIGHTS.liquidityHealth,
    kolSmart: sig.kolSmart * WEIGHTS.kolSmart,
    volIntensity: sig.volIntensity * WEIGHTS.volIntensity,
  };

  const rawTotal = Object.values(breakdown).reduce((a, b) => a + b, 0);
  // age_multiplier tempers very young / stale tokens; clamp so it can only
  // scale within +/-30% rather than dominate the score.
  const ageFactor = Math.min(1.3, Math.max(0.7, sig.ageMultiplier));
  const compositeScore = Math.max(0, Math.min(100, rawTotal * ageFactor));

  const factors = detectFactors(sig);

  return {
    tokenAddress: sig.tokenAddress,
    compositeScore: Math.round(compositeScore * 10) / 10,
    factors,
    breakdown,
  };
}

export function detectFactors(sig: RawSignal): FactorTag[] {
  const tags: FactorTag[] = [];
  const smartRatio = sig.totalBuys > 0 ? sig.smartBuys / sig.totalBuys : 0;

  // --- Good ---
  if (sig.holderVelocity >= T.holderVelocityHigh) tags.push("GOOD_MOMENTUM");
  if (sig.liquidityHealth >= T.liquidityHealthHigh && sig.liquidityUsd > 5000) {
    tags.push("GOOD_LIQUIDITY");
  }
  if (sig.kolSmart >= T.kolSmartHigh && sig.mcGrowth >= T.mcGrowthLow && smartRatio > 0) {
    // KOL/smart buying that is already being confirmed by price movement
    tags.push("GOOD_SMART_MONEY");
  }

  // --- Surprising (leading indicators, price hasn't caught up yet) ---
  if (sig.kolSmart >= T.kolSmartMid && sig.mcGrowth < T.mcGrowthLow) {
    tags.push("SURPRISE_ACCUMULATION");
  }
  if (sig.holderVelocity >= T.holderVelocityHigh && sig.mcGrowth < T.mcGrowthLow) {
    tags.push("SURPRISE_HOLDER_SURGE");
  }

  // --- Dumping / risk ---
  if (sig.liquidityHealth <= T.liquidityHealthLow && sig.volIntensity >= T.volIntensityHigh) {
    tags.push("DUMP_LIQUIDITY_DRAIN");
  }
  if (sig.holderVelocity <= T.holderVelocityLow && sig.volIntensity >= T.volIntensityHigh) {
    tags.push("DUMP_HOLDER_EXODUS");
  }
  if (
    sig.mcGrowth >= T.mcGrowthHigh &&
    sig.holderVelocity <= T.holderVelocityLow &&
    sig.liquidityHealth <= T.liquidityHealthLow
  ) {
    tags.push("DUMP_STALE_PUMP");
  }

  return tags;
}

export const SCORING_THRESHOLDS = T;
export const SCORING_WEIGHTS = WEIGHTS;
