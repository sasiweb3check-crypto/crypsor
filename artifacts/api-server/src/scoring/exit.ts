/**
 * Exit planner for locked TRADE entries.
 * Entry MC is frozen. Everything else is a trail vs that print and ATH since lock.
 */
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
};

export type ExitPlan = {
  action: ExitAction;
  takePct: number;
  title: string;
  body: string;
  gainX: number | null;
  athX: number | null;
  retrace: number | null;
};

export function multiple(cur: number | null, entry: number): number | null {
  if (cur == null || !Number.isFinite(cur) || entry <= 0) return null;
  return cur / entry;
}

export function retraceFromPeak(last: number | null, peak: number | null): number | null {
  if (last == null || peak == null || peak <= 0) return null;
  return (peak - last) / peak;
}

export function planExit(r: ExitInput): ExitPlan {
  const gainX = multiple(r.lastMc, r.entryMc);
  const athX = multiple(r.peakMc ?? r.lastMc, r.entryMc);
  const retrace = retraceFromPeak(r.lastMc, r.peakMc ?? r.lastMc);
  const sellers = r.tapeLead === "sellers" || r.phase === "icu";
  const x = gainX ?? 1;
  const ath = athX ?? x;

  const base = { gainX, athX, retrace };

  if (r.dead || r.phase === "deceased" || (r.liqUsd != null && r.liqUsd < 400)) {
    return {
      ...base, action: "exit", takePct: 100,
      title: "Flatten — book is dead",
      body: "LP gone or the patient died after lock. Do not wait for a bounce on empty books.",
    };
  }
  if ((r.holderSlope ?? 0) < -0.12 && (r.liqSlope ?? 0) < -0.2) {
    return {
      ...base, action: "exit", takePct: 100,
      title: "Flatten — holders and LP leaving",
      body: "Snapshot shows holder exodus with liquidity drain. That is an exit, not a dip.",
    };
  }
  if (x <= 0.7 && sellers) {
    return {
      ...base, action: "exit", takePct: 100,
      title: "Cut — under entry with sellers",
      body: `Now ${x.toFixed(2)}× entry while sellers lead. Take the loss; the lock was wrong.`,
    };
  }
  if (r.phase === "icu" && x < 1.1) {
    return {
      ...base, action: "exit", takePct: 100,
      title: "Out — ICU before it paid",
      body: "Locked, never got paid, now in ICU. Flatten and let the next print set up.",
    };
  }
  if (ath >= 2 && (retrace ?? 0) >= 0.28) {
    return {
      ...base, action: "trim", takePct: 50,
      title: "Take half — gave back from ATH",
      body: `ATH ${ath.toFixed(2)}×, now ${x.toFixed(2)}× (${Math.round((retrace ?? 0) * 100)}% off highs). Bank half, trail the rest.`,
    };
  }
  if (ath >= 1.5 && (retrace ?? 0) >= 0.2 && sellers) {
    return {
      ...base, action: "trim", takePct: 40,
      title: "Trim — sellers after a run",
      body: `Paid ${ath.toFixed(2)}× ATH, tape flipped. Take 40%, leave a runner.`,
    };
  }
  if (x >= 1.25 && r.tapeLead === "two_sided") {
    return {
      ...base, action: "trim", takePct: 25,
      title: "Skim 25% — tape two-sided",
      body: `Up ${x.toFixed(2)}× but nobody is leading the hour. Skim, don't donate it back.`,
    };
  }
  if (x >= 2 && r.tapeLead === "buyers") {
    return {
      ...base, action: "hold", takePct: 0,
      title: "Let it run",
      body: `Now ${x.toFixed(2)}× · ATH ${ath.toFixed(2)}×. Buyers still lead — trail ~25% off ATH.`,
    };
  }
  if (x >= 1 && r.tapeLead === "buyers") {
    return {
      ...base, action: "hold", takePct: 0,
      title: "Hold the lock",
      body: `Now ${x.toFixed(2)}× · ATH ${ath.toFixed(2)}×. Stay with buyers; we only trim on giveback or a tape flip.`,
    };
  }
  return {
    ...base, action: "hold", takePct: 0,
    title: "Watch the lock",
    body: `Now ${x.toFixed(2)}× · ATH ${ath.toFixed(2)}× vs entry. No exit yet — next snapshot decides.`,
  };
}
