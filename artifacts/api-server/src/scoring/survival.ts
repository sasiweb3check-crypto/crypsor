/**
 * Survival + momentum from continued snapshots — judgment after a pass.
 * Not an exit bot. A high score means the tape is still standing.
 */
export type Momentum = "up" | "flat" | "down" | "unread";

export type SnapPoint = {
  kind?: string | null;
  mc_usd?: number | null;
  mc_slope?: number | null;
  liq_slope?: number | null;
  holder_slope?: number | null;
  incomplete?: boolean | null;
  score?: number | null;
};

export type SurvivalJudgement = {
  survival: number;
  momentum: Momentum;
  livePrints: number;
  dumps: number;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function judgeSeries(points: SnapPoint[]): SurvivalJudgement {
  const rows = points.slice(-12);
  if (!rows.length) return { survival: 50, momentum: "unread", livePrints: 0, dumps: 0 };

  let score = 58;
  let livePrints = 0;
  let dumps = 0;
  const slopes: number[] = [];

  for (const p of rows) {
    if (p.incomplete) {
      score -= 5;
      continue;
    }
    livePrints += 1;
    score += 3;
    const mc = p.mc_slope;
    if (mc != null && Number.isFinite(mc)) {
      slopes.push(mc);
      if (mc > 0.08) score += 6;
      else if (mc > 0.02) score += 3;
      else if (mc < -0.2) { score -= 14; dumps += 1; }
      else if (mc < -0.08) { score -= 7; dumps += 1; }
    }
    if ((p.liq_slope ?? 0) < -0.25) score -= 10;
    if ((p.holder_slope ?? 0) < -0.08) score -= 10;
  }

  const hour = rows.filter((p) => p.kind === "hour");
  if (hour.length) {
    const lastHour = hour[hour.length - 1];
    if ((lastHour.mc_slope ?? 0) > 0.05) score += 4;
    if ((lastHour.mc_slope ?? 0) < -0.15) score -= 8;
  }

  const tail = slopes.slice(-3);
  const avg = tail.length ? tail.reduce((s, n) => s + n, 0) / tail.length : null;
  let momentum: Momentum = "unread";
  if (avg == null) momentum = livePrints ? "flat" : "unread";
  else if (avg > 0.04) momentum = "up";
  else if (avg < -0.05) momentum = "down";
  else momentum = "flat";

  return {
    survival: Math.round(clamp(score, 0, 100)),
    momentum,
    livePrints,
    dumps,
  };
}

export function momentumLabel(m: Momentum): string {
  if (m === "up") return "Building";
  if (m === "down") return "Fading";
  if (m === "flat") return "Holding";
  return "Unread";
}
