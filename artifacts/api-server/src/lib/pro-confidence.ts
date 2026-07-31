/**
 * Entry-only Confidence Score — paid-alert intelligence layer
 *
 * Separates the Pro desk (sticky ledger of all calls) from Telegram alerts.
 * Alerts fire only on high-precision entry signals — the pattern used by
 * GMGN / KOL heatmaps / smart-money cluster tools:
 *
 *   • Cluster buy: ≥2 holding smart AND ≥1 KOL at verify
 *   • Sweet-spot MC ($5–15K) for Telegram Alert — best 5× band in backtest
 *   • High intel (≥90)
 *   • Mint renounced · not honeypot
 *   • Fresh (minutes after call) · not chasing a pump
 *
 * Live desk backtest (cluster ∧ intel≥90 ∧ mint, surfaced good/very_good):
 *   MC $5–15K  → ~50% 2× / ~27% 5×  (Alert hard gate)
 *   MC $15–25K → ~39% 2× / ~4% 5×   (Watch research only — dilutes 5×)
 *   MC $5–25K  → ~44% 2× / ~16% 5×
 *   Desk baseline → ~31% 2× / ~10% 5×
 *
 * Watch uses a wider MC band ($5–25K) so near-misses stay visible in-app.
 * Early snapshot gates (first 3/5 snaps) are not used yet — only ~10% of
 * historical rule tokens have snaps in the first 45m.
 *
 * Pro Score may include live momentum; Confidence does NOT.
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
  /** Minutes since called_at — alerts require freshness. */
  ageMinutes?: number | null;
  /** Gain % since entry — alerts reject chase (already pumped). */
  gainSinceCallPct?: number | null;
}

export interface ConfidenceResult {
  score: number;
  tier: ConfidenceTier;
  /** True only when Telegram first-call should fire. */
  alertEligible: boolean;
  reasons: string[];
  blockers: string[];
  /** Human label for UI / Telegram. */
  label: string;
}

const ALERT_MIN_SCORE = 72;
const ALERT_MAX_AGE_MIN = 45;
const ALERT_MAX_GAIN_PCT = 40;

function clamp(v: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

/** Pure entry-time score — no ATH, no run status, no live MC momentum. */
export function computeConfidence(inp: ConfidenceInput): ConfidenceResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  let score = 35;

  const smart = Math.max(0, inp.calledSmartCount ?? 0);
  const kol = Math.max(0, inp.calledKolCount ?? 0);
  const intel = inp.calledIntelScore ?? 0;
  const mc = inp.calledMcUsd ?? 0;
  const cluster = smart >= 2 && kol >= 1;

  if (inp.secIsHoneypot === true) {
    blockers.push("honeypot");
    return {
      score: 0,
      tier: "desk",
      alertEligible: false,
      reasons,
      blockers,
      label: "Blocked",
    };
  }

  // ── Cluster (industry #1 signal) ─────────────────────────────────────────
  if (cluster) {
    score += 22;
    reasons.push(`Cluster · ${smart} smart + ${kol} KOL holding`);
  } else if (smart >= 3) {
    score += 12;
    reasons.push(`${smart} smart holding`);
  } else if (smart >= 2) {
    score += 8;
    reasons.push(`${smart} smart holding`);
  } else if (smart === 1) {
    score += 2;
    blockers.push("single-smart (need cluster)");
  } else {
    blockers.push("no smart holding");
  }

  if (smart >= 5) {
    score += 8;
    reasons.push("Deep smart book (≥5)");
  } else if (smart >= 3) {
    score += 4;
  }

  // ── Intel ────────────────────────────────────────────────────────────────
  if (intel >= 95) {
    score += 18;
    reasons.push(`Intel ${Math.round(intel)}`);
  } else if (intel >= 90) {
    score += 14;
    reasons.push(`Intel ${Math.round(intel)}`);
  } else if (intel >= 85) {
    score += 8;
  } else if (intel > 0 && intel < 85) {
    blockers.push(`intel ${Math.round(intel)} < 85`);
  }

  // ── Entry MC sweet spot ──────────────────────────────────────────────────
  if (mc >= 5_000 && mc <= 15_000) {
    score += 18;
    reasons.push(`Entry MC $${Math.round(mc / 1000)}K (sweet spot)`);
  } else if (mc > 15_000 && mc <= 18_000) {
    score += 10;
    reasons.push(`Entry MC $${Math.round(mc / 1000)}K`);
  } else if (mc > 18_000 && mc <= 25_000) {
    score += 4;
    blockers.push("MC above sweet spot");
  } else if (mc > 25_000) {
    score -= 8;
    blockers.push("MC too high for entry alert");
  } else if (mc > 0 && mc < 5_000) {
    blockers.push("MC below $5K floor");
  }

  // ── Security ─────────────────────────────────────────────────────────────
  if (inp.secMintRenounced === true) {
    score += 10;
    reasons.push("Mint renounced");
  } else if (inp.secMintRenounced === false) {
    score -= 8;
    blockers.push("mint still open");
  }
  if (inp.secFreezeRenounced === true) {
    score += 4;
    reasons.push("Freeze renounced");
  }

  // ── Conviction quality ───────────────────────────────────────────────────
  const shr = inp.smartHoldRate;
  if (shr != null && Number.isFinite(shr)) {
    if (shr >= 0.8) {
      score += 12;
      reasons.push(`Smart hold ${(shr * 100).toFixed(0)}%`);
    } else if (shr >= 0.5) {
      score += 8;
      reasons.push(`Smart hold ${(shr * 100).toFixed(0)}%`);
    } else if (shr < 0.25) {
      score -= 12;
      blockers.push("weak smart hold (<25%)");
    }
  }
  if ((inp.diamondHands ?? 0) >= 1) {
    score += 4;
    reasons.push("Diamond hands present");
  }
  if ((inp.paperHands ?? 0) >= 4) {
    score -= 6;
  }

  // ── Holder velocity (call-time) ──────────────────────────────────────────
  const hv = inp.calledHolderVelocity;
  if (hv != null && hv >= 80) {
    score += 5;
    reasons.push(`HV ${Math.round(hv)}`);
  }

  // ── Cap-table risk ───────────────────────────────────────────────────────
  if (inp.top10HolderRate != null && inp.top10HolderRate > 0.45) {
    score -= 8;
    blockers.push("top10 concentrated");
  }
  if (inp.bundlerPct != null && inp.bundlerPct > 0.35) {
    score -= 6;
    blockers.push("high bundler %");
  }

  score = clamp(Math.round(score));

  // ── Hard alert gates (Rule D + freshness — paid tier) ────────────────────
  const ageOk = inp.ageMinutes == null || inp.ageMinutes <= ALERT_MAX_AGE_MIN;
  const gainOk = inp.gainSinceCallPct == null || inp.gainSinceCallPct < ALERT_MAX_GAIN_PCT;
  if (!ageOk) blockers.push(`stale (>${ALERT_MAX_AGE_MIN}m)`);
  if (!gainOk) blockers.push("already pumped — not an entry");

  const hardGates =
    cluster &&
    intel >= 90 &&
    mc >= 5_000 &&
    mc <= 15_000 &&
    inp.secMintRenounced === true &&
    inp.secIsHoneypot !== true &&
    ageOk &&
    gainOk;

  const alertEligible = hardGates && score >= ALERT_MIN_SCORE;

  let tier: ConfidenceTier = "desk";
  if (alertEligible) tier = "alert";
  // Watch: same cluster signal, looser intel/MC — research lane, no Telegram.
  // MC extended to $25K so 15–25K near-misses stay visible (Alert stays $5–15K).
  else if (cluster && intel >= 85 && mc >= 5_000 && mc <= 25_000 && inp.secIsHoneypot !== true) {
    tier = "watch";
  }

  const label =
    tier === "alert" ? "High confidence" :
    tier === "watch" ? "Watch" :
    "Desk";

  return { score, tier, alertEligible, reasons: reasons.slice(0, 6), blockers: blockers.slice(0, 4), label };
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
