/**
 * Pattern fingerprints for Dex Autopilot — reverse-engineered from on-chain tape.
 * Pure functions, no emotion. Used at entry (score) and exit (learn).
 */

export type PatternFeatures = {
  sizeLabel: string;
  intel: number;
  taggedOk: boolean;
  mintOk: boolean;
  velocity: number;
  snapCount: number;
  phase: string;
  smart: number;
  kol: number;
};

function intelBucket(intel: number): string {
  if (intel >= 90) return "i90+";
  if (intel >= 80) return "i80";
  if (intel >= 70) return "i70";
  return "i<70";
}

function velBucket(vel: number): string {
  if (vel >= 1.8) return "v1.8+";
  if (vel >= 1.45) return "v1.45";
  if (vel >= 1.22) return "v1.22";
  if (vel >= 1.1) return "v1.1";
  return "vflat";
}

export function patternKey(f: PatternFeatures): string {
  return [
    f.sizeLabel || "unk",
    intelBucket(f.intel),
    f.taggedOk ? "tag1" : "tag0",
    f.mintOk ? "mint1" : "mint0",
    velBucket(f.velocity),
    f.snapCount >= 5 ? "snap5+" : `snap${Math.min(4, f.snapCount)}`,
    f.phase || "radar",
  ].join("|");
}

/** Bias stake / entry from historical win-rate on this fingerprint. */
export function patternEdge(stats: {
  samples: number;
  wins3x: number;
  losses: number;
  sumExitMultiple: number;
} | null): { allow: boolean; boost: number; note: string } {
  if (!stats || stats.samples < 3) {
    return { allow: true, boost: 0, note: "cold pattern — observe & trade small" };
  }
  const winRate = stats.wins3x / stats.samples;
  const avgExit = stats.sumExitMultiple / stats.samples;
  if (winRate < 0.2 && stats.samples >= 6) {
    return { allow: false, boost: -1, note: `dead pattern · ${(winRate * 100).toFixed(0)}% 3× · n=${stats.samples}` };
  }
  if (winRate >= 0.45 && avgExit >= 2.2) {
    return { allow: true, boost: 0.25, note: `hot pattern · ${(winRate * 100).toFixed(0)}% 3× · avg ${avgExit.toFixed(1)}×` };
  }
  if (winRate >= 0.3) {
    return { allow: true, boost: 0.1, note: `ok pattern · ${(winRate * 100).toFixed(0)}% 3×` };
  }
  return { allow: true, boost: -0.1, note: `weak pattern · ${(winRate * 100).toFixed(0)}% 3×` };
}
