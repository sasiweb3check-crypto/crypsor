/**
 * pro-scoring.ts
 *
 * Public Pro Score API — delegates to v2 (Jul 2026 outcome-tuned weights).
 * Callers keep using computeProScore / deriveRunStatus; v1 math is retired.
 */

export type {
  QualityLabel,
  RunStatus,
  EntryTier,
  ProScoreV2Input as ProScoreInput,
  ProScoreV2Result as ProScoreResult,
} from "./pro-scoring-v2";

export {
  PRO_SCORE_V2_WEIGHTS as PRO_SCORE_WEIGHTS,
  PRO_SCORE_V2_THRESHOLDS as PRO_SCORE_THRESHOLDS,
  computeProScoreV2,
  computeSurvivalScore,
  deriveEntryTier,
  deriveRunStatusV2,
} from "./pro-scoring-v2";

import {
  computeProScoreV2,
  deriveRunStatusV2,
  type ProScoreV2Input,
  type ProScoreV2Result,
  type RunStatus,
} from "./pro-scoring-v2";

/** Primary Pro Score — v2. */
export function computeProScore(inp: ProScoreV2Input): ProScoreV2Result {
  return computeProScoreV2(inp);
}

export function deriveRunStatus(
  currentMc: number | null,
  calledMc: number | null,
  athMultiple: number | null,
): RunStatus {
  return deriveRunStatusV2(currentMc, calledMc, athMultiple);
}
