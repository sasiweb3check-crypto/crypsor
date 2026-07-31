/**
 * Runner Score — extract daily runners from early bot-wallet radar.
 *
 * Philosophy:
 *   • Wallets are early sensors (often dump) — not copy targets
 *   • Intel is a baseline, not the final veto
 *   • Tagged smart/KOL: soft boost if anyone is still holding (OR, not AND)
 *   • Momentum (MC velocity / snapshot deltas) decides ENTRY alerts
 *   • No hard $5–15K MC gate — MC is a size label only
 */

export type RunnerPhase = "radar" | "heating" | "entry" | "fading" | "dead";

export interface RunnerScoreInput {
  calledIntelScore: number | null;
  calledSmartCount: number;
  calledKolCount: number;
  calledMcUsd: number | null;
  currentMcUsd: number | null;
  /** Peak multiple since call (ATH / entry). */
  athMultiple: number;
  /** Live gain % since entry. */
  gainPct: number;
  /** Minutes since called_at. */
  ageMinutes: number;
  /** MC velocity vs entry over recent window (current/entry). */
  velocity: number;
  /** Absolute MC change % since previous snapshot (0–1+). */
  snapDeltaPct: number | null;
  /** Live tagged counts (totals or holding — best available). */
  liveSmart: number;
  liveKol: number;
  secIsHoneypot?: boolean | null;
  secMintRenounced?: boolean | null;
  secFreezeRenounced?: boolean | null;
  holderVelocityScore?: number | null;
  volumeIntensityScore?: number | null;
  smartHoldRate?: number | null;
}

export interface RunnerScoreResult {
  score: number;
  phase: RunnerPhase;
  /** Paid Telegram ENTRY ping. */
  alertEligible: boolean;
  label: string;
  reasons: string[];
  blockers: string[];
  /** Size bucket for UI only — never a hard alert gate. */
  sizeLabel: "micro" | "small" | "mid" | "large" | "whale";
  signals: {
    velocity: number;
    gainPct: number;
    taggedOk: boolean;
    mintOk: boolean;
    freshnessOk: boolean;
  };
}

function clamp(v: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

function sizeLabel(mc: number | null): RunnerScoreResult["sizeLabel"] {
  const m = mc ?? 0;
  if (m < 10_000) return "micro";
  if (m < 25_000) return "small";
  if (m < 75_000) return "mid";
  if (m < 250_000) return "large";
  return "whale";
}

/** Soft tagged-wallet gate: anyone (smart OR KOL) holding / tagged is enough. */
export function hasTaggedPresence(smart: number, kol: number): boolean {
  return smart >= 1 || kol >= 1;
}

/**
 * Whether to write a new snapshot (momentum-based, not fixed hourly spam).
 * Moving MC → frequent; flat → sparse. Low-MC tokens aren't forced into 1h dumps.
 */
export function shouldWriteMomentumSnap(opts: {
  lastSnapAgeSec: number | null;
  mcDeltaPct: number;
  ageMinutes: number;
  phase: RunnerPhase;
  mode: "hot" | "full";
}): boolean {
  const { lastSnapAgeSec, mcDeltaPct, ageMinutes, phase, mode } = opts;
  if (lastSnapAgeSec == null) return true;

  const moving = mcDeltaPct >= 0.025; // ≥2.5% MC move
  const minGap = moving ? 12 : phase === "heating" || phase === "entry" ? 20 : 40;
  if (lastSnapAgeSec < minGap) return false;

  if (moving) return true;

  // Flat tape — sparse heartbeats by age
  if (ageMinutes < 20) return lastSnapAgeSec >= 35;
  if (ageMinutes < 60) return lastSnapAgeSec >= 75;
  if (ageMinutes < 180) return lastSnapAgeSec >= (mode === "hot" ? 120 : 180);
  return lastSnapAgeSec >= 300;
}

export function computeRunnerScore(inp: RunnerScoreInput): RunnerScoreResult {
  const reasons: string[] = [];
  const blockers: string[] = [];

  if (inp.secIsHoneypot === true) {
    return {
      score: 0,
      phase: "dead",
      alertEligible: false,
      label: "Honeypot",
      reasons,
      blockers: ["honeypot"],
      sizeLabel: sizeLabel(inp.calledMcUsd),
      signals: {
        velocity: inp.velocity,
        gainPct: inp.gainPct,
        taggedOk: false,
        mintOk: false,
        freshnessOk: false,
      },
    };
  }

  const smart = Math.max(0, inp.calledSmartCount, inp.liveSmart);
  const kol = Math.max(0, inp.calledKolCount, inp.liveKol);
  const taggedOk = hasTaggedPresence(smart, kol);
  const intel = inp.calledIntelScore ?? 0;
  const vel = Number.isFinite(inp.velocity) ? inp.velocity : 1;
  const gain = Number.isFinite(inp.gainPct) ? inp.gainPct : 0;
  const ath = Number.isFinite(inp.athMultiple) ? inp.athMultiple : 1;
  const ageMin = inp.ageMinutes;
  const mintOk = inp.secMintRenounced === true;
  const freshnessOk = ageMin <= 180; // 3h radar window for entry confirmation

  let score = 28;

  // ── Soft tagged presence (OR — not cluster hard gate) ────────────────────
  if (smart >= 1 && kol >= 1) {
    score += 14;
    reasons.push(`Tagged · ${smart} smart + ${kol} KOL`);
  } else if (smart >= 1) {
    score += 10;
    reasons.push(`${smart} smart tagged`);
  } else if (kol >= 1) {
    score += 10;
    reasons.push(`${kol} KOL tagged`);
  } else {
    score += 2;
    blockers.push("no tagged smart/KOL yet");
  }

  // ── Intel baseline (soft) ────────────────────────────────────────────────
  if (intel >= 90) {
    score += 12;
    reasons.push(`Intel ${Math.round(intel)}`);
  } else if (intel >= 80) {
    score += 8;
  } else if (intel >= 70) {
    score += 4;
  } else if (intel > 0) {
    blockers.push(`intel ${Math.round(intel)} low`);
  }

  // ── Momentum / velocity (core edge) ──────────────────────────────────────
  if (vel >= 2.5) {
    score += 28;
    reasons.push(`Velocity ${vel.toFixed(2)}×`);
  } else if (vel >= 1.8) {
    score += 22;
    reasons.push(`Velocity ${vel.toFixed(2)}×`);
  } else if (vel >= 1.4) {
    score += 16;
    reasons.push(`Velocity ${vel.toFixed(2)}×`);
  } else if (vel >= 1.2) {
    score += 10;
    reasons.push(`Heating ${vel.toFixed(2)}×`);
  } else if (vel >= 1.05) {
    score += 4;
  } else if (vel < 0.85) {
    score -= 12;
    blockers.push("MC fading");
  }

  const delta = inp.snapDeltaPct;
  if (delta != null && delta >= 0.08) {
    score += 8;
    reasons.push(`Snap Δ +${Math.round(delta * 100)}%`);
  } else if (delta != null && delta <= -0.12) {
    score -= 10;
    blockers.push("sharp snap dump");
  }

  // ── Security ─────────────────────────────────────────────────────────────
  if (mintOk) {
    score += 10;
    reasons.push("Mint renounced");
  } else if (inp.secMintRenounced === false) {
    score -= 6;
    blockers.push("mint open");
  }
  if (inp.secFreezeRenounced === true) score += 3;

  // ── Flow helpers ─────────────────────────────────────────────────────────
  if ((inp.holderVelocityScore ?? 0) >= 80) {
    score += 5;
    reasons.push("HV strong");
  }
  if ((inp.volumeIntensityScore ?? 0) >= 70) {
    score += 4;
    reasons.push("Volume expanding");
  }
  if ((inp.smartHoldRate ?? 1) < 0.25 && smart >= 2) {
    score -= 6;
    blockers.push("weak smart hold");
  }

  score = clamp(Math.round(score));

  // ── Phase machine ────────────────────────────────────────────────────────
  let phase: RunnerPhase = "radar";
  if (ath < 0.55 || (gain < -45 && vel < 0.9)) {
    phase = "dead";
  } else if (vel >= 1.35 || (vel >= 1.2 && gain >= 25) || (ath >= 1.5 && gain >= 20)) {
    phase = "entry";
  } else if (vel >= 1.12 || gain >= 12 || (delta != null && delta >= 0.05)) {
    phase = "heating";
  } else if (ath >= 1.3 && (vel < 1.05 || gain < 5)) {
    phase = "fading";
  }

  // Printed then cooled hard
  if (phase !== "dead" && ath >= 1.5 && vel < 1.0 && gain < (ath - 1) * 100 * 0.3) {
    phase = gain < -25 ? "dead" : "fading";
  }

  const alertEligible =
    phase === "entry"
    && score >= 62
    && freshnessOk
    && (mintOk || intel >= 85) // mint preferred; high intel can still ping
    && (taggedOk || vel >= 1.6); // prefer tagged; strong velocity alone OK

  if (!freshnessOk && phase === "entry") blockers.push("stale (>3h)");
  if (!alertEligible && phase === "entry") {
    if (!mintOk && intel < 85) blockers.push("mint/intel soft block");
    if (!taggedOk && vel < 1.6) blockers.push("need tagged or stronger velocity");
  }

  const label =
    phase === "entry" ? "Entry" :
    phase === "heating" ? "Heating" :
    phase === "fading" ? "Fading" :
    phase === "dead" ? "Dead" :
    "Radar";

  return {
    score,
    phase,
    alertEligible,
    label,
    reasons: reasons.slice(0, 6),
    blockers: blockers.slice(0, 4),
    sizeLabel: sizeLabel(inp.currentMcUsd ?? inp.calledMcUsd),
    signals: {
      velocity: Math.round(vel * 100) / 100,
      gainPct: Math.round(gain * 10) / 10,
      taggedOk,
      mintOk,
      freshnessOk,
    },
  };
}
