/**
 * Structured feedback payloads stored on dex_positions at entry / exit.
 * Pure builders — reverse-engineering fuel for pattern memory.
 */

export type DexMarketSnap = {
  at: string;
  tokenId: number;
  proCallId: number | null;
  address: string;
  symbol: string | null;
  calledMcUsd: number | null;
  liveMcUsd: number | null;
  velocity: number;
  gainPct: number;
  athMultiple: number;
  ageMinutes: number;
  snapCount: number;
  phase: string;
  score: number;
  alertEligible: boolean;
  reasons: string[];
  blockers: string[];
  sizeLabel: string;
  calledIntel: number | null;
  calledSmart: number;
  calledKol: number;
  liveSmart: number;
  liveKol: number;
  liveHv: number | null;
  volumeIntensity: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  mintOk: boolean;
  freezeOk: boolean | null;
  honeypot: boolean;
  taggedOk: boolean;
  freshnessOk: boolean;
  observationReady: boolean;
};

export function buildEntryFeedback(opts: {
  market: DexMarketSnap;
  stakeUsd: number;
  patternKey: string;
  patternEdge: { allow: boolean; boost: number; note: string };
  patternStats: {
    samples: number;
    wins3x: number;
    losses: number;
    sumExitMultiple: number;
  } | null;
  entryGate: string;
  cfg: Record<string, number>;
}): Record<string, unknown> {
  const winRate = opts.patternStats && opts.patternStats.samples > 0
    ? opts.patternStats.wins3x / opts.patternStats.samples
    : null;
  return {
    kind: "entry",
    gate: opts.entryGate,
    stakeUsd: opts.stakeUsd,
    patternKey: opts.patternKey,
    patternEdge: opts.patternEdge,
    patternStats: opts.patternStats
      ? {
          samples: opts.patternStats.samples,
          wins3x: opts.patternStats.wins3x,
          losses: opts.patternStats.losses,
          winRate,
          avgExit: opts.patternStats.samples > 0
            ? opts.patternStats.sumExitMultiple / opts.patternStats.samples
            : null,
        }
      : null,
    why: opts.market.reasons,
    blockers: opts.market.blockers,
    market: opts.market,
    rules: {
      takeProfitMult: opts.cfg.takeProfitMult,
      moonKeepFrac: opts.cfg.moonKeepFrac,
      hardStopMult: opts.cfg.hardStopMult,
      trailDrawdown: opts.cfg.trailDrawdown,
      minObservationSnaps: 5,
    },
  };
}

export function buildExitFeedback(opts: {
  market: DexMarketSnap;
  reason: string;
  reasonDetail: string;
  multiple: number;
  peakMultiple: number;
  learnMult: number;
  stakeClosedUsd: number;
  proceedsUsd: number;
  pnlUsd: number;
  holdMinutes: number;
  moonBagTaken: boolean;
  trailFloor: number | null;
  hit3x: boolean;
  event: "take_profit" | "exit" | "stop";
}): Record<string, unknown> {
  return {
    kind: opts.event,
    reason: opts.reason,
    reasonDetail: opts.reasonDetail,
    multiple: opts.multiple,
    peakMultiple: opts.peakMultiple,
    learnMult: opts.learnMult,
    stakeClosedUsd: opts.stakeClosedUsd,
    proceedsUsd: opts.proceedsUsd,
    pnlUsd: opts.pnlUsd,
    holdMinutes: Math.round(opts.holdMinutes * 10) / 10,
    moonBagTaken: opts.moonBagTaken,
    trailFloor: opts.trailFloor,
    hit3x: opts.hit3x,
    whyStill: opts.market.reasons,
    blockers: opts.market.blockers,
    market: opts.market,
  };
}
