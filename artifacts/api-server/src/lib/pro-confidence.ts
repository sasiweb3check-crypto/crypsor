/**
 * Confidence Score — soft "act now?" gate (meta-label style).
 *
 * Paired with Judging (call-quality / pro score):
 *   • Judging  = is this an opportunity? (always keep on desk)
 *   • Confidence = how loud / when to alert? (continuous 0–100, NO hard blockers)
 *
 * alertEligible is derived only from score tier thresholds — never from a
 * checklist that zeros out FRIEND-class runners (single-smart, intel 80, stale).
 */

export type ConfidenceTier = "alert" | "watch" | "desk";

export interface ConfidenceInput {
  calledIntelScore: number | null;
  calledSmartCount: number;
  calledKolCount: number;
  calledMcUsd: number | null;
  calledHolderVelocity?: number | null;
  smartHoldRate?: number | null;
  diamondHands?: number | null;
  paperHands?: number | null;
  top10HolderRate?: number | null;
  bundlerPct?: number | null;
  secIsHoneypot?: boolean | null;
  secMintRenounced?: boolean | null;
  secFreezeRenounced?: boolean | null;
  /** Minutes since called_at — soft freshness decay. */
  ageMinutes?: number | null;
  /** Gain % since entry — soft chase penalty. */
  gainSinceCallPct?: number | null;
}

export interface ConfidenceResult {
  score: number;
  tier: ConfidenceTier;
  /** True when score clears the alert bar (soft — no hard gate list). */
  alertEligible: boolean;
  reasons: string[];
  /** Soft demerits for UI — never used as hard kills. */
  blockers: string[];
  label: string;
}

const ALERT_MIN_SCORE = 72;
const WATCH_MIN_SCORE = 55;

function clamp(v: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

/** Soft entry-time confidence — continuous curve, no hard stoppers. */
export function computeConfidence(inp: ConfidenceInput): ConfidenceResult {
  const reasons: string[] = [];
  const notes: string[] = [];
  let score = 40;

  const smart = Math.max(0, inp.calledSmartCount ?? 0);
  const kol = Math.max(0, inp.calledKolCount ?? 0);
  const intel = inp.calledIntelScore ?? 0;
  const mc = inp.calledMcUsd ?? 0;
  const cluster = smart >= 2 && kol >= 1;

  // Honeypot: collapse to desk (safety), still not a multi-blocker checklist
  if (inp.secIsHoneypot === true) {
    return {
      score: 0,
      tier: "desk",
      alertEligible: false,
      reasons: ["Honeypot"],
      blockers: ["honeypot"],
      label: "Desk",
    };
  }

  // ── Cluster (soft weights) ───────────────────────────────────────────────
  if (cluster) {
    score += 22;
    reasons.push(`Cluster · ${smart} smart + ${kol} KOL`);
  } else if (smart >= 3) {
    score += 14;
    reasons.push(`${smart} smart holding`);
  } else if (smart >= 2) {
    score += 10;
    reasons.push(`${smart} smart holding`);
  } else if (smart === 1) {
    score += 6;
    notes.push("single-soft");
    reasons.push("1 smart (partial cluster)");
  } else {
    score -= 4;
    notes.push("no-smart");
  }
  if (smart >= 5) {
    score += 6;
    reasons.push("Deep smart book");
  }

  // ── Intel curve (80 gets most of 90's credit) ────────────────────────────
  if (intel >= 95) {
    score += 18;
    reasons.push(`Intel ${Math.round(intel)}`);
  } else if (intel >= 90) {
    score += 15;
    reasons.push(`Intel ${Math.round(intel)}`);
  } else if (intel >= 85) {
    score += 12;
  } else if (intel >= 80) {
    score += 9;
    reasons.push(`Intel ${Math.round(intel)}`);
  } else if (intel >= 70) {
    score += 5;
    notes.push(`intel ${Math.round(intel)}`);
  } else if (intel > 0) {
    score += 2;
    notes.push(`intel ${Math.round(intel)}`);
  }

  // ── MC band (soft) ───────────────────────────────────────────────────────
  if (mc >= 5_000 && mc <= 15_000) {
    score += 16;
    reasons.push(`Entry MC $${Math.round(mc / 1000)}K`);
  } else if (mc > 15_000 && mc <= 25_000) {
    score += 8;
    reasons.push(`Entry MC $${Math.round(mc / 1000)}K`);
  } else if (mc > 25_000) {
    score -= 4;
    notes.push("MC elevated");
  } else if (mc > 0 && mc < 5_000) {
    score -= 2;
    notes.push("MC micro");
  }

  // ── Security (soft) ──────────────────────────────────────────────────────
  if (inp.secMintRenounced === true) {
    score += 8;
    reasons.push("Mint renounced");
  } else if (inp.secMintRenounced === false) {
    score -= 6;
    notes.push("mint open");
  }
  if (inp.secFreezeRenounced === true) {
    score += 3;
  }

  // ── Conviction ───────────────────────────────────────────────────────────
  const shr = inp.smartHoldRate;
  if (shr != null && Number.isFinite(shr)) {
    if (shr >= 0.8) {
      score += 10;
      reasons.push(`Smart hold ${(shr * 100).toFixed(0)}%`);
    } else if (shr >= 0.5) {
      score += 6;
    } else if (shr < 0.25) {
      score -= 6;
      notes.push("weak hold");
    }
  }
  if ((inp.diamondHands ?? 0) >= 1) score += 3;
  if ((inp.paperHands ?? 0) >= 4) score -= 4;

  const hv = inp.calledHolderVelocity;
  if (hv != null && hv >= 80) {
    score += 4;
    reasons.push(`HV ${Math.round(hv)}`);
  }

  if (inp.top10HolderRate != null && inp.top10HolderRate > 0.45) score -= 5;
  if (inp.bundlerPct != null && inp.bundlerPct > 0.35) score -= 4;

  // ── Freshness / chase — decay, never veto ────────────────────────────────
  const age = inp.ageMinutes;
  if (age != null && Number.isFinite(age)) {
    if (age <= 20) score += 6;
    else if (age <= 45) score += 2;
    else if (age <= 120) {
      score -= 6;
      notes.push(`age ${Math.round(age)}m`);
    } else {
      score -= 12;
      notes.push(`stale ${Math.round(age)}m`);
    }
  }

  const gain = inp.gainSinceCallPct;
  if (gain != null && Number.isFinite(gain)) {
    if (gain >= 80) {
      score -= 14;
      notes.push("already pumped");
    } else if (gain >= 40) {
      score -= 8;
      notes.push("chasing");
    } else if (gain >= 15) {
      score -= 3;
    }
  }

  score = clamp(Math.round(score));

  // Soft tiers only — score bar, no AND-checklist
  let tier: ConfidenceTier = "desk";
  if (score >= ALERT_MIN_SCORE) tier = "alert";
  else if (score >= WATCH_MIN_SCORE) tier = "watch";

  const alertEligible = tier === "alert";

  const label =
    tier === "alert" ? "High confidence" :
    tier === "watch" ? "Watch" :
    "Desk";

  return {
    score,
    tier,
    alertEligible,
    reasons: reasons.slice(0, 6),
    blockers: notes.slice(0, 4),
    label,
  };
}

/** Parse hold-rate / diamond / paper / top10 / bundler from verified_wallets JSON. */
export function convictionFieldsFromVerified(raw: unknown): {
  smartHoldRate: number | null;
  diamondHands: number | null;
  paperHands: number | null;
  top10HolderRate: number | null;
  bundlerPct: number | null;
} {
  const empty = {
    smartHoldRate: null as number | null,
    diamondHands: null as number | null,
    paperHands: null as number | null,
    top10HolderRate: null as number | null,
    bundlerPct: null as number | null,
  };
  if (!raw) return empty;
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!o || typeof o !== "object") return empty;
    const smart = (o as { conviction?: { smart?: Record<string, number> } }).conviction?.smart;
    const ts = (o as { tokenStat?: Record<string, number> }).tokenStat;
    const n = (v: unknown) => {
      if (v == null) return null;
      const x = typeof v === "number" ? v : parseFloat(String(v));
      return Number.isFinite(x) ? x : null;
    };
    return {
      smartHoldRate: n(smart?.holdRate),
      diamondHands: n(smart?.diamondHands),
      paperHands: n(smart?.paperHands),
      top10HolderRate: n(ts?.top10HolderRate),
      bundlerPct: n(ts?.bundlerPct),
    };
  } catch {
    return empty;
  }
}
