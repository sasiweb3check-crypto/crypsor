/**
 * Holder Intelligence v2
 *
 * Two orthogonal scores, then blended into one composite momentum signal:
 *
 *   qualityScore  (0–100) — static composition of current holders
 *     Rewards smart/KOL/early-sniper presence, decentralised top10,
 *     dev still holding; penalises bots and bundlers.
 *
 *   momentumScore (-100–100) — blended signal
 *     60 % weight → net accumulation ratio (flow signal from GMGN top-buyers)
 *     40 % weight → quality multiplier (qualityScore centred at 50)
 *
 *   momentumScoreV2 — explicit alias for the v2 formula result.
 *     Stored in a dedicated column so the old holderMomentumScore column
 *     can be deprecated independently without breaking existing sorts.
 *
 * Labels (doc v2):
 *   > 30  → "Strong Accumulation"
 *   > 10  → "Accumulating"
 *   > -10 → "Neutral"
 *   > -35 → "Distributing"
 *   else  → "Heavy Distribution"
 *
 * Cluster / cabal detection:
 *   Uses only the in-memory holder list (per-wallet address + labels +
 *   amount_percentage). No additional Helius calls are made — all
 *   clustering is derived from data already fetched in the holders-refresh
 *   pipeline pass. Three cluster types are detected:
 *     1. Label clusters  — bundler / sniper / kol groups
 *     2. Balance-bracket — 3+ wallets within 0.2 % of each other (coordinated entry)
 *   cabalDetected = true when a flagged cluster exists (bundler ≥ 2,
 *   sniper ≥ 3, or balance-bracket ≥ 4 wallets with > 8 % combined).
 */

// ── Cluster types ─────────────────────────────────────────────────────────────

export interface ClusterGroup {
  /** Cluster type identifier */
  label: "bundler" | "sniper" | "kol" | "bot" | "balance_bracket";
  walletCount:      number;
  /** Combined supply percentage held by this cluster */
  totalPct:         number;
  /** Whether this cluster meets the cabal-detection threshold */
  cabalistic:       boolean;
  walletAddresses:  string[];
}

export interface ClusterResult {
  clusterCount:      number;
  /** Largest single-cluster combined supply % (0–100) */
  largestClusterPct: number;
  /**
   * null  = per-wallet data was unavailable; clustering could not run.
   *         Treat as "unknown", not "clean".
   * false = clustering ran and found no coordinated groups above thresholds.
   * true  = at least one cluster met the cabal threshold (confidence-based estimate).
   */
  cabalDetected:     boolean | null;
  groups:            ClusterGroup[];
}

export interface HolderIntel {
  holderCount:   number;
  kolCount:      number;
  smartCount:    number;
  freshCount:    number;
  botCount:      number;
  insiderCount:  number;
  devCount:      number;
  bluechipCount: number;
  bundlerCount:  number;
  sniperCount:   number;
  top10Pct:      number;
  holdingRate:   number;
  boughtRate:    number;
  boughtMore:    number;
  hold:          number;
  soldPart:      number;
  sold:          number;
  /** 0–100 static composition score */
  qualityScore:  number;
  /** -100–100 blended composite (v1 field, kept for backward compat) */
  momentumScore: number;
  /** -100–100 blended composite — explicit v2 alias stored in dedicated column */
  momentumScoreV2: number;
  momentumLabel: "Strong Accumulation" | "Accumulating" | "Neutral" | "Distributing" | "Heavy Distribution";
  /** True when all flow fields are zero — no GMGN activity data */
  noActivity:    boolean;
  /**
   * Combined supply % held by bundler-tagged wallets in the analyzed slice.
   * 0 when no bundler cluster was detected or no per-wallet data was available.
   */
  bundlerSupplyPct: number;
  /** Number of wallets analyzed for cluster detection (top-N slice, not all holders) */
  holdersAnalyzedCount: number;
  /** Sum of amount_percentage across all analyzed wallets — how much of supply the slice covers */
  supplyPctAnalyzed: number;
  /** Cluster / cabal detection result */
  clusters:      ClusterResult;
}

// ── Raw GMGN payload types ────────────────────────────────────────────────────

type StatPayload = {
  smart_degen_count?:    number;
  renowned_count?:       number;
  fresh_wallet_count?:   number;
  dex_bot_count?:        number;
  insider_count?:        number;
  dev_count?:            number;
  bluechip_owner_count?: number;
  bundler_count?:        number;
  sniper_count?:         number;
};

type TokenInfoPayload = {
  holder_count?: number;
};

type StatusNow = {
  hold?:               number;
  bought_more?:        number;
  sold_part?:          number;
  sold?:               number;
  holding_rate?:       number | string | null;
  bought_rate?:        number | string | null;
  top_10_holder_rate?: number | string | null;
};

type TopBuyerPayload = {
  holders?: {
    holder_count?: number;
    statusNow?:    StatusNow;
  };
};

/** Minimal per-wallet fields from the GMGN holder list */
type RawHolderEntry = {
  address?:          string;
  account_address?:  string;
  amount_percentage?: number | null;
  balance?:          number | null;
  tags?:             string[];
  maker_token_tags?: string[];
  // Buy/sell tx counts present in GMGN /vas/api/v1/token_holders responses —
  // used by the G4 flow-synthesis fallback when top_buyers data is unavailable.
  buy_tx_count_cur?:  number | null;
  sell_tx_count_cur?: number | null;
  buy_count?:         number | null;
  sell_count?:        number | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentage(value: unknown): number {
  const parsed = numberValue(value);
  return Math.abs(parsed) <= 1 ? parsed * 100 : parsed;
}

function momentumLabel(score: number): HolderIntel["momentumLabel"] {
  if (score > 30)  return "Strong Accumulation";
  if (score > 10)  return "Accumulating";
  if (score > -10) return "Neutral";
  if (score > -35) return "Distributing";
  return "Heavy Distribution";
}

// ── Quality Score (0–100) ─────────────────────────────────────────────────────
//
// Theoretical range of rawQuality:
//   min ≈ -35  (100% bots + bundlers, no positives)
//   max ≈  90  (100% smart+KOL+sniper+fresh + both bonuses)
//
// Normalise to [0,100]: (rawQuality + 35) / 125 * 100

function computeQualityScore(params: {
  holderCount:   number;
  smartCount:    number;
  kolCount:      number;
  sniperCount:   number;
  freshCount:    number;
  botCount:      number;
  bundlerCount:  number;
  devCount:      number;
  top10Pct:      number;   // already in 0-100 range
}): number {
  const base = Math.max(params.holderCount, 1);

  // B2 fix: clamp ratios to [0, 1] — label counts come from the full GMGN stat
  // endpoint (all wallets ever) while holderCount is capped at the top-200 fetch,
  // so sub-counts can legitimately exceed holderCount.  Without clamping the ratios
  // exceed 1 and the score becomes nonsensical.
  const smartRatio   = Math.min(params.smartCount   / base, 1);
  const kolRatio     = Math.min(params.kolCount     / base, 1);
  const sniperRatio  = Math.min(params.sniperCount  / base, 1);
  const freshRatio   = Math.min(params.freshCount   / base, 1);
  const botRatio     = Math.min(params.botCount     / base, 1);
  const bundlerRatio = Math.min(params.bundlerCount / base, 1);

  // Concentration bonus: decentralised top10 is healthier
  const lowTop10Bonus = params.top10Pct < 25 ? 10 : params.top10Pct < 40 ? 5 : 0;
  // Dev still holding = confidence signal
  const devHoldBonus  = params.devCount > 0 ? 5 : 0;

  const rawQuality =
    (smartRatio   * 35) +
    (kolRatio     * 20) +
    (sniperRatio  * 12) +
    (freshRatio   *  8) -
    (botRatio     * 15) -
    (bundlerRatio * 20) +
    lowTop10Bonus +
    devHoldBonus;

  // Normalise [-35, 90] → [0, 100]
  return Math.max(0, Math.min(100, Math.round(((rawQuality + 35) / 125) * 100)));
}

// ── Cluster / Cabal Detection ─────────────────────────────────────────────────
//
// Uses ONLY the in-memory holder list — no additional API calls.
// GMGN per-wallet data includes: address, tags/maker_token_tags, amount_percentage.
//
// Thresholds (cabal-detection):
//   bundler cluster: ≥ 5 wallets AND ≥ 4 % combined supply
//   sniper  cluster: ≥ 6 wallets AND ≥ 5 % combined supply
//   balance-bracket: ≥ 6 wallets within 0.2% of each other AND > 15% combined
//
// Previous thresholds (bundler ≥2, sniper ≥3, bracket ≥4/8%) flagged 90% of
// all snapshots because every Solana meme token has a few bundlers/snipers by
// default.  These tighter thresholds require meaningful coordinated supply
// concentration, reducing false-positive rate to ~10–20%.

const BALANCE_BRACKET_PCT = 0.2;   // wallets within this % of each other → cluster
const BALANCE_MIN_WALLETS = 3;     // min wallets to form a balance-bracket group
const CABAL_BRACKET_WALLETS = 6;   // min wallets for a bracket group to be cabalistic
const CABAL_BRACKET_PCT = 15;      // min combined % for a bracket group to be cabalistic

// Minimum combined supply % for label-based clusters to be considered cabalistic
const CABAL_BUNDLER_MIN_WALLETS = 5;
const CABAL_BUNDLER_MIN_PCT     = 4;   // combined %
const CABAL_SNIPER_MIN_WALLETS  = 6;
const CABAL_SNIPER_MIN_PCT      = 5;   // combined %

function detectClusters(rawList: unknown[]): ClusterResult {
  // No per-wallet data → clustering cannot run; return null, not false.
  // null means "unknown" (couldn't check), which is distinct from false ("checked, clean").
  if (rawList.length === 0) {
    return { clusterCount: 0, largestClusterPct: 0, cabalDetected: null, groups: [] };
  }

  const holders = rawList as RawHolderEntry[];
  const groups: ClusterGroup[] = [];

  const getLabels = (h: RawHolderEntry): string[] => [
    ...(h.tags ?? []),
    ...(h.maker_token_tags ?? []),
  ];
  const getAddress = (h: RawHolderEntry): string =>
    h.address ?? h.account_address ?? "";

  // ── 1. Label-based clusters ──────────────────────────────────────────────
  type LabelDef = {
    key:        ClusterGroup["label"];
    tags:       string[];
    minWallets: number;
    // Cabalistic when BOTH count AND supply thresholds are met (0 = no supply check)
    cabalMinWallets: number;
    cabalMinPct:     number;  // minimum combined supply % (after ×100 conversion)
  };
  const LABEL_DEFS: LabelDef[] = [
    { key: "bundler", tags: ["bundler"],         minWallets: 2, cabalMinWallets: CABAL_BUNDLER_MIN_WALLETS, cabalMinPct: CABAL_BUNDLER_MIN_PCT },
    { key: "sniper",  tags: ["sniper"],          minWallets: 2, cabalMinWallets: CABAL_SNIPER_MIN_WALLETS,  cabalMinPct: CABAL_SNIPER_MIN_PCT  },
    { key: "kol",     tags: ["kol", "renowned"], minWallets: 2, cabalMinWallets: 999, cabalMinPct: 0 }, // KOL clusters aren't cabalistic
    { key: "bot",     tags: ["dex_bot", "bot"],  minWallets: 3, cabalMinWallets: 999, cabalMinPct: 0 }, // bots aren't cabalistic
  ];

  for (const def of LABEL_DEFS) {
    const matched = holders.filter(h =>
      getLabels(h).some(l => def.tags.includes(l)),
    );
    if (matched.length < def.minWallets) continue;

    // amount_percentage is a decimal fraction (0.021 = 2.1%) — convert to percent
    const totalPct = matched.reduce((s, h) => s + (h.amount_percentage ?? 0), 0) * 100;
    groups.push({
      label:           def.key,
      walletCount:     matched.length,
      totalPct:        Math.round(totalPct * 100) / 100,
      cabalistic:      matched.length >= def.cabalMinWallets && totalPct >= def.cabalMinPct,
      walletAddresses: matched.map(getAddress).filter(Boolean),
    });
  }

  // ── 2. Balance-bracket clusters (coordinated entry detection) ────────────
  // Convert amount_percentage (GMGN decimal fraction 0.021 = 2.1%) to percent.
  // Exclude extreme outliers (>5% single holder — these are whales, not clusters).
  const withPct = holders
    .map(h => ({ addr: getAddress(h), pct: (h.amount_percentage ?? 0) * 100 }))
    .filter(h => h.pct > 0.01 && h.pct < 5)
    .sort((a, b) => a.pct - b.pct);

  let i = 0;
  while (i < withPct.length) {
    let j = i + 1;
    while (j < withPct.length && withPct[j].pct - withPct[i].pct <= BALANCE_BRACKET_PCT) j++;
    const cluster = withPct.slice(i, j);
    if (cluster.length >= BALANCE_MIN_WALLETS) {
      const totalPct = cluster.reduce((s, h) => s + h.pct, 0);
      const cabalistic =
        cluster.length >= CABAL_BRACKET_WALLETS && totalPct >= CABAL_BRACKET_PCT;
      groups.push({
        label:           "balance_bracket",
        walletCount:     cluster.length,
        totalPct:        Math.round(totalPct * 100) / 100,
        cabalistic,
        walletAddresses: cluster.map(h => h.addr).filter(Boolean),
      });
    }
    i = j;
  }

  const clusterCount      = groups.length;
  const largestClusterPct = groups.length > 0
    ? Math.max(...groups.map(g => g.totalPct))
    : 0;
  const cabalDetected     = groups.some(g => g.cabalistic);

  return {
    clusterCount,
    largestClusterPct: Math.round(largestClusterPct * 100) / 100,
    cabalDetected,
    groups,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * GMGN's holder-stat endpoint is the authoritative source for label counts.
 * The holder list is intentionally only a top slice, so it must never be used
 * to infer token-wide KOL/smart/bot totals.
 *
 * @param rawHolderList  Per-wallet GMGN holder list. Used only for cluster
 *                       detection — not for label counts (those come from stat).
 *                       Safe to omit; detectClusters returns empty result.
 */
export function buildHolderIntel(input: {
  tokenInfo?:       unknown;
  holderStat?:      unknown;
  topBuyers?:       unknown;
  fetchedTopCount?: number;
  rawHolderList?:   unknown[];
}): HolderIntel {
  const tokenInfo = (input.tokenInfo as { data?: TokenInfoPayload } | undefined)?.data ?? {};
  const stat      = (input.holderStat as { data?: StatPayload }     | undefined)?.data ?? {};
  const top       = (input.topBuyers  as { data?: TopBuyerPayload } | undefined)?.data?.holders;
  const status    = top?.statusNow ?? {};

  // Declare rawList early — needed by both the G4 flow-synthesis fallback below
  // and the top10Pct calculation further down.
  const rawList = (input.rawHolderList ?? []) as RawHolderEntry[];

  // ── Flow counts (GMGN top-buyers activity) ────────────────────────────────
  // Primary source: statusNow from the top-buyers endpoint.
  // G4 fix: that endpoint was retired by GMGN, so statusNow is always empty.
  // When primary data is absent we fall back to synthesising flow from the
  // per-wallet buy/sell tx counts already present in the holder list itself.
  let hold       = Math.round(numberValue(status.hold));
  let boughtMore = Math.round(numberValue(status.bought_more));
  let soldPart   = Math.round(numberValue(status.sold_part));
  let sold       = Math.round(numberValue(status.sold));

  // G4 fallback: derive hold/bought/soldPart/sold from per-wallet tx counts.
  // Runs only when the primary source returns all zeros (retired endpoint).
  if (hold + boughtMore + soldPart + sold === 0 && rawList.length > 0) {
    for (const h of rawList) {
      const buys  = Math.round(numberValue(h.buy_tx_count_cur ?? h.buy_count));
      const sells = Math.round(numberValue(h.sell_tx_count_cur ?? h.sell_count));
      const hasBal = (h.amount_percentage ?? 0) > 0 || (h.balance ?? 0) > 0;
      if      (buys === 0 && sells === 0) { hold++; }        // no tx data → count as hold
      else if (sells === 0)               { hold++; }        // only bought, still in
      else if (buys > sells && hasBal)    { boughtMore++; }  // net accumulator, still in
      else if (hasBal)                    { soldPart++; }    // partial exit, still holding
      else                                { sold++; }        // fully exited
    }
  }

  const rawFlowSum = hold + boughtMore + soldPart + sold;
  const noActivity = rawFlowSum === 0;

  // flowTotal must be the LARGEST known holder count so the score is expressed
  // as a fraction of the full holder base, not just the top-buyers slice.
  const knownHolderCount = Math.max(
    numberValue(tokenInfo.holder_count),
    numberValue(top?.holder_count),
    rawFlowSum,
    1,
  );
  const flowTotal = noActivity ? knownHolderCount : Math.max(rawFlowSum, knownHolderCount);
  const netFlow   = boughtMore + hold - soldPart - sold;

  // ── Label counts (token-wide from GMGN stat endpoint) ────────────────────
  const kolCount      = Math.round(numberValue(stat.renowned_count));
  const smartCount    = Math.round(numberValue(stat.smart_degen_count));
  const freshCount    = Math.round(numberValue(stat.fresh_wallet_count));
  const botCount      = Math.round(numberValue(stat.dex_bot_count));
  const insiderCount  = Math.round(numberValue(stat.insider_count));
  const devCount      = Math.round(numberValue(stat.dev_count));
  const bluechipCount = Math.round(numberValue(stat.bluechip_owner_count));
  const bundlerCount  = Math.round(numberValue(stat.bundler_count));
  const sniperCount   = Math.round(numberValue(stat.sniper_count));
  const holderCount   = Math.round(
    numberValue(tokenInfo.holder_count) ||
    numberValue(top?.holder_count)      ||
    input.fetchedTopCount               || 0,
  );

  // top10Pct: prefer GMGN statusNow field; fall back to summing the top 10 entries
  // from the holder list (which GMGN returns sorted descending by amount_percentage).
  // This prevents top10Pct being 0 when top_buyers statusNow is missing for a token.
  const statusTop10Pct = percentage(status.top_10_holder_rate);
  // rawList is declared earlier (above the flow section) so the G4 fallback can use it.
  // GMGN amount_percentage is a decimal fraction (0.021 = 2.1%) — multiply by 100
  // to normalise to the same percent (0–100) unit used by statusTop10Pct.
  const listTop10Pct   = rawList.length > 0
    ? rawList.slice(0, 10).reduce((s, h) => s + (h.amount_percentage ?? 0), 0) * 100
    : 0;
  const top10Pct    = statusTop10Pct > 0 ? statusTop10Pct : Math.round(listTop10Pct * 100) / 100;
  const holdingRate = percentage(status.holding_rate);
  const boughtRate  = percentage(status.bought_rate);

  // ── Quality Score (0–100) ─────────────────────────────────────────────────
  const qualityScore = computeQualityScore({
    holderCount, smartCount, kolCount, sniperCount,
    freshCount, botCount, bundlerCount, devCount, top10Pct,
  });

  // ── Composite Momentum Score v2 (-100–100) ────────────────────────────────
  // 60% flow signal (net accumulation ratio)
  // 40% quality signal (quality centred at 50 → contributes -40 to +40)
  //
  // Null / zero guards:
  //   - noActivity=true  → score is 0 (not NaN), label is "Neutral"
  //   - flowTotal always ≥ 1 (see knownHolderCount initialisation above)
  //   - qualityScore always in [0,100] → qualityMultiplier in [-1, 1]
  //   - final value is clamped to [-100, 100] and rounded
  const netAccumulationRatio = noActivity ? 0 : netFlow / flowTotal;  // -1 to 1
  const qualityMultiplier    = (qualityScore - 50) / 50;              // -1 to 1

  const momentumScoreRaw = noActivity
    ? 0
    : netAccumulationRatio * 60 + qualityMultiplier * 40;

  // v1 (legacy): pure net-flow signal — kept for backward compat / historical comparison.
  // Scores every token purely on buy/sell ratio; ignores holder quality entirely.
  const momentumScore = noActivity
    ? 0
    : Math.max(-100, Math.min(100, Math.round(netAccumulationRatio * 100)));

  // v2 (canonical): 60% flow + 40% quality blend — the signal to use for all decisions.
  const momentumScoreV2 = Math.max(-100, Math.min(100, Math.round(momentumScoreRaw)));

  // ── Cluster / cabal detection ─────────────────────────────────────────────
  const clusters = detectClusters(input.rawHolderList ?? []);

  // Supply % held by bundler-tagged wallets within the analyzed slice.
  const bundlerGroup       = clusters.groups.find(g => g.label === "bundler");
  const bundlerSupplyPct   = bundlerGroup ? Math.round(bundlerGroup.totalPct * 100) / 100 : 0;
  const holdersAnalyzedCount = rawList.length;
  // Total supply % covered by all analyzed wallets combined.
  const supplyPctAnalyzed = Math.round(
    rawList.reduce((s, h) => s + (h.amount_percentage ?? 0), 0) * 100,
  ) / 100;

  return {
    holderCount,
    kolCount,
    smartCount,
    freshCount,
    botCount,
    insiderCount,
    devCount,
    bluechipCount,
    bundlerCount,
    sniperCount,
    top10Pct,
    holdingRate,
    boughtRate,
    boughtMore,
    hold,
    soldPart,
    sold,
    qualityScore,
    momentumScore,
    momentumScoreV2,
    momentumLabel: momentumLabel(momentumScoreV2), // label driven by the canonical v2 score
    noActivity,
    bundlerSupplyPct,
    holdersAnalyzedCount,
    supplyPctAnalyzed,
    clusters,
  };
}
