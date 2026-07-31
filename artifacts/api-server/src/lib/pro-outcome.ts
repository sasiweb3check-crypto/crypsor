/**
 * Pro call outcome labels — explain why a call printed, stalled, or died.
 * Desk membership is sticky (surfaced_at); these labels are diagnostic only.
 */

export type OutcomeCode =
  | "pumping"
  | "printed_holding"
  | "printed_faded"
  | "building"
  | "flat"
  | "never_ran"
  | "crashed"
  | "dead"
  | "quarantine";

export interface OutcomeInfo {
  code: OutcomeCode;
  label: string;
  detail: string;
}

export function deriveProOutcome(opts: {
  calledMcUsd: number | null;
  currentMcUsd: number | null;
  athMultiple: number | null;
  runStatus: string | null;
  liquidityUsd?: number | null;
  honeypot?: boolean | null;
  banned?: boolean;
}): OutcomeInfo {
  if (opts.banned) {
    return { code: "quarantine", label: "Quarantine", detail: "Blocked mint/symbol or absurd MC" };
  }
  if (opts.honeypot === true) {
    return { code: "quarantine", label: "Honeypot", detail: "Security flag — do not trade" };
  }

  const called = opts.calledMcUsd ?? 0;
  const current = opts.currentMcUsd ?? 0;
  const ath = opts.athMultiple ?? 1;
  const run = (opts.runStatus ?? "").toUpperCase();
  const retention = called > 0 && current > 0 ? current / called : 0;

  if (run === "PUMPING" || (ath >= 1.5 && retention >= 1.2)) {
    return {
      code: "pumping",
      label: "Running",
      detail: "Above entry and still expanding",
    };
  }

  if (ath >= 2) {
    if (retention >= 0.6) {
      return {
        code: "printed_holding",
        label: "Printed · holding",
        detail: `Hit ${ath.toFixed(1)}× ATH and still ≥60% of entry MC`,
      };
    }
    return {
      code: "printed_faded",
      label: "Printed · faded",
      detail: `Hit ${ath.toFixed(1)}× ATH then gave back most of the move`,
    };
  }

  if (current > 0 && current < 1_000) {
    return {
      code: "dead",
      label: "Dead",
      detail: "Market cap collapsed under $1K",
    };
  }

  if (called > 0 && current > 0 && retention < 0.3) {
    return {
      code: "crashed",
      label: "Crashed",
      detail: `Now ${(retention * 100).toFixed(0)}% of entry MC without a 2× print`,
    };
  }

  if (ath < 1.15 && retention <= 1.1) {
    return {
      code: "never_ran",
      label: "Never ran",
      detail: "Never cleared ~1.15× ATH — entry thesis did not fire",
    };
  }

  if (run === "SLOW" || (ath >= 1.15 && ath < 2)) {
    return {
      code: "building",
      label: "Building",
      detail: "Mild expansion under 2× — still in play or fading slowly",
    };
  }

  if (run === "DEAD") {
    return {
      code: "dead",
      label: "Dead",
      detail: "Run status DEAD — liquidity/MC no longer tradeable",
    };
  }

  return {
    code: "flat",
    label: "Flat",
    detail: "Near entry with no meaningful expansion",
  };
}
