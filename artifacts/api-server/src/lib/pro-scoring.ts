/**
 * pro-scoring.ts
 *
 * Composite Pro Score (0-100) for tokens in the pro_calls pool.
 * Weights and thresholds are configurable via PRO_SCORE_WEIGHTS.
 *
 * Components
 * ──────────
 * Intel/Call Strength   25%  called_intel_score + KOL/Smart bonus
 * MC & Liquidity        20%  called MC log-scale + liquidity_usd
 * ATH Multiplier        20%  log-scale 1× → 20×
 * Gain Momentum         15%  current gain % since call
 * Run-Status Quality    10%  PUMPING/RAN/SLOW/FLAT/DEAD proxy
 * Risk / Security       10%  honeypot, renounced mint/freeze, top-10 rate, LP lock
 *
 * Quality labels
 * ──────────────
 * very_good  ≥ 75
 * good       55–74
 * below      < 55
 */

export type QualityLabel = "very_good" | "good" | "below";

export const PRO_SCORE_WEIGHTS = {
  intelCallStrength: 0.25,
  mcAndLiquidity:    0.20,
  athMultiplier:     0.20,
  gainMomentum:      0.15,
  runStatusQuality:  0.10,
  riskQuality:       0.10,
} as const;

export const PRO_SCORE_THRESHOLDS = {
  veryGood: 75,
  good:     55,
} as const;

export type RunStatus = "PUMPING" | "RAN" | "SLOW" | "FLAT" | "DEAD";

export interface ProScoreInput {
  // Call-time snapshot
  calledIntelScore:  number | null;
  calledKolCount:    number;
  calledSmartCount:  number;
  calledMcUsd:       number | null;

  // Current state
  currentMcUsd:      number | null;
  athMultiple:       number | null;
  gainSinceCall:     number | null; // percent, e.g. +150 = 150%
  runStatus:         RunStatus;
  liquidityUsd:      number | null;

  // Security (nullable — may not be fetched yet)
  secIsHoneypot:         boolean | null;
  secMintRenounced:      boolean | null;
  secFreezeRenounced:    boolean | null;
  secTop10HolderRate:    number | null;
  secLpLocked:           boolean | null;
  secRatTraderAmtRate:   number | null;
}

export interface ProScoreResult {
  score:        number;       // 0-100, rounded to 1dp
  qualityLabel: QualityLabel;
  breakdown: {
    intelCallStrength: number;
    mcAndLiquidity:    number;
    athMultiplier:     number;
    gainMomentum:      number;
    runStatusQuality:  number;
    riskQuality:       number;
  };
}

// ── Component scorers (each returns 0-100) ────────────────────────────────────

function scoreIntelCallStrength(
  intelScore: number | null,
  kolCount: number,
  smartCount: number,
): number {
  const base = Math.min(100, Math.max(0, intelScore ?? 60));
  // Bonus for KOL / Smart wallet presence (up to +15, already normalised)
  const combined = kolCount + smartCount;
  const bonus =
    combined >= 5 ? 15 :
    combined >= 3 ? 10 :
    combined >= 2 ? 6  :
    combined >= 1 ? 3  : 0;
  return Math.min(100, base + bonus);
}

function scoreMcAndLiquidity(
  calledMcUsd: number | null,
  liquidityUsd: number | null,
): number {
  // MC: log scale — $5K = 0, $50K = 50, $1M = 100
  const mc = Math.max(0, calledMcUsd ?? 0);
  const mcScore = mc <= 0
    ? 0
    : Math.min(100, Math.max(0,
        (Math.log10(mc) - Math.log10(5_000)) /
        (Math.log10(1_000_000) - Math.log10(5_000)) * 100
      ));

  // Liquidity: $0 = 0, $10K = 50, $100K = 100
  const liq = Math.max(0, liquidityUsd ?? 0);
  const liqScore = liq <= 0
    ? 0
    : Math.min(100, Math.max(0,
        (Math.log10(liq + 1) - 0) /
        (Math.log10(100_001) - 0) * 100
      ));

  return mcScore * 0.6 + liqScore * 0.4;
}

function scoreAthMultiplier(athMultiple: number | null): number {
  const x = Math.max(1, athMultiple ?? 1);
  if (x >= 20) return 100;
  // log scale: 1× = 0, 2× = 50, 5× = 80, 10× = 93, 20× = 100
  return Math.min(100, Math.max(0,
    (Math.log2(x) / Math.log2(20)) * 100
  ));
}

function scoreGainMomentum(gainPct: number | null): number {
  const g = gainPct ?? 0;
  if (g >= 500) return 100;
  if (g >= 200) return 85 + (g - 200) / 300 * 15;
  if (g >= 100) return 70 + (g - 100) / 100 * 15;
  if (g >= 50)  return 55 + (g - 50)  / 50  * 15;
  if (g >= 0)   return 30 + (g / 50)  * 25;
  // Negative gain: 0% → 30, -50% → 15, -100% → 0
  return Math.max(0, 30 + (g / 50) * 15);
}

function scoreRunStatus(status: RunStatus): number {
  switch (status) {
    case "PUMPING": return 100;
    case "RAN":     return 75;
    case "SLOW":    return 45;
    case "FLAT":    return 25;
    case "DEAD":    return 0;
  }
}

function scoreRiskQuality(inp: ProScoreInput): number {
  // Instant fail if honeypot confirmed
  if (inp.secIsHoneypot === true) return 0;

  // No security data yet → neutral baseline
  if (
    inp.secMintRenounced      == null &&
    inp.secFreezeRenounced    == null &&
    inp.secTop10HolderRate    == null &&
    inp.secLpLocked           == null
  ) {
    return 50;
  }

  let score = 50;
  if (inp.secMintRenounced   === true)  score += 12;
  if (inp.secFreezeRenounced === true)  score += 12;
  if (inp.secTop10HolderRate != null)   score += inp.secTop10HolderRate < 0.25 ? 14 : inp.secTop10HolderRate < 0.40 ? 7 : 0;
  if (inp.secLpLocked        === true)  score += 12;
  // Rat-trader contamination penalty
  if (inp.secRatTraderAmtRate != null && inp.secRatTraderAmtRate > 0.3) score -= 15;

  return Math.min(100, Math.max(0, score));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function computeProScore(inp: ProScoreInput): ProScoreResult {
  const breakdown = {
    intelCallStrength: scoreIntelCallStrength(inp.calledIntelScore, inp.calledKolCount, inp.calledSmartCount),
    mcAndLiquidity:    scoreMcAndLiquidity(inp.calledMcUsd, inp.liquidityUsd),
    athMultiplier:     scoreAthMultiplier(inp.athMultiple),
    gainMomentum:      scoreGainMomentum(inp.gainSinceCall),
    runStatusQuality:  scoreRunStatus(inp.runStatus),
    riskQuality:       scoreRiskQuality(inp),
  };

  const raw =
    breakdown.intelCallStrength * PRO_SCORE_WEIGHTS.intelCallStrength +
    breakdown.mcAndLiquidity    * PRO_SCORE_WEIGHTS.mcAndLiquidity    +
    breakdown.athMultiplier     * PRO_SCORE_WEIGHTS.athMultiplier     +
    breakdown.gainMomentum      * PRO_SCORE_WEIGHTS.gainMomentum      +
    breakdown.runStatusQuality  * PRO_SCORE_WEIGHTS.runStatusQuality  +
    breakdown.riskQuality       * PRO_SCORE_WEIGHTS.riskQuality;

  const score = Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10;

  const qualityLabel: QualityLabel =
    score >= PRO_SCORE_THRESHOLDS.veryGood ? "very_good" :
    score >= PRO_SCORE_THRESHOLDS.good     ? "good"      : "below";

  return { score, qualityLabel, breakdown };
}

export function deriveRunStatus(
  currentMc:   number | null,
  calledMc:    number | null,
  athMultiple: number | null,
): RunStatus {
  if (!currentMc || currentMc < 5_000) return "DEAD";
  if (!calledMc  || calledMc === 0)    return "FLAT";

  const ratio = currentMc / calledMc;
  const ath   = athMultiple ?? 1;
  const athMc = calledMc * ath;

  if (ratio >= 1.1 && currentMc >= athMc * 0.70) return "PUMPING";
  if (ath  >= 2.0  && currentMc <  athMc * 0.50) return "RAN";
  if (ath  >= 1.3  && currentMc <  athMc * 0.60) return "RAN";
  if (ratio >= 0.70 && ratio <= 1.30)             return "SLOW";
  return "FLAT";
}
