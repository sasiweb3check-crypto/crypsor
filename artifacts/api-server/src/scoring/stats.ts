/**
 * Pass-book stats — the only numbers the desk shows.
 *
 * A pass is a gate-cleared buy. Entry MC is frozen at that print.
 * Everything after is gain vs that print, and ATH vs that print.
 */
export function ratio(cur: number | null | undefined, base: number | null | undefined): number | null {
  if (cur == null || base == null || !Number.isFinite(cur) || !Number.isFinite(base) || base <= 0) {
    return null;
  }
  return cur / base;
}

export function pctFromRatio(x: number | null): number | null {
  if (x == null || !Number.isFinite(x)) return null;
  return (x - 1) * 100;
}

/** Gain since the pass print. 20k → 30k = +50. */
export function gainPct(lastMc: number | null | undefined, passMc: number | null | undefined): number | null {
  return pctFromRatio(ratio(lastMc, passMc));
}

/** ATH gain since the pass print. Peak is the high-water mark after pass. */
export function athPct(peakMc: number | null | undefined, passMc: number | null | undefined): number | null {
  return pctFromRatio(ratio(peakMc, passMc));
}

export type PassLane = "live" | "archived" | "dead";

export function laneOf(status: string, phase?: string | null): PassLane {
  if (status === "dead" || phase === "deceased") return "dead";
  if (status === "exit") return "archived";
  return "live";
}

export type DayRoll = {
  day: string;
  passed: number;
  live: number;
  archived: number;
  dead: number;
  avgGainPct: number | null;
  avgAthPct: number | null;
  hit2x: number;
  hit5x: number;
  hit10x: number;
  bestAthPct: number | null;
};

export function hitRate(hits: number, called: number): number | null {
  if (!(called > 0)) return null;
  return (hits / called) * 100;
}

/** ATH vs entry: 2× = +100%, 5× = +400%, 10× = +900%. */
export function hitsAt(athPct: number | null | undefined, x: 2 | 5 | 10): boolean {
  if (athPct == null || !Number.isFinite(athPct)) return false;
  if (x === 10) return athPct >= 900;
  if (x === 5) return athPct >= 400;
  return athPct >= 100;
}

export type PassRowIn = {
  status: string;
  phase?: string | null;
  gain_pct?: number | null;
  ath_pct?: number | null;
};

export function rollDays(
  rows: Array<{ day: string } & PassRowIn>,
): DayRoll[] {
  const map = new Map<string, {
    passed: number; live: number; archived: number; dead: number;
    gains: number[]; aths: number[]; hit2x: number; hit5x: number; hit10x: number;
    bestAth: number | null;
  }>();
  for (const r of rows) {
    const day = r.day.slice(0, 10);
    let b = map.get(day);
    if (!b) {
      b = {
        passed: 0, live: 0, archived: 0, dead: 0,
        gains: [], aths: [], hit2x: 0, hit5x: 0, hit10x: 0, bestAth: null,
      };
      map.set(day, b);
    }
    b.passed += 1;
    const lane = laneOf(r.status, r.phase);
    if (lane === "live") b.live += 1;
    else if (lane === "dead") b.dead += 1;
    else b.archived += 1;
    if (r.gain_pct != null && Number.isFinite(r.gain_pct)) b.gains.push(r.gain_pct);
    if (r.ath_pct != null && Number.isFinite(r.ath_pct)) {
      b.aths.push(r.ath_pct);
      b.bestAth = b.bestAth == null ? r.ath_pct : Math.max(b.bestAth, r.ath_pct);
      if (hitsAt(r.ath_pct, 2)) b.hit2x += 1;
      if (hitsAt(r.ath_pct, 5)) b.hit5x += 1;
      if (hitsAt(r.ath_pct, 10)) b.hit10x += 1;
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, b]) => ({
      day,
      passed: b.passed,
      live: b.live,
      archived: b.archived,
      dead: b.dead,
      avgGainPct: b.gains.length ? b.gains.reduce((s, n) => s + n, 0) / b.gains.length : null,
      avgAthPct: b.aths.length ? b.aths.reduce((s, n) => s + n, 0) / b.aths.length : null,
      hit2x: b.hit2x,
      hit5x: b.hit5x,
      hit10x: b.hit10x,
      bestAthPct: b.bestAth,
    }));
}
