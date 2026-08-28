/**
 * Exit rules — ported from omo PROCESS.md / exit-rules.test.ts.
 *
 * Paper book uses market-cap multiples as the stand-in for unrealised P&L
 * (we do not hold a trading key). Same thresholds omo publishes:
 *
 *   exit_stop_loss           unrealised ≤ -35%
 *   exit_trailing_stop       printed +60% then gave back 40 points from that high
 *   exit_liquidity_break     pool below $8,000
 *   exit_thesis_invalidated  6h ≤ -25% AND sells leading buys 1.4×
 *   exit_take_profit         +100% / +300% / +900% trim 33 / 33 / 50
 *   exit_stale_thesis        held 14 days, inside ±10%, 6h volume under $5,000
 *
 * Risk-off beats profit taking: a stop, trail, liquidity break, invalidation
 * or stale timer closes the position fully instead of trimming.
 */

export const EXIT_LIMITS = {
  stopLossPct: -35,
  trailArmPct: 60,
  trailGivebackPts: 40,
  liqBreakUsd: 8_000,
  invalidateChg6h: -25,
  invalidateSellRatio: 1.4,
  takeProfit: [
    { pct: 100, fraction: 0.33, tranche: 0 },
    { pct: 300, fraction: 0.33, tranche: 1 },
    { pct: 900, fraction: 0.50, tranche: 2 },
  ] as const,
  staleDays: 14,
  staleBandPct: 10,
  staleVolUsd: 5_000,
};

export type ExitInputs = {
  symbol: string;
  mint: string;
  unrealizedPct: number;
  peakPct: number;
  trimsTaken: number;
  holdDays: number;
  positionUsd: number;
  liquidityUsd: number;
  volumeUsd: number;
  buys: number;
  sells: number;
  chg6h: number;
};

export type ExitDecision = {
  fraction: number;
  fired: string[];
  reason: string;
  tranche: number | null;
};

export type ExitAction = "hold" | "trim" | "exit";

export type ExitInput = {
  entryMc: number;
  lastMc: number | null;
  peakMc: number | null;
  phase: string;
  tapeLead: string | null;
  dead: boolean;
  liqUsd: number | null;
  liqSlope: number | null;
  holderSlope: number | null;
  chg6h?: number | null;
  vol6h?: number | null;
  buys?: number | null;
  sells?: number | null;
  holdDays?: number;
  trimsTaken?: number;
};

export type ExitPlan = {
  action: ExitAction;
  takePct: number;
  title: string;
  body: string;
  gainX: number | null;
  athX: number | null;
  retrace: number | null;
  fired: string[];
};

export function multiple(cur: number | null, entry: number): number | null {
  if (cur == null || !Number.isFinite(cur) || entry <= 0) return null;
  return cur / entry;
}

export function retraceFromPeak(last: number | null, peak: number | null): number | null {
  if (last == null || peak == null || peak <= 0) return null;
  return (peak - last) / peak;
}

export function evaluateExitRules(i: ExitInputs): ExitDecision {
  const fired: string[] = [];
  const giveback = i.peakPct - i.unrealizedPct;

  if (i.unrealizedPct <= EXIT_LIMITS.stopLossPct) fired.push("exit_stop_loss");
  if (i.peakPct >= EXIT_LIMITS.trailArmPct && giveback >= EXIT_LIMITS.trailGivebackPts) {
    fired.push("exit_trailing_stop");
  }
  if (i.liquidityUsd < EXIT_LIMITS.liqBreakUsd) fired.push("exit_liquidity_break");
  if (
    i.chg6h <= EXIT_LIMITS.invalidateChg6h
    && i.sells > i.buys * EXIT_LIMITS.invalidateSellRatio
  ) {
    fired.push("exit_thesis_invalidated");
  }
  if (
    i.holdDays >= EXIT_LIMITS.staleDays
    && Math.abs(i.unrealizedPct) <= EXIT_LIMITS.staleBandPct
    && i.volumeUsd < EXIT_LIMITS.staleVolUsd
  ) {
    fired.push("exit_stale_thesis");
  }

  const riskOff = fired.find((id) =>
    id === "exit_stop_loss"
    || id === "exit_trailing_stop"
    || id === "exit_liquidity_break"
    || id === "exit_thesis_invalidated"
    || id === "exit_stale_thesis",
  );
  if (riskOff) {
    return { fraction: 1, fired, reason: riskOff, tranche: null };
  }

  const tp = EXIT_LIMITS.takeProfit.find((t) => i.unrealizedPct >= t.pct && i.trimsTaken <= t.tranche);
  if (tp && i.trimsTaken === tp.tranche) {
    fired.push("exit_take_profit");
    return {
      fraction: tp.fraction,
      fired,
      reason: `exit_take_profit_${tp.pct}`,
      tranche: tp.tranche,
    };
  }

  return { fraction: 0, fired, reason: "hold", tranche: null };
}

const TITLES: Record<string, { title: string; body: string }> = {
  exit_stop_loss: {
    title: "Cut — hard stop",
    body: "Unrealised at or below -35% of cost. Flatten. The lock was wrong.",
  },
  exit_trailing_stop: {
    title: "Trail hit — flatten",
    body: "Printed +60% or better and gave back 40 points from that high.",
  },
  exit_liquidity_break: {
    title: "Out — liquidity break",
    body: "Pool below $8,000, so the size can no longer leave cleanly.",
  },
  exit_thesis_invalidated: {
    title: "Thesis invalid — sellers own the 6h",
    body: "6h change at or below -25% and sells leading buys 1.4×.",
  },
  exit_stale_thesis: {
    title: "Stale thesis — close",
    body: "Held 14 days, still inside ±10%, 6h volume under $5,000.",
  },
  exit_take_profit: {
    title: "Take profit",
    body: "Paid. Trim the tranche and leave a runner.",
  },
};

export function planExit(r: ExitInput): ExitPlan {
  const gainX = multiple(r.lastMc, r.entryMc);
  const athX = multiple(r.peakMc ?? r.lastMc, r.entryMc);
  const retrace = retraceFromPeak(r.lastMc, r.peakMc ?? r.lastMc);
  const unrealizedPct = gainX != null ? (gainX - 1) * 100 : 0;
  const peakPct = athX != null ? (athX - 1) * 100 : unrealizedPct;
  const base = { gainX, athX, retrace };

  if (r.dead || r.phase === "deceased") {
    return {
      ...base, action: "exit", takePct: 100, fired: ["dead"],
      title: "Flatten — book is dead",
      body: "LP gone or the name died after lock. Do not wait for a bounce on empty books.",
    };
  }

  const decision = evaluateExitRules({
    symbol: "",
    mint: "",
    unrealizedPct,
    peakPct,
    trimsTaken: r.trimsTaken ?? 0,
    holdDays: r.holdDays ?? 0,
    positionUsd: r.lastMc ?? r.entryMc,
    liquidityUsd: r.liqUsd ?? 0,
    volumeUsd: r.vol6h ?? 0,
    buys: r.buys ?? 0,
    sells: r.sells ?? 0,
    chg6h: r.chg6h ?? 0,
  });

  if (decision.fraction >= 1) {
    const copy = TITLES[decision.reason] ?? TITLES[decision.fired[0] ?? ""] ?? {
      title: "Flatten",
      body: decision.reason,
    };
    return { ...base, action: "exit", takePct: 100, fired: decision.fired, ...copy };
  }
  if (decision.fraction > 0) {
    return {
      ...base,
      action: "trim",
      takePct: Math.round(decision.fraction * 100),
      fired: decision.fired,
      title: `Trim ${Math.round(decision.fraction * 100)}% — paid`,
      body: `Take-profit tranche. Now ${(gainX ?? 1).toFixed(2)}× · ATH ${(athX ?? 1).toFixed(2)}×. Leave a runner.`,
    };
  }
  return {
    ...base,
    action: "hold",
    takePct: 0,
    fired: [],
    title: "Hold the lock",
    body: `Now ${(gainX ?? 1).toFixed(2)}× · ATH ${(athX ?? 1).toFixed(2)}×. Stay while liquidity holds; out if the main pool starts draining.`,
  };
}
