/**
 * Survival score — post-call health of a GEM (0-100 + label).
 *
 * Question it answers: "the GEM call fired — is this token still alive?"
 *
 * Low-cap memecoin reality (per launch-outcome datasets and trench practice):
 * 40-70% retraces from a local peak are NORMAL and often precede second legs,
 * so raw drawdown is scored SOFTLY and can never kill the score by itself.
 * What actually kills low-caps is scored HARD:
 *   - liquidity pulled / draining (LP exit = death, no recovery)
 *   - holders exiting (distribution unwinding)
 *   - sustained sell-dominated flow with no bid
 *
 * Pillars:
 *   price   0.30  gain since call (floor support) + soft retrace-from-peak
 *   flow    0.30  recent buy ratio + MC direction from the tape
 *   liq     0.25  liquidity retention vs its own high + absolute depth
 *   holders 0.15  holder trend since the call
 *
 * Labels: RUNNING ≥ 70 · HOLDING ≥ 50 · COOLING ≥ 32 · FADING < 32
 */

export type SurvivalLabel = "RUNNING" | "HOLDING" | "COOLING" | "FADING";

export type SurvivalTapePoint = {
  atMs: number;
  mcUsd: number | null;
  liqUsd: number | null;
  buys5m: number | null;
  sells5m: number | null;
  holderCount: number | null;
};

export type SurvivalInputs = {
  callMcUsd: number;            // MC when GEM call fired
  currentMcUsd: number;
  peakMcUsd: number;            // peak since call
  /** tape since (or around) the call, oldest → newest */
  tape: SurvivalTapePoint[];
  minutesSinceCall: number;
};

export type SurvivalResult = {
  score: number;                // 0-100
  label: SurvivalLabel;
  components: { price: number; flow: number; liq: number; holders: number };
  /** e.g. "-42% off peak", "liq intact", "buyers 68%" */
  signals: string[];
};

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

function pricePillar(i: SurvivalInputs, signals: string[]): number {
  const gainX = i.callMcUsd > 0 ? i.currentMcUsd / i.callMcUsd : 1;
  const retrace = i.peakMcUsd > 0 ? 1 - i.currentMcUsd / i.peakMcUsd : 0;

  // Gain support: below 0.6× call = structural failure; above call = strength
  const gainScore =
    gainX >= 2 ? 100
      : gainX >= 1.3 ? 85
        : gainX >= 1 ? 70
          : gainX >= 0.8 ? 50
            : gainX >= 0.6 ? 30
              : 10;

  // Soft retrace: normal low-cap breathing until ~60%; harsh only past 75%
  const retraceScore =
    retrace <= 0.3 ? 100
      : retrace <= 0.5 ? 80
        : retrace <= 0.6 ? 60
          : retrace <= 0.75 ? 40
            : 15;

  if (retrace > 0.05) signals.push(`-${Math.round(retrace * 100)}% off peak`);
  if (gainX >= 1.5) signals.push(`${gainX.toFixed(1)}× from call`);

  // Still well above call MC? Retrace can't drag price pillar under 45.
  const combined = gainScore * 0.55 + retraceScore * 0.45;
  return clamp(gainX >= 1.5 ? Math.max(combined, 45) : combined);
}

function flowPillar(i: SurvivalInputs, signals: string[]): number {
  const recent = i.tape.slice(-8); // ~last 6-8 minutes of tape
  if (recent.length < 2) return 50; // not enough evidence — neutral

  let buys = 0;
  let sells = 0;
  for (const p of recent) {
    buys += p.buys5m ?? 0;
    sells += p.sells5m ?? 0;
  }
  const ratio = buys + sells >= 6 ? buys / (buys + sells) : null;
  const ratioScore = ratio == null ? 50 : clamp(((ratio - 0.3) / 0.4) * 100);

  const mcs = recent.filter((p) => p.mcUsd != null && p.mcUsd > 0);
  let dirScore = 50;
  if (mcs.length >= 2) {
    const first = mcs[0].mcUsd!;
    const last = mcs[mcs.length - 1].mcUsd!;
    const chg = (last - first) / first;
    dirScore = chg >= 0.05 ? 90 : chg >= 0 ? 65 : chg >= -0.08 ? 45 : 20;
  }

  if (ratio != null && ratio >= 0.6) signals.push(`buyers ${Math.round(ratio * 100)}%`);
  if (ratio != null && ratio <= 0.38) signals.push(`sellers ${Math.round((1 - ratio) * 100)}%`);

  return clamp(ratioScore * 0.55 + dirScore * 0.45);
}

function liqPillar(i: SurvivalInputs, signals: string[]): number {
  const liqs = i.tape.filter((p) => p.liqUsd != null && p.liqUsd > 0);
  if (!liqs.length) return 55;

  const nowLiq = liqs[liqs.length - 1].liqUsd!;
  const maxLiq = Math.max(...liqs.map((p) => p.liqUsd!));
  const retention = maxLiq > 0 ? nowLiq / maxLiq : 1;

  // LP pull detection — the one true death signal
  if (retention < 0.4) {
    signals.push(`liquidity down ${Math.round((1 - retention) * 100)}% — exit risk`);
    return clamp(retention * 25); // ≤10
  }

  const retentionScore = retention >= 0.85 ? 100 : retention >= 0.6 ? 70 : 40;
  const depthScore = nowLiq >= 25_000 ? 100 : nowLiq >= 10_000 ? 80 : nowLiq >= 5_000 ? 55 : 30;

  if (retention >= 0.85 && nowLiq >= 8_000) signals.push("liq intact");

  return clamp(retentionScore * 0.6 + depthScore * 0.4);
}

function holdersPillar(i: SurvivalInputs, signals: string[]): number {
  const pts = i.tape.filter((p) => p.holderCount != null && p.holderCount > 0);
  if (pts.length < 2) return 50;
  const first = pts[0].holderCount!;
  const last = pts[pts.length - 1].holderCount!;
  const chg = first > 0 ? (last - first) / first : 0;
  if (chg >= 0.1) signals.push(`holders +${Math.round(chg * 100)}%`);
  if (chg <= -0.08) signals.push(`holders leaving (${Math.round(chg * 100)}%)`);
  return chg >= 0.15 ? 100 : chg >= 0.03 ? 80 : chg >= -0.03 ? 60 : chg >= -0.1 ? 35 : 15;
}

export function computeSurvival(i: SurvivalInputs): SurvivalResult {
  const signals: string[] = [];
  const components = {
    price: Math.round(pricePillar(i, signals)),
    flow: Math.round(flowPillar(i, signals)),
    liq: Math.round(liqPillar(i, signals)),
    holders: Math.round(holdersPillar(i, signals)),
  };

  let score = Math.round(clamp(
    components.price * 0.30
    + components.flow * 0.30
    + components.liq * 0.25
    + components.holders * 0.15,
  ));

  // Liquidity pull overrides everything — a great chart on a pulled pool is a trap
  if (components.liq <= 10) score = Math.min(score, 15);

  const label: SurvivalLabel =
    score >= 70 ? "RUNNING"
      : score >= 50 ? "HOLDING"
        : score >= 32 ? "COOLING"
          : "FADING";

  return { score, label, components, signals };
}
