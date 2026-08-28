/** Background heat — independent of a pass lock. Desk only shows names at/above the floor. */

export const HOT_FLOOR = 40;

export type HotInput = {
  mcUsd: number;
  liqUsd: number;
  vol1h: number;
  vol5m: number;
  buys1h: number;
  sells1h: number;
  chg1h: number;
  chg6h: number;
  tapeLead: string | null;
  socials: number;
  sentiment?: "hot" | "mixed" | "quiet" | null;
  boosted?: boolean;
  walletBuys: number;
  quality: number | null;
  survival: number | null;
  ageHours: number;
  geckoUpPct?: number | null;
  replies?: number | null;
  chase?: boolean;
  dead?: boolean;
};

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

/** 0–100. Rugs, chases, and seller-led tape stay below the desk floor. */
export function hotness(i: HotInput): number {
  if (i.dead) return 0;
  if (!(i.mcUsd > 0) || i.mcUsd < 8_000) return 0;
  if (i.chase) return 18;

  let n = 28;
  if (i.liqUsd >= 15_000) n += 8;
  else if (i.liqUsd >= 6_000) n += 3;
  else n -= 10;

  if (i.vol1h >= 40_000) n += 10;
  else if (i.vol1h >= 8_000) n += 6;
  else if (i.vol1h < 2_000) n -= 8;

  if (i.vol5m >= 4_000) n += 4;

  const buys = i.buys1h;
  const sells = i.sells1h;
  if (buys + sells >= 8) {
    if (buys > sells * 1.15) n += 12;
    else if (sells > buys * 1.15) n -= 14;
    else n += 3;
  }

  if (i.tapeLead === "buyers") n += 10;
  else if (i.tapeLead === "sellers") n -= 16;
  else if (i.tapeLead === "two_sided") n += 2;

  if (i.chg1h > 8 && i.chg1h < 80) n += 6;
  if (i.chg1h < -20) n -= 10;
  if (i.chg6h > 250) n -= 20;

  if (i.socials >= 2) n += 6;
  else if (i.socials === 1) n += 2;
  if (i.sentiment === "hot") n += 5;
  else if (i.sentiment === "quiet") n -= 2;
  if (i.boosted) n += 2;
  if ((i.replies ?? 0) >= 80) n += 3;
  if ((i.geckoUpPct ?? 0) >= 70) n += 4;

  if (i.walletBuys >= 1) n += 8;
  if ((i.quality ?? 0) >= 80) n += 6;
  else if ((i.quality ?? 0) < 40) n -= 6;
  if ((i.survival ?? 0) >= 70) n += 4;

  if (i.ageHours > 0 && i.ageHours < 0.4) n -= 6;

  n = clamp(n);
  if (i.tapeLead === "sellers") n = Math.min(n, HOT_FLOOR - 8);
  return Math.round(n);
}

export function isHotEnough(score: number | null | undefined): boolean {
  return (score ?? 0) >= HOT_FLOOR;
}
