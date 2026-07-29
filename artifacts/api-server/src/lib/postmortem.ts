/**
 * postmortem.ts
 *
 * Derives the "postmortem" signal label shown in the Caller table and used
 * to drive label-transition alerts. It is a thin, read-only wrapper around
 * telegram-alerts.ts's classifyAlert(), which buckets the compositeFactors
 * already computed every intelligence-engine pass into one of three
 * meaningful categories (or NONE). Kept out of the DB — always derived live
 * from the token's current compositeFactors so there's a single source of
 * truth for the classification logic.
 */

import { classifyAlert, type AlertType } from "./telegram-alerts";
import type { FactorTag } from "./scoring-engine";

export type PostmortemLabel = AlertType; // GOOD_SETUP | SURPRISE_SIGNAL | DUMP_WARNING | NONE

export function derivePostmortemLabel(
  factors: FactorTag[] | string[] | null | undefined,
): PostmortemLabel {
  return classifyAlert({
    tokenAddress: "",
    compositeScore: 0,
    factors: (factors ?? []) as FactorTag[],
    breakdown: {},
  });
}

export const POSTMORTEM_META: Record<
  PostmortemLabel,
  { label: string; color: string; description: string }
> = {
  GOOD_SETUP: {
    label: "Good Setup",
    color: "#22c55e",
    description: "Momentum, liquidity, and smart money all confirming",
  },
  SURPRISE_SIGNAL: {
    label: "Surprise",
    color: "#f59e0b",
    description: "Smart money or holders moving ahead of price",
  },
  DUMP_WARNING: {
    label: "Dump Risk",
    color: "#ef4444",
    description: "Liquidity draining or holders exiting under pressure",
  },
  NONE: {
    label: "Neutral",
    color: "#6b7280",
    description: "No strong signal either way",
  },
};

/** Achievement tiers (ATH multiple from call price) that fire a one-time alert each. */
export const ACHIEVEMENT_TIERS = [2, 3, 5, 10] as const;
