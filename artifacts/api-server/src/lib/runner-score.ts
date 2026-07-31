/**
 * Runner Score — extract daily runners from early bot-wallet radar.
 *
 * Philosophy:
 *   • Wallets are early sensors (often dump) — not copy targets
 *   • Intel is a baseline, not the final veto
 *   • Tagged smart/KOL: soft boost if anyone is still holding (OR, not AND)
 *   • Momentum (MC velocity / snapshot deltas) decides ENTRY
 *   • ENTRY requires ≥5 observation snaps — never alert on a hot tick alone
 *   • Phase labels are sticky (hysteresis) so snap noise doesn't thrash the desk
 */

export type RunnerPhase = "radar" | "heating" | "entry" | "fading" | "dead";

/** Minimum momentum snaps on the tape before ENTRY phase / Telegram alert. */
export const MIN_ENTRY_OBSERVATION_SNAPS = 5;

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
  /** Signed MC change % since previous snapshot. */
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
  /** Previous persisted phase — enables hysteresis. */
  prevPhase?: RunnerPhase | null;
  /** Previous runner score — EMA smooth. */
  prevScore?: number | null;
  /**
   * Count of pro_snapshots already on the tape for this call.
   * ENTRY phase + alertEligible are impossible below MIN_ENTRY_OBSERVATION_SNAPS.
   */
  snapCount?: number | null;
}

export interface RunnerScoreResult {
  score: number;
  phase: RunnerPhase;
  /** Instantaneous phase before hysteresis + observation gate. */
  rawPhase: RunnerPhase;
  /** True when stabilized phase differs from prevPhase. */
  phaseChanged: boolean;
  /** Paid Telegram ENTRY ping — requires phase entry AND ≥5 snaps. */
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
    snapCount: number;
    observationReady: boolean;
  };
}

/** Factors to persist / log alongside a phase transition. */
export type RunnerTransitionContext = {
  from: RunnerPhase;
  to: RunnerPhase;
  score: number;
  mcUsd: number | null;
  calledMcUsd: number | null;
  velocity: number;
  gainPct: number;
  athMultiple: number;
  smart: number;
  kol: number;
  intel: number | null;
  snapCount: number;
  reasons: string[];
  blockers: string[];
};

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

function phaseLabel(phase: RunnerPhase): string {
  return phase === "entry" ? "Entry" :
    phase === "heating" ? "Heating" :
    phase === "fading" ? "Fading" :
    phase === "dead" ? "Dead" :
    "Radar";
}

/** Soft tagged-wallet gate: anyone (smart OR KOL) holding / tagged is enough. */
export function hasTaggedPresence(smart: number, kol: number): boolean {
  return smart >= 1 || kol >= 1;
}

export function observationReady(snapCount: number | null | undefined): boolean {
  return (snapCount ?? 0) >= MIN_ENTRY_OBSERVATION_SNAPS;
}

/**
 * Whether to write a new snapshot.
 *
 * Observation window (snapCount < 5): collect denser tape on heating /
 * interesting radar so ENTRY never fires on a thin sample.
 * After observation: classic momentum cadence (move → write, flat → sparse).
 */
export function shouldWriteMomentumSnap(opts: {
  lastSnapAgeSec: number | null;
  mcDeltaPct: number;
  ageMinutes: number;
  phase: RunnerPhase;
  mode: "hot" | "full";
  /** Always write when phase/label changes so the tape carries the event. */
  force?: boolean;
  /** Meaningful score move vs last persisted score. */
  scoreDelta?: number | null;
  /** Existing snaps on tape — drives observation collection. */
  snapCount?: number | null;
  /** Raw interest before observation gate (velocity / heating path). */
  observing?: boolean;
}): boolean {
  const {
    lastSnapAgeSec, mcDeltaPct, ageMinutes, phase, mode,
    force, scoreDelta, snapCount, observing,
  } = opts;
  if (force) return true;
  if (lastSnapAgeSec == null) return true;

  const count = snapCount ?? 0;
  const inObservation = count < MIN_ENTRY_OBSERVATION_SNAPS;
  const moving = mcDeltaPct >= (inObservation && observing ? 0.012 : 0.025);
  const scoreJump = scoreDelta != null && Math.abs(scoreDelta) >= (inObservation ? 4 : 6);

  // Observation window — deliberately denser collection for candidates
  if (inObservation && (observing || phase === "heating" || phase === "entry")) {
    const obsGap = moving ? 14 : 22;
    if (lastSnapAgeSec < obsGap) {
      return lastSnapAgeSec >= 12 && scoreJump;
    }
    if (moving || scoreJump) return true;
    // Timed observation heartbeat — build the 5-snap tape
    if (lastSnapAgeSec >= 28 && ageMinutes < 180) return true;
    return false;
  }

  const minGap = moving ? 12 : phase === "heating" || phase === "entry" ? 20 : 40;
  if (lastSnapAgeSec < minGap) {
    if (lastSnapAgeSec >= 12 && scoreDelta != null && Math.abs(scoreDelta) >= 8) return true;
    return false;
  }

  if (moving) return true;
  if (scoreJump) return true;

  if (ageMinutes < 20) return lastSnapAgeSec >= 35;
  if (ageMinutes < 60) return lastSnapAgeSec >= 75;
  if (ageMinutes < 180) return lastSnapAgeSec >= (mode === "hot" ? 120 : 180);
  return lastSnapAgeSec >= 300;
}

/**
 * Sticky phase machine — prevent one noisy tick from flipping ENTRY ↔ Radar.
 * Promotions are cautious; demotions step through fading; dead needs real damage.
 * ENTRY promotion additionally requires observationReady (snapCount ≥ 5).
 */
export function stabilizeRunnerPhase(
  prev: RunnerPhase | null | undefined,
  raw: RunnerPhase,
  ctx: {
    velocity: number;
    gainPct: number;
    athMultiple: number;
    snapCount?: number | null;
  },
): RunnerPhase {
  const p: RunnerPhase = prev ?? "radar";
  const { velocity: vel, gainPct: gain, athMultiple: ath } = ctx;
  const ready = observationReady(ctx.snapCount);

  // Hard death — immediate
  if (raw === "dead" || ath < 0.55 || (gain < -45 && vel < 0.9)) return "dead";

  if (p === "dead") {
    if (vel >= 1.28 && gain > -8) return "heating";
    return "dead";
  }

  if (p === "entry") {
    // If somehow labeled entry without snaps (legacy), demote to heating
    if (!ready) return "heating";
    if (raw === "entry") return "entry";
    if (vel >= 1.18 || (ath >= 1.4 && gain >= 10)) return "entry";
    if (raw === "fading" || vel < 1.08) return "fading";
    return "entry";
  }

  if (p === "fading") {
    if (raw === "entry" && vel >= 1.32 && ready) return "entry";
    if (raw === "entry" && !ready) return "heating";
    if ((raw === "heating" || raw === "entry") && vel >= 1.18) return "heating";
    return "fading";
  }

  if (p === "heating") {
    // Never jump to ENTRY until the observation tape is complete
    if (raw === "entry" && ready) return "entry";
    if (raw === "fading" && vel < 1.06) return "fading";
    if (raw === "radar" && vel < 1.06 && gain < 5) return "radar";
    return "heating";
  }

  // radar — promote carefully; strong breakout can skip to entry only after snaps
  if (raw === "entry" && vel >= 1.45 && ready) return "entry";
  if (raw === "entry" || raw === "heating") return "heating";
  return "radar";
}

function deriveRawPhase(opts: {
  ath: number;
  gain: number;
  vel: number;
  delta: number | null;
}): RunnerPhase {
  const { ath, gain, vel, delta } = opts;
  if (ath < 0.55 || (gain < -45 && vel < 0.9)) return "dead";
  if (vel >= 1.35 || (vel >= 1.2 && gain >= 25) || (ath >= 1.5 && gain >= 20)) return "entry";
  if (vel >= 1.12 || gain >= 12 || (delta != null && delta >= 0.05)) return "heating";
  if (ath >= 1.3 && (vel < 1.05 || gain < 5)) return "fading";
  if (ath >= 1.5 && vel < 1.0 && gain < (ath - 1) * 100 * 0.3) {
    return gain < -25 ? "dead" : "fading";
  }
  return "radar";
}

export function computeRunnerScore(inp: RunnerScoreInput): RunnerScoreResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const snapCount = Math.max(0, Math.floor(inp.snapCount ?? 0));
  const obsReady = observationReady(snapCount);

  if (inp.secIsHoneypot === true) {
    const prev = inp.prevPhase ?? null;
    return {
      score: 0,
      phase: "dead",
      rawPhase: "dead",
      phaseChanged: prev != null && prev !== "dead",
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
        snapCount,
        observationReady: obsReady,
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
  const freshnessOk = ageMin <= 180;

  let score = 28;

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

  if (mintOk) {
    score += 10;
    reasons.push("Mint renounced");
  } else if (inp.secMintRenounced === false) {
    score -= 6;
    blockers.push("mint open");
  }
  if (inp.secFreezeRenounced === true) score += 3;

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

  // Observation progress — visible on desk, never a score cheat code
  if (!obsReady) {
    reasons.push(`Observing ${snapCount}/${MIN_ENTRY_OBSERVATION_SNAPS} snaps`);
  } else {
    reasons.push(`Tape ${snapCount} snaps`);
  }

  score = clamp(Math.round(score));

  if (inp.prevScore != null && Number.isFinite(inp.prevScore)) {
    score = clamp(Math.round(0.62 * score + 0.38 * inp.prevScore));
  }

  const rawPhase = deriveRawPhase({ ath, gain, vel, delta });
  const phase = stabilizeRunnerPhase(inp.prevPhase, rawPhase, {
    velocity: vel,
    gainPct: gain,
    athMultiple: ath,
    snapCount,
  });
  const phaseChanged = (inp.prevPhase ?? "radar") !== phase;

  if (phaseChanged) {
    reasons.unshift(`${phaseLabel(inp.prevPhase ?? "radar")}→${phaseLabel(phase)}`);
  }

  // Strict: never alert without observation tape — even if phase somehow entry
  const alertEligible =
    phase === "entry"
    && obsReady
    && score >= 62
    && freshnessOk
    && (mintOk || intel >= 85)
    && (taggedOk || vel >= 1.6);

  if (!obsReady && (rawPhase === "entry" || phase === "heating")) {
    blockers.push(`need ${MIN_ENTRY_OBSERVATION_SNAPS - snapCount} more snaps`);
  }
  if (!freshnessOk && phase === "entry") blockers.push("stale (>3h)");
  if (!alertEligible && phase === "entry") {
    if (!obsReady) blockers.push(`observing ${snapCount}/${MIN_ENTRY_OBSERVATION_SNAPS}`);
    if (!mintOk && intel < 85) blockers.push("mint/intel soft block");
    if (!taggedOk && vel < 1.6) blockers.push("need tagged or stronger velocity");
  }

  return {
    score,
    phase,
    rawPhase,
    phaseChanged,
    alertEligible,
    label: phaseLabel(phase),
    reasons: reasons.slice(0, 6),
    blockers: blockers.slice(0, 4),
    sizeLabel: sizeLabel(inp.currentMcUsd ?? inp.calledMcUsd),
    signals: {
      velocity: Math.round(vel * 100) / 100,
      gainPct: Math.round(gain * 10) / 10,
      taggedOk,
      mintOk,
      freshnessOk,
      snapCount,
      observationReady: obsReady,
    },
  };
}

/** Build a transition payload for ops/logging when phase changes. */
export function buildRunnerTransition(
  prev: RunnerPhase | null | undefined,
  runner: RunnerScoreResult,
  factors: {
    mcUsd: number | null;
    calledMcUsd: number | null;
    athMultiple: number;
    smart: number;
    kol: number;
    intel: number | null;
  },
): RunnerTransitionContext | null {
  if (!runner.phaseChanged) return null;
  return {
    from: prev ?? "radar",
    to: runner.phase,
    score: runner.score,
    mcUsd: factors.mcUsd,
    calledMcUsd: factors.calledMcUsd,
    velocity: runner.signals.velocity,
    gainPct: runner.signals.gainPct,
    athMultiple: factors.athMultiple,
    smart: factors.smart,
    kol: factors.kol,
    intel: factors.intel,
    snapCount: runner.signals.snapCount,
    reasons: runner.reasons,
    blockers: runner.blockers,
  };
}
