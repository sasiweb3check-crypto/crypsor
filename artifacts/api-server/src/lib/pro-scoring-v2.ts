/**
 * pro-scoring-v2.ts
 *
 * Call-time Pro Score rebuilt from live Crypsor outcomes (Jul 2026):
 *   • Best ATH cohort: call MC $5–15K + intel ≥90 + holder velocity ~100
 *   • very_good (≥75) → ~71–82% hit 10×; good alone → median ~3×
 *   • Surfaced lag was killing edge — score must qualify AT CALL, not hours later
 *
 * Components (weights from outcome analysis)
 * ──────────────────────────────────────────
 * Entry Quality      28%  call MC sweet-spot + called intel
 * Holder Velocity    24%  dominant leading indicator (r≈0.54 to score Δ)
 * Smart Money        18%  KOL + smart at call
 * Survival           15%  age-aware hold vs dump (updated every snapshot)
 * Security            8%  mint/freeze renounced, honeypot, top10, LP
 * Live Momentum       7%  current gain / run-status (small — avoid late bias)
 *
 * Labels (same thresholds as v1 for UI continuity)
 *   very_good ≥ 75 | good 55–74 | below < 55
 */

export type QualityLabel = "very_good" | "good" | "below";
export type RunStatus = "PUMPING" | "RAN" | "SLOW" | "FLAT" | "DEAD";
export type EntryTier = "micro" | "low" | "mid" | "high" | "outlier";

export const PRO_SCORE_V2_WEIGHTS = {
  entryQuality:   0.28,
  holderVelocity: 0.24,
  smartMoney:     0.18,
  survival:       0.15,
  security:       0.08,
  liveMomentum:   0.07,
} as const;

export const PRO_SCORE_V2_THRESHOLDS = {
  veryGood: 75,
  good:     55,
} as const;

export interface ProScoreV2Input {
  calledIntelScore: number | null;
  calledKolCount: number;
  calledSmartCount: number;
  calledMcUsd: number | null;
  calledHolderVelocity?: number | null;
  calledMcGrowth?: number | null;
  calledVolumeIntensity?: number | null;

  currentMcUsd: number | null;
  athMultiple: number | null;
  gainSinceCall: number | null;
  runStatus: RunStatus;
  liquidityUsd: number | null;
  ageHoursSinceCall?: number | null;

  // Live holder velocity (0–100) when available — falls back to called
  holderVelocityScore?: number | null;

  secIsHoneypot: boolean | null;
  secMintRenounced: boolean | null;
  secFreezeRenounced: boolean | null;
  secTop10HolderRate: number | null;
  secLpLocked: boolean | null;
  secRatTraderAmtRate: number | null;
}

export interface ProScoreV2Result {
  score: number;
  qualityLabel: QualityLabel;
  survivalScore: number;
  entryTier: EntryTier;
  breakdown: {
    entryQuality: number;
    holderVelocity: number;
    smartMoney: number;
    survival: number;
    security: number;
    liveMomentum: number;
  };
}

function clamp(v: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

export function deriveEntryTier(calledMcUsd: number | null): EntryTier {
  const mc = calledMcUsd ?? 0;
  if (mc <= 0 || mc > 500_000) return "outlier";
  if (mc < 15_000) return "micro";   // sweet spot
  if (mc < 30_000) return "low";
  if (mc < 75_000) return "mid";
  return "high";
}

/** Call-MC sweet spot from ≥10× winners: peak edge at $5–15K. */
function scoreEntryQuality(
  calledMc: number | null,
  intel: number | null,
  mcGrowth: number | null | undefined,
  volIntensity: number | null | undefined,
): number {
  const mc = Math.max(0, calledMc ?? 0);
  let mcScore: number;
  if (mc <= 0) mcScore = 0;
  else if (mc < 5_000) mcScore = 35;           // below pro gate — weak
  else if (mc <= 15_000) mcScore = 100;        // sweet spot
  else if (mc <= 25_000) mcScore = 85;
  else if (mc <= 50_000) mcScore = 55;
  else if (mc <= 100_000) mcScore = 35;
  else mcScore = 15;

  const intelScore = clamp(intel ?? 60);
  const growth = clamp(mcGrowth ?? 50);
  const vol = clamp(volIntensity ?? 50);

  // Intel dominates entry; growth/vol confirm ignition at call
  return clamp(mcScore * 0.35 + intelScore * 0.40 + growth * 0.15 + vol * 0.10);
}

function scoreHolderVelocity(
  calledHv: number | null | undefined,
  liveHv: number | null | undefined,
): number {
  const hv = liveHv ?? calledHv ?? 50;
  // Winners almost always showed HV=100 at call
  if (hv >= 95) return 100;
  if (hv >= 80) return 85;
  if (hv >= 60) return 65;
  if (hv >= 40) return 40;
  return clamp(hv * 0.8);
}

/**
 * Smart / KOL scoring from 14d quality Pro outcomes:
 *   • Smart ≥1 lifts hit5 (≈32% vs 18% at 0); smart 2–5 best avg ATH
 *   • KOL 1 is the volume sweet spot; raw KOL count alone is weak predictor
 *   • Prefer smart conviction + modest KOL (1–3) over KOL spam (4–9 without smart)
 */
function scoreSmartMoney(kol: number, smart: number): number {
  const k = Math.max(0, kol);
  const s = Math.max(0, smart);

  let smartScore: number;
  if (s <= 0) smartScore = 20;
  else if (s === 1) smartScore = 62;
  else if (s <= 5) smartScore = 88;   // sweet band
  else if (s <= 15) smartScore = 78;
  else smartScore = 70;               // crowded / late

  let kolScore: number;
  if (k <= 0) kolScore = 30;
  else if (k === 1) kolScore = 75;
  else if (k <= 3) kolScore = 82;
  else if (k <= 9) kolScore = 55;     // noisy without matching smart
  else kolScore = 60;

  // Smart carries more weight — data showed smart band moves hit rates more than KOL alone
  let score = smartScore * 0.62 + kolScore * 0.38;

  // Combo bonus: KOL 1–3 with smart 2–5 (MarsCoin-class early conviction)
  if (k >= 1 && k <= 3 && s >= 2 && s <= 5) score += 10;
  if (k >= 1 && s >= 1) score += 4;
  if (k === 0 && s === 0) score = 22;

  return clamp(score);
}

/**
 * Age-aware survival: rewards tokens that hold structure as they age.
 * Young pumps with collapsing MC score poorly; early survivors score well.
 */
export function computeSurvivalScore(inp: {
  ageHoursSinceCall: number | null | undefined;
  calledMcUsd: number | null;
  currentMcUsd: number | null;
  athMultiple: number | null;
  gainSinceCall: number | null;
  runStatus: RunStatus;
  liquidityUsd: number | null;
}): number {
  const age = Math.max(0, inp.ageHoursSinceCall ?? 0);
  const called = Math.max(0, inp.calledMcUsd ?? 0);
  const current = Math.max(0, inp.currentMcUsd ?? 0);
  const ath = Math.max(1, inp.athMultiple ?? 1);
  const gain = inp.gainSinceCall ?? 0;

  // Retention vs call
  const retention = called > 0 ? current / called : 1;
  // Drawdown from ATH MC (approx)
  const athMc = called * ath;
  const drawdown = athMc > 0 ? 1 - current / athMc : 0;

  let base: number;
  if (inp.runStatus === "DEAD") base = 8;
  else if (inp.runStatus === "PUMPING") base = 92;
  else if (inp.runStatus === "RAN") base = drawdown > 0.7 ? 35 : 60;
  else if (inp.runStatus === "SLOW") base = 50;
  else base = 40; // FLAT

  // Age curves — memecoins die fast; surviving past windows is signal
  if (age < 0.5) {
    // First 30m: survival ≈ not dumping hard
    if (retention >= 0.9) base = Math.max(base, 70);
    if (retention < 0.5) base = Math.min(base, 25);
  } else if (age < 2) {
    if (retention >= 1.0) base += 10;
    if (retention < 0.4) base -= 25;
  } else if (age < 12) {
    if (ath >= 2 && retention >= 0.6) base += 15;
    if (ath >= 5 && drawdown < 0.5) base += 10;
    if (retention < 0.25) base -= 30;
  } else {
    // 12h+: longevity bonus if still above call and not dead
    if (retention >= 1.0 && inp.runStatus !== "DEAD") base += 20;
    if (ath >= 5 && retention >= 0.4) base += 10;
    if (inp.runStatus === "DEAD") base = Math.min(base, 15);
  }

  // Liquidity floor
  const liq = inp.liquidityUsd ?? 0;
  if (liq > 0 && liq < 2_000) base -= 15;
  else if (liq >= 10_000) base += 5;

  // Mild gain confirmation
  if (gain >= 100) base += 5;
  if (gain <= -70) base -= 15;

  return clamp(base);
}

function scoreSecurity(inp: ProScoreV2Input): number {
  if (inp.secIsHoneypot === true) return 0;
  if (
    inp.secMintRenounced == null &&
    inp.secFreezeRenounced == null &&
    inp.secTop10HolderRate == null &&
    inp.secLpLocked == null
  ) {
    return 50;
  }
  let score = 50;
  if (inp.secMintRenounced === true) score += 12;
  if (inp.secFreezeRenounced === true) score += 12;
  if (inp.secTop10HolderRate != null) {
    score += inp.secTop10HolderRate < 0.25 ? 14 : inp.secTop10HolderRate < 0.40 ? 7 : 0;
  }
  if (inp.secLpLocked === true) score += 12;
  if (inp.secRatTraderAmtRate != null && inp.secRatTraderAmtRate > 0.3) score -= 15;
  return clamp(score);
}

function scoreLiveMomentum(
  gainPct: number | null,
  runStatus: RunStatus,
  athMultiple: number | null,
): number {
  const g = gainPct ?? 0;
  let gainScore: number;
  if (g >= 200) gainScore = 95;
  else if (g >= 100) gainScore = 80;
  else if (g >= 50) gainScore = 65;
  else if (g >= 0) gainScore = 45 + (g / 50) * 20;
  else if (g >= -50) gainScore = 30 + ((g + 50) / 50) * 15;
  else gainScore = Math.max(0, 15 + g / 10);

  const runMap: Record<RunStatus, number> = {
    PUMPING: 100, RAN: 70, SLOW: 45, FLAT: 30, DEAD: 5,
  };
  const ath = athMultiple ?? 1;
  const athBoost = ath >= 5 ? 10 : ath >= 2 ? 5 : 0;
  return clamp(gainScore * 0.55 + runMap[runStatus] * 0.45 + athBoost);
}

export function computeProScoreV2(inp: ProScoreV2Input): ProScoreV2Result {
  const survivalScore = computeSurvivalScore({
    ageHoursSinceCall: inp.ageHoursSinceCall,
    calledMcUsd: inp.calledMcUsd,
    currentMcUsd: inp.currentMcUsd,
    athMultiple: inp.athMultiple,
    gainSinceCall: inp.gainSinceCall,
    runStatus: inp.runStatus,
    liquidityUsd: inp.liquidityUsd,
  });

  const breakdown = {
    entryQuality: scoreEntryQuality(
      inp.calledMcUsd,
      inp.calledIntelScore,
      inp.calledMcGrowth,
      inp.calledVolumeIntensity,
    ),
    holderVelocity: scoreHolderVelocity(inp.calledHolderVelocity, inp.holderVelocityScore),
    smartMoney: scoreSmartMoney(inp.calledKolCount, inp.calledSmartCount),
    survival: survivalScore,
    security: scoreSecurity(inp),
    liveMomentum: scoreLiveMomentum(inp.gainSinceCall, inp.runStatus, inp.athMultiple),
  };

  const raw =
    breakdown.entryQuality   * PRO_SCORE_V2_WEIGHTS.entryQuality +
    breakdown.holderVelocity * PRO_SCORE_V2_WEIGHTS.holderVelocity +
    breakdown.smartMoney     * PRO_SCORE_V2_WEIGHTS.smartMoney +
    breakdown.survival       * PRO_SCORE_V2_WEIGHTS.survival +
    breakdown.security       * PRO_SCORE_V2_WEIGHTS.security +
    breakdown.liveMomentum   * PRO_SCORE_V2_WEIGHTS.liveMomentum;

  const score = Math.round(clamp(raw) * 10) / 10;

  // Dead / never-ran tokens must not flood Pro Intel just because call-time
  // signals looked good. Keep quality if they already printed ≥2× ATH.
  let qualityLabel: QualityLabel =
    score >= PRO_SCORE_V2_THRESHOLDS.veryGood ? "very_good" :
    score >= PRO_SCORE_V2_THRESHOLDS.good     ? "good" : "below";

  const ath = inp.athMultiple ?? 1;
  if (inp.runStatus === "DEAD" && ath < 2 && qualityLabel !== "below") {
    qualityLabel = "below";
  }

  return {
    score,
    qualityLabel,
    survivalScore,
    entryTier: deriveEntryTier(inp.calledMcUsd),
    breakdown,
  };
}

export function deriveRunStatusV2(
  currentMc: number | null,
  calledMc: number | null,
  athMultiple: number | null,
): RunStatus {
  if (!currentMc || currentMc < 5_000) return "DEAD";
  if (!calledMc || calledMc === 0) return "FLAT";

  const ratio = currentMc / calledMc;
  const ath = athMultiple ?? 1;
  const athMc = calledMc * ath;

  if (ratio >= 1.1 && currentMc >= athMc * 0.70) return "PUMPING";
  if (ath >= 2.0 && currentMc < athMc * 0.50) return "RAN";
  if (ath >= 1.3 && currentMc < athMc * 0.60) return "RAN";
  if (ratio >= 0.70 && ratio <= 1.30) return "SLOW";
  return "FLAT";
}
