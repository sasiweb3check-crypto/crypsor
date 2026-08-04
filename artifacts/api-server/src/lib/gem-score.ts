/**
 * GEM Score v1 — one final trusted score for low-cap memecoin gem hunting.
 *
 * Design principles (research-backed: MELT/MemeTrans Solana launch datasets,
 * pump.fun graduation studies, sniper/bundler cluster analysis):
 *
 *   1. NO CALL WITHOUT EVIDENCE. The score is only allowed to say "GEM" when
 *      we actually hold the data to justify it: several minutes of market
 *      tape, fresh holder distribution, and a security read. Missing data
 *      lowers `confidence` and blocks the GEM verdict — it never fakes a pass.
 *
 *   2. HARD VETOES BEFORE POINTS. Honeypot, live mint/freeze authority,
 *      extreme insider concentration, bot-swarmed launches and untradable
 *      liquidity are disqualifying no matter how hot the chart looks.
 *      These are the patterns behind most rugs; points can't buy them back.
 *
 *   3. DELTAS OVER LEVELS. A 30K MC means nothing; +8%/min MC velocity with
 *      accelerating buys, growing holders and independent wallets does.
 *      Every flow/holder pillar is computed from the gem_snapshots tape,
 *      not from a single API read.
 *
 *   4. WASH-AWARE. Volume/liquidity heat only counts when holders are
 *      actually growing — high vol on flat holders is treated as recycling.
 *
 * Pillars (weights sum to 1):
 *   flow      0.30  buy/sell imbalance, MC velocity + acceleration, tradable heat
 *   holders   0.25  holder growth rate, top10 concentration, sniper/bundler share
 *   smart     0.20  distinct tracked-wallet buys, smart money, KOL holders
 *   structure 0.15  liquidity depth, liq/MC band, LP lock, taxes
 *   timing    0.10  pair age + MC band entry window (low-cap sweet spot)
 *
 * Verdicts:
 *   AVOID   any veto fired
 *   GEM     score ≥ 70 AND confidence ≥ 0.7 AND tape ≥ 5 snapshots
 *           AND ≥ 1 tracked wallet buy AND persisted for 2+ consecutive evals
 *   WATCH   score ≥ 55 (or promising but low-confidence)
 *   NEUTRAL everything else
 */

export type GemVerdict = "GEM" | "WATCH" | "NEUTRAL" | "AVOID";

/** One tape row (gem_snapshots), oldest → newest. */
export type GemTapePoint = {
  atMs: number;
  mcUsd: number | null;
  liqUsd: number | null;
  vol5m: number | null;
  buys5m: number | null;
  sells5m: number | null;
  buys1h: number | null;
  sells1h: number | null;
  holderCount: number | null;
};

export type GemInputs = {
  /** Latest market read (same tick the score is computed on) */
  mcUsd: number;
  liqUsd: number;
  vol5m: number;
  vol1h: number;
  vol24h: number;
  buys5m: number;
  sells5m: number;
  buys1h: number;
  sells1h: number;
  pairAgeMin: number | null;

  /** Tape (oldest → newest), including the current tick */
  tape: GemTapePoint[];

  /** Holder distribution (null = never fetched) */
  holderCount: number | null;
  holderTop10Pct: number | null;      // percent 0-100
  sniperCount: number | null;
  bundlerCount: number | null;
  smartCount: number | null;
  kolCount: number | null;
  largestClusterPct: number | null;   // percent 0-100
  cabalDetected: boolean | null;
  holdersFresh: boolean;              // holder data updated recently enough to trust

  /**
   * GMGN hold shares (percent of supply held by tagged wallets, pools
   * excluded). Trusted-lift inputs: smart/KOL holding real size is the
   * strongest independent conviction we can observe. Sniper/bundler shares
   * replace raw counts for vetoes — counts from GMGN stat are cumulative
   * participants and would false-flag nearly every pump.fun launch.
   */
  smartHoldPct: number | null;
  kolHoldPct: number | null;
  sniperHoldPct: number | null;
  bundlerHoldPct: number | null;

  /** Security read (null = never fetched) */
  honeypot: boolean | null;
  mintRenounced: boolean | null;
  freezeRenounced: boolean | null;
  buyTaxPct: number | null;           // percent 0-100
  sellTaxPct: number | null;
  lpLocked: boolean | null;
  securityFetched: boolean;

  /** Conviction: distinct tracked wallets that bought */
  trackedWalletBuys: number;

  /** Previous consecutive GEM-qualifying evaluations (persistence gate) */
  prevGemStreak: number;
};

export type GemComponents = {
  flow: number;
  holders: number;
  smart: number;
  structure: number;
  timing: number;
};

export type GemResult = {
  score: number;                // 0-100 final
  verdict: GemVerdict;
  confidence: number;           // 0-1
  components: GemComponents;
  vetoes: string[];
  gemStreak: number;            // updated streak to persist
  snapshotsUsed: number;
  notes: string[];              // human-readable evidence highlights
};

const WEIGHTS: Record<keyof GemComponents, number> = {
  flow: 0.30,
  holders: 0.25,
  smart: 0.20,
  structure: 0.15,
  timing: 0.10,
};

export const GEM_SCORE_MIN = 70;
export const GEM_CONFIDENCE_MIN = 0.7;
export const GEM_MIN_SNAPSHOTS = 5;
export const GEM_STREAK_REQUIRED = 2;
export const WATCH_SCORE_MIN = 55;

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
/** Linear ramp: 0 at `lo`, 100 at `hi`. */
const ramp = (v: number, lo: number, hi: number) =>
  clamp(((v - lo) / (hi - lo)) * 100);

// ── Vetoes ──────────────────────────────────────────────────────────────────

function collectVetoes(i: GemInputs): string[] {
  const v: string[] = [];
  if (i.honeypot === true) v.push("honeypot");
  if (i.mintRenounced === false) v.push("mint_authority_live");
  if (i.freezeRenounced === false) v.push("freeze_authority_live");
  const tax = Math.max(i.buyTaxPct ?? 0, i.sellTaxPct ?? 0);
  if (tax > 10) v.push(`tax_${Math.round(tax)}pct`);
  if ((i.holderTop10Pct ?? 0) > 45) v.push("top10_over_45pct");
  if ((i.largestClusterPct ?? 0) > 30) v.push("wallet_cluster_over_30pct");
  if (i.cabalDetected === true) v.push("cabal_cluster");
  // Bot-controlled supply: judged by HOLD SHARE of current supply, not raw
  // participant counts (GMGN counts are cumulative and would flag everything).
  if ((i.sniperHoldPct ?? 0) > 20) v.push("snipers_hold_over_20pct");
  if ((i.bundlerHoldPct ?? 0) > 25) v.push("bundlers_hold_over_25pct");
  // Untradable: real size can't exit — MC pumped far beyond the pool
  if (i.mcUsd > 25_000 && i.liqUsd > 0 && i.liqUsd < 3_000) v.push("exit_liquidity_too_thin");
  return v;
}

// ── Pillars ─────────────────────────────────────────────────────────────────

/** Buy/sell imbalance + MC velocity/acceleration + tradable heat (wash-aware). */
function scoreFlow(i: GemInputs, notes: string[]): number {
  // Buy pressure: 5m dominates (temperature now), 1h stabilizes
  const r5 = i.buys5m + i.sells5m >= 6 ? i.buys5m / (i.buys5m + i.sells5m) : null;
  const r1h = i.buys1h + i.sells1h >= 20 ? i.buys1h / (i.buys1h + i.sells1h) : null;
  // 0.50 neutral → 0 pts; 0.72+ → full
  const buyImbalance =
    r5 == null && r1h == null
      ? 30 // not enough txns to judge — mildly negative prior
      : clamp((((r5 ?? r1h ?? 0.5) * 0.65 + (r1h ?? r5 ?? 0.5) * 0.35) - 0.5) / 0.22 * 100);

  // MC velocity: %/min over the last ~10 min of tape; acceleration = recent
  // half vs earlier half. Both from snapshots, not a single priceChange read.
  let velocity = 0;   // %/min
  let accel = 0;      // ratio recent/earlier
  const recentTape = i.tape.filter((p) => p.mcUsd != null && p.mcUsd > 0);
  if (recentTape.length >= 3) {
    const last = recentTape[recentTape.length - 1];
    const windowStart = last.atMs - 12 * 60_000;
    const win = recentTape.filter((p) => p.atMs >= windowStart);
    if (win.length >= 3) {
      const first = win[0];
      const mins = Math.max(1, (last.atMs - first.atMs) / 60_000);
      velocity = ((last.mcUsd! - first.mcUsd!) / first.mcUsd!) * 100 / mins;

      const mid = win[Math.floor(win.length / 2)];
      const early = mid.mcUsd! > 0 ? (mid.mcUsd! - first.mcUsd!) / first.mcUsd! : 0;
      const late = mid.mcUsd! > 0 ? (last.mcUsd! - mid.mcUsd!) / mid.mcUsd! : 0;
      accel = early > 0.005 ? late / early : (late > 0.01 ? 2 : 1);
    }
  }
  // +1%/min is real; +6%/min is a rocket
  const velocityScore = velocity <= 0 ? clamp(50 + velocity * 10, 0, 50) : ramp(velocity, 0, 6);
  const accelBonus = accel >= 1.5 ? 100 : accel >= 1 ? 60 : 25;

  // Tradable heat: 5m volume vs liquidity — but only counts as organic when
  // holders are actually growing (wash guard).
  const heatRaw = i.liqUsd > 0 ? (i.vol5m * 12) / i.liqUsd : 0; // hourly-ized v/l
  let heat = ramp(heatRaw, 0.2, 6);
  const holderGrowth = holderGrowthPerMin(i.tape);
  const holdersFlat = holderGrowth != null && holderGrowth <= 0;
  const washy = heatRaw > 10 && holdersFlat;
  if (washy) {
    heat = Math.min(heat, 25);
    notes.push("wash-like volume (high v/l, flat holders)");
  }

  if (velocity > 2 && (r5 ?? 0) > 0.65) notes.push(`+${velocity.toFixed(1)}%/min with ${Math.round((r5 ?? 0) * 100)}% buys`);

  let flow = clamp(buyImbalance * 0.35 + velocityScore * 0.30 + accelBonus * 0.15 + heat * 0.20);
  // Momentum without new participants is recycled flow, not accumulation:
  // MC velocity and buy imbalance are as fakeable as volume, so a wash-like
  // pattern caps the whole pillar, not just the heat term.
  if (washy) flow = Math.min(flow, 40);
  else if (holdersFlat && velocity > 1) flow = Math.min(flow, 60);
  return flow;
}

function holderGrowthPerMin(tape: GemTapePoint[]): number | null {
  const pts = tape.filter((p) => p.holderCount != null && p.holderCount > 0);
  if (pts.length < 2) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const mins = Math.max(1, (last.atMs - first.atMs) / 60_000);
  return (last.holderCount! - first.holderCount!) / mins;
}

/** Distribution breadth + growth. Missing holder data → conservative midline. */
function scoreHolders(i: GemInputs, notes: string[]): number {
  if (i.holderCount == null || i.holderCount <= 0) return 40;

  // Growth: +1 holder/min decent, +5/min strong
  const growth = holderGrowthPerMin(i.tape);
  const growthScore = growth == null ? 45 : growth <= 0 ? 20 : ramp(growth, 0, 5);

  // Concentration: top10 <18% great → 40% bad (veto at 45)
  const top10 = i.holderTop10Pct;
  const concScore = top10 == null ? 50 : clamp(100 - ramp(top10, 18, 40));

  // Bot pressure: prefer hold shares (current supply control); fall back to
  // participant counts capped by holder base (GMGN counts are cumulative).
  let botScore: number;
  if (i.sniperHoldPct != null || i.bundlerHoldPct != null) {
    const botHold = (i.sniperHoldPct ?? 0) + (i.bundlerHoldPct ?? 0);
    botScore = clamp(100 - ramp(botHold, 3, 25)); // 3% held fine → 25% toxic
  } else {
    const bots = Math.min(
      (i.sniperCount ?? 0) + (i.bundlerCount ?? 0),
      i.holderCount,
    );
    const botShare = i.holderCount > 0 ? bots / Math.max(20, i.holderCount) : 0;
    botScore = clamp(100 - ramp(botShare, 0.05, 0.45));
  }

  // Base breadth: 50 holders early is fine, 250+ is conviction
  const breadth = ramp(i.holderCount, 20, 250);

  if ((growth ?? 0) >= 2) notes.push(`holders +${growth!.toFixed(1)}/min`);
  if (top10 != null && top10 < 20) notes.push(`top10 ${top10.toFixed(0)}%`);

  return clamp(growthScore * 0.35 + concScore * 0.30 + botScore * 0.20 + breadth * 0.15);
}

/**
 * Independent conviction: our tracked wallets + smart money + KOLs.
 * GMGN hold shares are the trusted lift — smart/KOL wallets holding real
 * supply is worth far more than their mere presence in the holder list.
 */
function scoreSmart(i: GemInputs, notes: string[]): number {
  const tracked = i.trackedWalletBuys;
  const trackedScore = tracked >= 3 ? 85 : tracked === 2 ? 60 : tracked === 1 ? 28 : 0;
  const smartBonus = Math.min(30, (i.smartCount ?? 0) * 7);
  const kolBonus = Math.min(24, (i.kolCount ?? 0) * 8);

  // Hold-share lift: combined smart+KOL supply share.
  // 1% held ≈ +10 · 3% ≈ +25 · 6%+ ≈ +35 (capped). KOL share weighted heavier.
  const holdCombined = (i.smartHoldPct ?? 0) + (i.kolHoldPct ?? 0) * 1.5;
  const holdLift = holdCombined > 0 ? Math.min(35, ramp(holdCombined, 0.3, 6) * 0.35) : 0;

  if (tracked >= 2) notes.push(`${tracked} tracked wallets in`);
  if ((i.smartHoldPct ?? 0) >= 0.5 || (i.kolHoldPct ?? 0) >= 0.3) {
    notes.push(
      `smart/KOL hold ${((i.smartHoldPct ?? 0) + (i.kolHoldPct ?? 0)).toFixed(1)}%`,
    );
  } else if ((i.smartCount ?? 0) > 0) {
    notes.push(`${i.smartCount} smart money holders`);
  }

  return clamp(trackedScore + smartBonus + kolBonus + holdLift);
}

/** Liquidity depth, liq/MC health band, LP lock, taxes. */
function scoreStructure(i: GemInputs, notes: string[]): number {
  const depth = ramp(i.liqUsd, 3_000, 40_000);

  // liq/MC: healthy pump.fun-graduate band ~0.1–0.8; below 0.05 is a trap
  const ratio = i.mcUsd > 0 ? i.liqUsd / i.mcUsd : 0;
  const ratioScore =
    ratio <= 0 ? 20
      : ratio < 0.05 ? 25
        : ratio < 0.1 ? 60
          : ratio <= 0.9 ? 100
            : 70; // more liq than MC — odd but not dangerous

  const lockScore = i.lpLocked === true ? 100 : i.lpLocked === false ? 40 : 60;
  const tax = Math.max(i.buyTaxPct ?? 0, i.sellTaxPct ?? 0);
  const taxScore = clamp(100 - tax * 10);

  if (i.liqUsd >= 15_000) notes.push(`liq $${Math.round(i.liqUsd / 1000)}K`);

  return clamp(depth * 0.40 + ratioScore * 0.30 + lockScore * 0.15 + taxScore * 0.15);
}

/**
 * Entry window: low-cap band + IGNITION-AWARE age.
 *
 * The window is about when the MOVE started, not when the pair was born.
 * A token created 6h ago that ignites at hour 8 is a fresh entry — sleepers
 * and revivals are some of the best asymmetric plays. So age only matters
 * when the tape is quiet; live ignition (MC velocity from snapshots)
 * overrides calendar age entirely.
 */
function scoreTiming(i: GemInputs): number {
  const age = i.pairAgeMin;
  const ageScore =
    age == null ? 40
      : age <= 45 ? 100
        : age <= 120 ? 80
          : age <= 360 ? 60
            : age <= 1440 ? 40
              : 25;

  // Ignition: %/min MC velocity over the last ~10 min of tape
  let velocity = 0;
  const pts = i.tape.filter((p) => p.mcUsd != null && p.mcUsd > 0);
  if (pts.length >= 3) {
    const last = pts[pts.length - 1];
    const windowStart = last.atMs - 12 * 60_000;
    const win = pts.filter((p) => p.atMs >= windowStart);
    if (win.length >= 3 && win[0].mcUsd! > 0) {
      const mins = Math.max(1, (last.atMs - win[0].atMs) / 60_000);
      velocity = ((last.mcUsd! - win[0].mcUsd!) / win[0].mcUsd!) * 100 / mins;
    }
  }
  const ignitionScore =
    velocity >= 2 ? 100
      : velocity >= 0.8 ? 80
        : velocity >= 0.3 ? 60
          : 0;

  // Live ignition IS the entry window — age can only help, never punish it
  const entryScore = Math.max(ageScore, ignitionScore);

  const mc = i.mcUsd;
  const mcScore =
    mc <= 0 ? 30
      : mc < 5_000 ? 55        // pre-graduation dust — high mortality
        : mc <= 60_000 ? 100   // the low-cap gem band
          : mc <= 150_000 ? 70
            : mc <= 500_000 ? 40
              : 15;

  return clamp(entryScore * 0.5 + mcScore * 0.5);
}

// ── Confidence ──────────────────────────────────────────────────────────────

/**
 * Evidence completeness, 0-1. A GEM verdict needs ≥ 0.7:
 *   tape depth 0.35 · fresh holders 0.25 · security fetched 0.25 · market 0.15
 */
function computeConfidence(i: GemInputs): number {
  const tapeC = Math.min(1, i.tape.length / GEM_MIN_SNAPSHOTS) * 0.35;
  const holdersC = (i.holdersFresh && i.holderCount != null && i.holderCount > 0) ? 0.25 : 0;
  const secC = i.securityFetched ? 0.25 : 0;
  const marketC = (i.mcUsd > 0 && i.liqUsd > 0) ? 0.15 : i.mcUsd > 0 ? 0.08 : 0;
  return Math.round((tapeC + holdersC + secC + marketC) * 100) / 100;
}

// ── Final ───────────────────────────────────────────────────────────────────

export function computeGemScore(i: GemInputs): GemResult {
  const notes: string[] = [];
  const vetoes = collectVetoes(i);

  const components: GemComponents = {
    flow: Math.round(scoreFlow(i, notes)),
    holders: Math.round(scoreHolders(i, notes)),
    smart: Math.round(scoreSmart(i, notes)),
    structure: Math.round(scoreStructure(i, notes)),
    timing: Math.round(scoreTiming(i)),
  };

  const raw =
    components.flow * WEIGHTS.flow
    + components.holders * WEIGHTS.holders
    + components.smart * WEIGHTS.smart
    + components.structure * WEIGHTS.structure
    + components.timing * WEIGHTS.timing;
  const score = Math.round(clamp(raw));

  const confidence = computeConfidence(i);

  // Persistence: GEM-qualifying now?
  const qualifiesNow =
    vetoes.length === 0
    && score >= GEM_SCORE_MIN
    && confidence >= GEM_CONFIDENCE_MIN
    && i.tape.length >= GEM_MIN_SNAPSHOTS
    && i.trackedWalletBuys >= 1;
  const gemStreak = qualifiesNow ? i.prevGemStreak + 1 : 0;

  let verdict: GemVerdict;
  if (vetoes.length > 0) {
    verdict = "AVOID";
  } else if (qualifiesNow && gemStreak >= GEM_STREAK_REQUIRED) {
    verdict = "GEM";
  } else if (score >= WATCH_SCORE_MIN || (qualifiesNow && gemStreak < GEM_STREAK_REQUIRED)) {
    verdict = "WATCH";
  } else {
    verdict = "NEUTRAL";
  }

  return {
    score,
    verdict,
    confidence,
    components,
    vetoes,
    gemStreak,
    snapshotsUsed: i.tape.length,
    notes,
  };
}
