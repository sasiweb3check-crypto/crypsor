/**
 * THE MOAT — every threshold in the funnel lives here.
 *
 * "speed is a commodity. filtering is the moat."
 *
 * Stage gates (each stage cuts the universe further):
 *   baseline  — cheap cuts on discovery data (age / MC band / junk)
 *   tracking  — survivors watched across scans: holder growth, liquidity
 *               stability, buy/sell pressure, bundler/bot HOLD share
 *   deepdive  — one-shot: creator rug history, honeypot, concentration,
 *               KOL/smart presence
 *
 * Principles learned from v1 production outcome audits:
 *   - judge bots by HOLD SHARE of supply, never participant counts
 *     (bundling is endemic: blocked +136% / +94% runners in v1)
 *   - drawdown ≠ death; LP pull and holder exodus are death
 *   - a token that ignites hours after launch is a fresh entry (ignition
 *     over age)
 *   - no verdict without evidence (missing data = not a pass)
 */

export const T = {
  // ── baseline (discovery) ──
  MC_MIN: 6_000,            // below: pre-graduation dust, ~90% mortality
  MC_MAX: 400_000,          // above: not a low-cap gem anymore
  AGE_MAX_H: 36,            // discovery only looks at young tokens
  // wallet_buy source bypasses MC/age (trusted human signal, always tracked)

  // ── tracking (per scan) ──
  HOLDERS_MIN: 25,
  HOLDER_DROP_FAIL: -0.06,  // >6% holder loss between scans = fail
  TOP10_MAX: 48,            // % of supply (pools excluded)
  BUY_RATIO_MIN: 0.48,      // 5m buys/(buys+sells), needs >=10 txns to judge
  LIQ_MIN_GRADUATED: 4_000, // USD; bonding tokens judged by MC instead
  BUNDLER_HOLD_MAX: 45,     // % supply — graded pressure, veto only extreme
  SNIPER_HOLD_MAX: 35,
  BOT_HOLD_MAX: 50,
  WASH_VL: 18,              // vol5m*12/liq above this with flat holders = wash

  // promotion / demotion
  PROMOTE_PASSES: 3,        // passes needed (within last PROMOTE_WINDOW scans)
  PROMOTE_WINDOW: 4,
  KILL_FAIL_STREAK: 6,
  KILL_AGE_H: 48,
  KILL_MC_FLOOR: 2_500,

  // ── deep dive ──
  RUG_RATIO_MAX: 0.4,       // creator's historical rug share
  DD_TOP10_MAX: 45,
  // SAFE tier (the tight scam filter — fewer, higher-conviction signals)
  SAFE_TOP10_MAX: 32,
  SAFE_BUNDLER_MAX: 25,
  SAFE_RUG_MAX: 0.15,
  SAFE_NEEDS_SMART_OR_KOL: true,

  // ── journal ──
  JOURNAL_HOURS: 24,
  JOURNAL_INTERVAL_MS: 30_000,
  WIN_MULTIPLE: 2,          // peak >= 2x alert MC counts as a win
} as const;

export type ScanReading = {
  mcUsd: number | null;
  liqUsd: number | null;
  holders: number | null;
  prevHolders: number | null;
  top10Pct: number | null;
  buys5m: number | null;
  sells5m: number | null;
  vol5m: number | null;
  bundlerHoldPct: number | null;
  sniperHoldPct: number | null;
  botHoldPct: number | null;
  graduated: boolean;
  source: string;
};

/** Tracking gate: returns fail reasons (empty = pass). */
export function trackingFailures(r: ScanReading): string[] {
  const fails: string[] = [];

  if (r.mcUsd == null || r.mcUsd <= 0) fails.push("no_market_data");

  if (r.holders != null) {
    if (r.holders < T.HOLDERS_MIN) fails.push("holders_low");
    if (r.prevHolders != null && r.prevHolders > 0) {
      const chg = (r.holders - r.prevHolders) / r.prevHolders;
      if (chg < T.HOLDER_DROP_FAIL) fails.push("holders_exiting");
    }
  }

  if (r.top10Pct != null && r.top10Pct > T.TOP10_MAX) fails.push("top10_concentrated");

  const txns = (r.buys5m ?? 0) + (r.sells5m ?? 0);
  if (txns >= 10) {
    const ratio = (r.buys5m ?? 0) / txns;
    if (ratio < T.BUY_RATIO_MIN) fails.push("sell_pressure");
  }

  if (r.graduated) {
    if (r.liqUsd != null && r.liqUsd < T.LIQ_MIN_GRADUATED) fails.push("liq_thin");
  } else if (r.mcUsd != null && r.mcUsd < T.MC_MIN) {
    fails.push("mc_below_band");
  }

  if ((r.bundlerHoldPct ?? 0) > T.BUNDLER_HOLD_MAX) fails.push("bundlers_own_float");
  if ((r.sniperHoldPct ?? 0) > T.SNIPER_HOLD_MAX) fails.push("snipers_own_float");
  if ((r.botHoldPct ?? 0) > T.BOT_HOLD_MAX) fails.push("bots_own_float");

  // Wash guard: hot volume with zero holder growth = recycled flow
  if (
    r.liqUsd != null && r.liqUsd > 0 && r.vol5m != null
    && (r.vol5m * 12) / r.liqUsd > T.WASH_VL
    && r.holders != null && r.prevHolders != null
    && r.holders <= r.prevHolders
  ) {
    fails.push("wash_volume");
  }

  return fails;
}

export type DeepDiveInputs = {
  rugRatio: number | null;
  honeypot: boolean | null;
  top10Pct: number | null;
  bundlerHoldPct: number | null;
  smartCount: number | null;
  kolCount: number | null;
  walletBuys: number;
  securityFetched: boolean;
};

export type DeepDiveResult = {
  pass: boolean;
  safe: boolean;          // tight tier
  reasons: string[];      // fail reasons or pass evidence
};

export function deepDive(d: DeepDiveInputs): DeepDiveResult {
  const fails: string[] = [];
  if (d.honeypot === true) fails.push("honeypot");
  if (d.rugRatio != null && d.rugRatio > T.RUG_RATIO_MAX) fails.push("creator_rug_history");
  if (d.top10Pct != null && d.top10Pct > T.DD_TOP10_MAX) fails.push("top10_concentrated");
  // Conviction floor: some independent signal must exist
  const conviction = (d.smartCount ?? 0) + (d.kolCount ?? 0) + d.walletBuys;
  if (conviction < 1) fails.push("no_conviction_signal");

  if (fails.length) return { pass: false, safe: false, reasons: fails };

  const safe =
    (d.top10Pct ?? 100) <= T.SAFE_TOP10_MAX
    && (d.bundlerHoldPct ?? 100) <= T.SAFE_BUNDLER_MAX
    && (d.rugRatio ?? 1) <= T.SAFE_RUG_MAX
    && (!T.SAFE_NEEDS_SMART_OR_KOL || (d.smartCount ?? 0) + (d.kolCount ?? 0) >= 1);

  const evidence: string[] = [];
  if ((d.smartCount ?? 0) > 0) evidence.push(`smart:${d.smartCount}`);
  if ((d.kolCount ?? 0) > 0) evidence.push(`kol:${d.kolCount}`);
  if (d.walletBuys > 0) evidence.push(`tracked_wallets:${d.walletBuys}`);
  if (d.rugRatio != null) evidence.push(`rug_ratio:${d.rugRatio.toFixed(2)}`);
  if (d.top10Pct != null) evidence.push(`top10:${d.top10Pct.toFixed(0)}%`);

  return { pass: true, safe, reasons: evidence };
}
