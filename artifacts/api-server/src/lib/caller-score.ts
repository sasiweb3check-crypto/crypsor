/**
 * Caller Score — Two-Phase Scoring System
 *
 * Parallel to (and fully isolated from) qualityScore / momentumScore.
 * Do NOT mix with existing holder intel scores.
 *
 * Phase 1 — Early Degen (snapshots 1-2):
 *   Core signals only — catches fast runners before ATH.
 *
 * Phase 2 — Survival (snapshots 3+):
 *   Core signals + ATH Gap bonus — filters tokens with real upside remaining.
 *
 * Threshold: 3 snapshots.
 *
 * Labels:
 *   ≥ 82  → STRONG MOON CALL
 *   ≥ 68  → GOOD CALL
 *   ≥ 55  → WATCH
 *   < 55  → SKIP
 */

export const SURVIVAL_SNAPSHOT_THRESHOLD = 3;

export interface CallerScoreInput {
  /** USD market cap — stored as text in DB, parsed here */
  marketCapUsd:        string | null | undefined;
  /** Normalised 0–100 MC growth score (from projection engine) */
  mcGrowthScore:       number;
  /** Normalised 0–100 holder velocity score (from projection engine) */
  holderVelocityScore: number;
  /** Top 10 holder concentration % (0–100) */
  holderTop10Pct:      number;
  /** Normalised 0–100 KOL + smart money combined score */
  kolSmartScore:       number;
  /** % gain from detection price → ATH (may be null for brand-new tokens) */
  athGainPct:          number | null | undefined;
  /** % gain from detection price → current price */
  gainPct:             number | null | undefined;
}

export interface CallerScoreResult {
  callerScore: number;
  callerPhase: "Early Degen" | "Survival";
  callerLabel: "STRONG MOON CALL" | "GOOD CALL" | "WATCH" | "SKIP";
  /** Only set in Survival phase — gap between ATH gain and current gain */
  athGap:      number | null;
  useAthGap:   boolean;
}

export function computeCallerScore(
  input: CallerScoreInput,
  snapshotCount: number,
): CallerScoreResult {
  let baseScore = 0;

  // ── Core factors (always applied) ───────────────────────────────────────────

  // Low MC Bonus: ultra-low cap (<$12K) has most upside room for meme coins
  const mcUsd = parseFloat(input.marketCapUsd ?? "0") || 0;
  if (mcUsd > 0 && mcUsd < 12_000) baseScore += 28;

  // MC Growth: strong upward momentum in market cap
  if (input.mcGrowthScore > 70) baseScore += 22;

  // Holder Velocity: rapid holder accumulation
  if (input.holderVelocityScore > 78) baseScore += 20;

  // Low Top-10 concentration: top 10 hold < 68% of supply → decentralised
  // holderTop10Pct is stored as 0–100 in DB; 0.68 fraction = 68 in our units
  if (input.holderTop10Pct > 0 && input.holderTop10Pct < 68) baseScore += 15;

  // KOL / Smart money presence
  if (input.kolSmartScore > 55) baseScore += 12;

  // ── ATH Gap bonus (Survival phase only — snapshot 5+) ────────────────────
  const isSurvival = snapshotCount >= SURVIVAL_SNAPSHOT_THRESHOLD;
  let athGap: number | null = null;

  if (isSurvival) {
    const athGainPct     = input.athGainPct  ?? 0;
    const currentGainPct = input.gainPct     ?? 0;
    athGap = athGainPct - currentGainPct;

    if (athGap > 150)      baseScore += 18;
    else if (athGap > 80)  baseScore += 10;
    else if (athGap > 40)  baseScore +=  5;
  }

  const callerScore = Math.min(100, Math.round(baseScore));

  const callerLabel =
    callerScore >= 82 ? "STRONG MOON CALL" :
    callerScore >= 68 ? "GOOD CALL"        :
    callerScore >= 55 ? "WATCH"            : "SKIP";

  return {
    callerScore,
    callerPhase: isSurvival ? "Survival" : "Early Degen",
    callerLabel,
    athGap,
    useAthGap: isSurvival,
  };
}
