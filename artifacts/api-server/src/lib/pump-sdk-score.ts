/**
 * Pump-SDK strategy scoring — ported from pump-fullend (src/utils/scoring.js).
 * Scores DexScreener pair snapshots; discovery stays Crypsor token_buys only.
 */

export type PumpGrade = "S" | "A" | "B" | "C" | "D";
export type PumpBuyLevel = "STRONG_BUY" | "WATCH";
export type PumpIntraLevel = "INTRA_NOW" | "INTRA_SOON";
export type PumpTagType = "positive" | "warning" | "negative";

export type DexPairLike = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  pairCreatedAt?: number;
  priceUsd?: string | number;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  baseToken?: { address?: string; name?: string; symbol?: string };
};

export type PumpScoreBreakdown = {
  graduationSpeed: number;
  volumeVelocity: number;
  priceMultiple: number;
  buyPressure: number;
  liquidityDepth: number;
  txFrequency: number;
  vlEfficiency: number;
  socialSignal: number;
  earlyExplosionIndex: number;
};

export type PumpScoreResult = {
  scores: PumpScoreBreakdown;
  total: number;
  grade: PumpGrade;
  recommendation: string;
  mcapModifier: number;
  freshnessMultiplier: number;
};

export type PumpSignalTag = { label: string; type: PumpTagType };

export type PumpBuySignal = {
  level: PumpBuyLevel;
  passCount: number;
  firedAt: number;
  conditions: Array<{ id: string; label: string; pass: boolean }>;
};

export type PumpIntraSignal = {
  level: PumpIntraLevel;
  passCount: number;
  urgency: number;
  firedAt: number;
  conditions: Array<{ id: string; label: string; pass: boolean }>;
};

export type PumpScanPayload = {
  score: number;
  grade: PumpGrade;
  recommendation: string;
  scores: PumpScoreBreakdown;
  tags: PumpSignalTag[];
  buySignal: PumpBuyLevel | null;
  intraSignal: PumpIntraLevel | null;
  buyPassCount: number;
  intraPassCount: number;
  buyFiredAt: number | null;
  intraFiredAt: number | null;
  buyConditions: Array<{ id: string; label: string; pass: boolean }>;
  intraConditions: Array<{ id: string; label: string; pass: boolean }>;
  pairAddress: string | null;
  dexId: string | null;
  scannedAt: string;
  source: "token_buys";
  marketCap: number;
  liquidityUsd: number;
  volume24h: number;
  volume1h: number;
  txns24h: number;
  pairCreatedAt: number | null;
  priceChange24h: number;
  priceUsd: number;
  freshnessMultiplier: number;
  socialSignal: number;
  /** First successful scan timestamp (sticky) */
  detectedAt: number;
  /** Sticky entry price from first scan with price > 0 */
  priceAtDetection: number;
  athPrice: number;
  athAt: number;
  /** Price % since detection */
  gainSinceDetection: number;
  athGain: number;
  /** Sticky entry MC from first scan with MC > 0 */
  mcAtDetection: number;
  athMc: number;
  /** MC % since detection (desk primary) */
  mcGainSinceDetection: number;
  athMcGain: number;
};

/** FilterBar.dev keyword list — pump-fullend FilterBar.applyFilters */
export const PUMP_DEV_KEYWORDS = [
  "sdk", "dev", "build", "code", "open", "source", "hack", "fork",
  "api", "bot", "agent", "ai", "mcp", "tool", "github",
] as const;

const VALID_DEX_IDS = new Set(["pumpswap", "raydium", "meteora", "orca"]);

export function pickBestSolanaPair(pairs: DexPairLike[]): DexPairLike | null {
  const sol = pairs.filter((p) => (p.chainId || "").toLowerCase() === "solana");
  const pool = sol.length ? sol : pairs;
  if (!pool.length) return null;
  const ranked = [...pool].sort((a, b) => {
    const aDex = VALID_DEX_IDS.has((a.dexId || "").toLowerCase()) ? 1 : 0;
    const bDex = VALID_DEX_IDS.has((b.dexId || "").toLowerCase()) ? 1 : 0;
    if (aDex !== bDex) return bDex - aDex;
    const aLiq = a.liquidity?.usd ?? 0;
    const bLiq = b.liquidity?.usd ?? 0;
    if (aLiq !== bLiq) return bLiq - aLiq;
    return (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0);
  });
  return ranked[0] ?? null;
}

export function scoreToken(token: DexPairLike): PumpScoreResult {
  const scores: PumpScoreBreakdown = {
    graduationSpeed: 0,
    volumeVelocity: 0,
    priceMultiple: 0,
    buyPressure: 0,
    liquidityDepth: 0,
    txFrequency: 0,
    vlEfficiency: 0,
    socialSignal: 0,
    earlyExplosionIndex: 0,
  };

  const ageMins = token.pairCreatedAt
    ? (Date.now() - token.pairCreatedAt) / 60_000
    : 9999;

  const vol24h = token.volume?.h24 || 0;
  const vol6h = token.volume?.h6 || 0;
  const vol1h = token.volume?.h1 || 0;
  const liquidity = token.liquidity?.usd || 0;
  const mcap = token.marketCap || 0;

  const txns = token.txns?.h24 || {};
  const txBuys = txns.buys || 0;
  const txSells = txns.sells || 0;
  const totalTxns = txBuys + txSells;
  const buyRatio = totalTxns > 0 ? txBuys / totalTxns : 0.5;

  const p5m = token.priceChange?.m5 || 0;
  const p1h = token.priceChange?.h1 || 0;
  const p6h = token.priceChange?.h6 || 0;
  const p24h = token.priceChange?.h24 || 0;

  let speedBase =
    ageMins <= 20 ? 18
      : ageMins <= 30 ? 15
        : ageMins <= 60 ? 11
          : ageMins <= 120 ? 7
            : ageMins <= 360 ? 3
              : 0;
  if (speedBase >= 11 && vol1h < 500) speedBase = Math.max(0, speedBase - 5);
  scores.graduationSpeed = speedBase;

  let volBase =
    vol24h >= 500_000 ? 16
      : vol24h >= 200_000 ? 13
        : vol24h >= 100_000 ? 10
          : vol24h >= 50_000 ? 7
            : vol24h >= 10_000 ? 4
              : vol24h >= 2_000 ? 2
                : 0;
  const hourlyAvg6h = vol6h > 0 ? vol6h / 6 : 0;
  const accel = hourlyAvg6h > 0 ? vol1h / hourlyAvg6h : 1;
  const accelBonus =
    accel >= 3 ? 6 : accel >= 2 ? 4 : accel >= 1.5 ? 2 : accel < 0.4 ? -3 : 0;
  scores.volumeVelocity = Math.max(0, Math.min(22, volBase + accelBonus));

  const sustainedMove = Math.max(p1h, p6h, p24h);
  let priceScore =
    sustainedMove >= 500 ? 16
      : sustainedMove >= 200 ? 13
        : sustainedMove >= 100 ? 10
          : sustainedMove >= 50 ? 7
            : sustainedMove >= 20 ? 4
              : sustainedMove >= 0 ? 2
                : 0;
  if (p5m > 5 && sustainedMove > 0) priceScore = Math.min(16, priceScore + 1);
  scores.priceMultiple = priceScore;

  let buyScore =
    buyRatio >= 0.75 ? 12
      : buyRatio >= 0.65 ? 10
        : buyRatio >= 0.55 ? 7
          : buyRatio >= 0.45 ? 4
            : buyRatio >= 0.35 ? 2
              : 0;
  if (totalTxns < 50) buyScore = Math.min(buyScore, 3);
  scores.buyPressure = buyScore;

  scores.liquidityDepth =
    liquidity >= 200_000 ? 8
      : liquidity >= 100_000 ? 7
        : liquidity >= 50_000 ? 5
          : liquidity >= 20_000 ? 3
            : liquidity >= 5_000 ? 1
              : 0;

  const effectiveHours = Math.max(1, Math.min(ageMins / 60, 24));
  const txPerHour = totalTxns / effectiveHours;
  scores.txFrequency =
    txPerHour >= 2000 ? 12
      : txPerHour >= 800 ? 10
        : txPerHour >= 300 ? 7
          : txPerHour >= 100 ? 5
            : txPerHour >= 30 ? 3
              : 1;

  const vlRatio = liquidity > 0 ? vol24h / liquidity : 0;
  scores.vlEfficiency =
    vlRatio >= 50 && liquidity >= 20_000 ? 6
      : vlRatio >= 20 && liquidity >= 10_000 ? 5
        : vlRatio >= 10 ? 4
          : vlRatio >= 5 ? 2
            : vlRatio >= 1 ? 1
              : 0;

  const name = (token.baseToken?.name || "").toLowerCase();
  const symbol = (token.baseToken?.symbol || "").toLowerCase();
  const combined = `${name} ${symbol}`;
  const tier1 = ["sdk", "mcp", "agent", "api", "github", "open source", "opensrc"];
  const tier2 = ["dev", "build", "code", "hack", "fork", "deploy", "protocol", "tool"];
  const tier3 = ["ai", "bot", "web3", "defi", "solana", "pump", "smart", "contract"];
  const t1 = tier1.filter((kw) => combined.includes(kw)).length;
  const t2 = tier2.filter((kw) => combined.includes(kw)).length;
  const t3 = tier3.filter((kw) => combined.includes(kw)).length;
  scores.socialSignal =
    t1 >= 1 ? 6
      : t2 >= 2 ? 5
        : t2 >= 1 && t3 >= 1 ? 4
          : t2 >= 1 ? 3
            : t3 >= 2 ? 2
              : t3 >= 1 ? 1
                : 0;

  let eeiScore = 0;
  const eeiMcap = token.marketCap || 0;
  const eeiFdv = token.fdv || 0;
  const eeiBestMc = (eeiMcap > 0 && eeiFdv > 0)
    ? Math.min(eeiMcap, eeiFdv)
    : (eeiMcap || eeiFdv);
  if (eeiBestMc > 0 && eeiBestMc < 50_000 && ageMins <= 60) {
    const volMcRatio = vol1h > 0 ? vol1h / eeiBestMc : vol24h / eeiBestMc;
    const volMcBase =
      volMcRatio >= 5 ? 6
        : volMcRatio >= 3 ? 5
          : volMcRatio >= 2 ? 4
            : volMcRatio >= 1 ? 2
              : volMcRatio >= 0.5 ? 1
                : 0;
    const ageBonus = ageMins <= 10 ? 2 : ageMins <= 20 ? 1 : 0;
    const buyBonus = buyRatio >= 0.7 ? 2 : buyRatio >= 0.6 ? 1 : buyRatio < 0.45 ? -2 : 0;
    const txnsPerMin = ageMins > 0 ? totalTxns / ageMins : 0;
    const txBonus = txnsPerMin >= 20 ? 2 : txnsPerMin >= 10 ? 1 : 0;
    eeiScore = Math.max(0, Math.min(10, volMcBase + ageBonus + buyBonus + txBonus));
  }
  scores.earlyExplosionIndex = eeiScore;

  const rawTotal = Object.values(scores).reduce((a, b) => a + b, 0);
  let mcapModifier = 0;
  if (mcap > 0 && mcap < 50_000) mcapModifier = 3;
  else if (mcap >= 50_000 && mcap < 200_000) mcapModifier = 1;
  else if (mcap >= 500_000 && mcap < 1_500_000) mcapModifier = -2;
  else if (mcap >= 1_500_000) mcapModifier = -5;

  const freshnessMultiplier = Math.max(0.4, 1 - (ageMins / 480));
  const total = Math.max(0, Math.min(100, Math.round((rawTotal + mcapModifier) * freshnessMultiplier)));

  let grade: PumpGrade = "D";
  let recommendation = "NO FIT";
  if (total >= 78) { grade = "S"; recommendation = "STRONG FIT"; }
  else if (total >= 62) { grade = "A"; recommendation = "GOOD FIT"; }
  else if (total >= 46) { grade = "B"; recommendation = "MODERATE FIT"; }
  else if (total >= 30) { grade = "C"; recommendation = "WEAK FIT"; }

  return { scores, total, grade, recommendation, mcapModifier, freshnessMultiplier };
}

export function getSignalTags(token: DexPairLike, scoreResult: PumpScoreResult): PumpSignalTag[] {
  const tags: PumpSignalTag[] = [];
  const { scores, mcapModifier } = scoreResult;
  const vol24h = token.volume?.h24 || 0;
  const vol6h = token.volume?.h6 || 0;
  const vol1h = token.volume?.h1 || 0;
  const liquidity = token.liquidity?.usd || 0;
  const mcap = token.marketCap || 0;
  const txns = token.txns?.h24 || {};
  const totalTxns = (txns.buys || 0) + (txns.sells || 0);
  const buyRatio = totalTxns > 0 ? (txns.buys || 0) / totalTxns : 0.5;
  const ageMins = token.pairCreatedAt ? (Date.now() - token.pairCreatedAt) / 60_000 : 9999;
  const hourlyAvg = vol6h > 0 ? vol6h / 6 : 0;
  const accel = hourlyAvg > 0 ? vol1h / hourlyAvg : 1;
  const vlRatio = liquidity > 0 ? vol24h / liquidity : 0;

  if (scores.graduationSpeed >= 15) tags.push({ label: "Fast Grad", type: "positive" });
  if (scores.volumeVelocity >= 16) tags.push({ label: "Vol Surge", type: "positive" });
  if (accel >= 2.0) tags.push({ label: "Accelerating", type: "positive" });
  if (scores.priceMultiple >= 10) tags.push({ label: "Strong Move", type: "positive" });
  if (scores.buyPressure >= 10) tags.push({ label: "Buy Dom", type: "positive" });
  if (scores.txFrequency >= 10) tags.push({ label: "High TX", type: "positive" });
  if (scores.liquidityDepth >= 7) tags.push({ label: "Deep Liq", type: "positive" });
  if (scores.socialSignal >= 5) tags.push({ label: "Dev Narrative", type: "positive" });
  if (vlRatio >= 20) tags.push({ label: "V/L Flywheel", type: "positive" });
  if (mcap > 0 && mcap < 50_000) tags.push({ label: "Micro Cap", type: "positive" });
  if (ageMins <= 30) tags.push({ label: "Just Graduated", type: "positive" });
  if (scores.earlyExplosionIndex >= 8) tags.push({ label: "Larry Signal", type: "positive" });
  else if (scores.earlyExplosionIndex >= 5) tags.push({ label: "EEI Active", type: "positive" });

  if (vlRatio > 100 && liquidity < 10_000) tags.push({ label: "Thin Liq", type: "warning" });
  if (mcap >= 1_000_000) tags.push({ label: "Extended", type: "warning" });
  if (accel < 0.4 && vol24h > 5_000) tags.push({ label: "Vol Fading", type: "warning" });
  if (mcapModifier < 0) tags.push({ label: "Late Stage", type: "warning" });

  if (buyRatio < 0.4) tags.push({ label: "Sell Pressure", type: "negative" });
  if (scores.priceMultiple === 0 && (token.priceChange?.h24 || 0) < -20) {
    tags.push({ label: "Dumping", type: "negative" });
  }
  return tags;
}

export function getBuySignal(token: DexPairLike, scoreResult: PumpScoreResult): PumpBuySignal | null {
  const ageMins = token.pairCreatedAt ? (Date.now() - token.pairCreatedAt) / 60_000 : 9999;
  const vol6h = token.volume?.h6 || 0;
  const vol1h = token.volume?.h1 || 0;
  const liquidity = token.liquidity?.usd || 0;
  const mcap = token.marketCap || 0;
  const txns = token.txns?.h24 || {};
  const totalTxns = (txns.buys || 0) + (txns.sells || 0);
  const buyRatio = totalTxns > 0 ? (txns.buys || 0) / totalTxns : 0;
  const p5m = token.priceChange?.m5 || 0;
  const p1h = token.priceChange?.h1 || 0;
  const hourlyAvg = vol6h > 0 ? vol6h / 6 : 0;
  const accel = hourlyAvg > 0 ? vol1h / hourlyAvg : 0;
  const eei = scoreResult.scores.earlyExplosionIndex || 0;

  const conditions = [
    { id: "momentum", label: "Vol Surge", pass: accel >= 2.0 },
    { id: "buywall", label: "Buy Wall", pass: buyRatio >= 0.65 },
    { id: "breakout", label: "Breakout", pass: p5m > 2 && p1h > 0 },
    { id: "micro", label: "Micro Cap", pass: mcap > 0 && mcap < 150_000 },
    { id: "fresh", label: "Fresh", pass: ageMins < 60 },
    { id: "liquid", label: "Liquid", pass: liquidity >= 8_000 },
    { id: "score", label: "A-Grade+", pass: scoreResult.total >= 62 },
    { id: "larry", label: "Larry Signal", pass: eei >= 5 },
  ];

  const passCount = conditions.filter((c) => c.pass).length;
  if (passCount >= 6) {
    return { level: "STRONG_BUY", passCount, firedAt: Date.now(), conditions };
  }
  if (passCount >= 4) {
    return { level: "WATCH", passCount, firedAt: Date.now(), conditions };
  }
  return null;
}

export function getIntraSignal(token: DexPairLike, scoreResult: PumpScoreResult): PumpIntraSignal | null {
  if ((scoreResult.total || 0) < 55) return null;
  const ageMins = token.pairCreatedAt ? (Date.now() - token.pairCreatedAt) / 60_000 : 9999;
  const mcap = token.marketCap || 0;
  const vol5m = token.volume?.m5 || 0;
  const vol1h = token.volume?.h1 || 0;
  const vol6h = token.volume?.h6 || 0;
  const p5m = token.priceChange?.m5 || 0;
  const buys5m = token.txns?.m5?.buys || 0;
  const sells5m = token.txns?.m5?.sells || 0;
  const hourlyAvg = vol6h > 0 ? vol6h / 6 : 0;
  const accel = hourlyAvg > 0 ? vol1h / hourlyAvg : 0;

  const conditions = [
    { id: "ultra_fresh", label: "Ultra Fresh", pass: ageMins <= 20 },
    { id: "vol5m_burst", label: "5m Vol Burst", pass: vol5m >= 500 },
    { id: "buy_surge", label: "5m Buy Surge", pass: buys5m > sells5m && buys5m + sells5m >= 3 },
    { id: "price_pumping", label: "Price Pumping", pass: p5m >= 3 },
    { id: "micro_entry", label: "Micro Cap", pass: mcap > 0 && mcap < 100_000 },
    {
      id: "momentum_live",
      label: "Momentum Live",
      pass: accel >= 1.8 || (hourlyAvg === 0 && vol1h > 1000),
    },
  ];

  const passCount = conditions.filter((c) => c.pass).length;
  let level: PumpIntraLevel | null = null;
  if (passCount >= 5) level = "INTRA_NOW";
  else if (passCount >= 4) level = "INTRA_SOON";
  if (!level) return null;

  const urgency = Math.min(100, Math.round(
    (passCount / 6) * 60
    + Math.min(20, Math.max(0, 20 - ageMins))
    + Math.min(10, p5m > 0 ? Math.min(p5m, 10) : 0)
    + Math.min(10, accel > 0 ? Math.min(accel * 2, 10) : 0),
  ));

  return { level, passCount, urgency, firedAt: Date.now(), conditions };
}

function pctGain(from: number, to: number): number {
  if (!(from > 0) || !Number.isFinite(to)) return 0;
  return ((to - from) / from) * 100;
}

export function buildPumpScanPayload(
  token: DexPairLike,
  prev?: PumpScanPayload | null,
): PumpScanPayload {
  const score = scoreToken(token);
  const buy = getBuySignal(token, score);
  const intra = getIntraSignal(token, score);
  const priceUsd = parseFloat(String(token.priceUsd ?? 0)) || 0;
  const mcap = token.marketCap || token.fdv || 0;
  const now = Date.now();

  // Sticky detection anchors — never invent a fresh detectedAt on re-parse
  const detectedAt = prev?.detectedAt && prev.detectedAt > 0 ? prev.detectedAt : now;
  const priceAtDetection = prev?.priceAtDetection && prev.priceAtDetection > 0
    ? prev.priceAtDetection
    : (priceUsd > 0 ? priceUsd : 0);
  const mcAtDetection = prev?.mcAtDetection && prev.mcAtDetection > 0
    ? prev.mcAtDetection
    : (mcap > 0 ? mcap : 0);

  const prevAthPrice = prev?.athPrice && prev.athPrice > 0 ? prev.athPrice : 0;
  const prevAthMc = prev?.athMc && prev.athMc > 0 ? prev.athMc : 0;
  const athPrice = Math.max(prevAthPrice, priceUsd);
  const athMc = Math.max(prevAthMc, mcap);
  const athAt = (priceUsd > prevAthPrice || mcap > prevAthMc)
    ? now
    : (prev?.athAt && prev.athAt > 0 ? prev.athAt : detectedAt);

  const gainSinceDetection = pctGain(priceAtDetection, priceUsd);
  const athGain = pctGain(priceAtDetection, athPrice);
  const mcGainSinceDetection = pctGain(mcAtDetection, mcap);
  const athMcGain = pctGain(mcAtDetection, athMc);

  // Sticky signal fire times while level stays active
  const buyFiredAt = buy
    ? (prev?.buySignal && prev.buyFiredAt ? prev.buyFiredAt : now)
    : null;
  const intraFiredAt = intra
    ? (prev?.intraSignal && prev.intraFiredAt ? prev.intraFiredAt : now)
    : null;

  const txBuys = token.txns?.h24?.buys || 0;
  const txSells = token.txns?.h24?.sells || 0;

  return {
    score: score.total,
    grade: score.grade,
    recommendation: score.recommendation,
    scores: score.scores,
    tags: getSignalTags(token, score),
    buySignal: buy?.level ?? null,
    intraSignal: intra?.level ?? null,
    buyPassCount: buy?.passCount ?? 0,
    intraPassCount: intra?.passCount ?? 0,
    buyFiredAt,
    intraFiredAt,
    buyConditions: buy?.conditions ?? [],
    intraConditions: intra?.conditions ?? [],
    pairAddress: token.pairAddress ?? null,
    dexId: token.dexId ?? null,
    scannedAt: new Date().toISOString(),
    source: "token_buys",
    marketCap: mcap,
    liquidityUsd: token.liquidity?.usd || 0,
    volume24h: token.volume?.h24 || 0,
    volume1h: token.volume?.h1 || 0,
    txns24h: txBuys + txSells,
    pairCreatedAt: token.pairCreatedAt ?? null,
    priceChange24h: token.priceChange?.h24 || 0,
    priceUsd,
    freshnessMultiplier: score.freshnessMultiplier,
    socialSignal: score.scores.socialSignal,
    detectedAt,
    priceAtDetection,
    athPrice,
    athAt,
    gainSinceDetection,
    athGain,
    mcAtDetection,
    athMc,
    mcGainSinceDetection,
    athMcGain,
  };
}

/** Prefer MC gain (desk + live overlay); fall back to price gain. */
export function effectivePumpGain(scan: {
  mcAtDetection?: number | null;
  mcGainSinceDetection?: number | null;
  gainSinceDetection?: number | null;
}): number {
  if ((scan.mcAtDetection ?? 0) > 0 && scan.mcGainSinceDetection != null) {
    return scan.mcGainSinceDetection;
  }
  return scan.gainSinceDetection ?? 0;
}

export function effectivePumpAthGain(scan: {
  mcAtDetection?: number | null;
  athMcGain?: number | null;
  athGain?: number | null;
}): number {
  if ((scan.mcAtDetection ?? 0) > 0 && scan.athMcGain != null) {
    return scan.athMcGain;
  }
  return scan.athGain ?? 0;
}

export type PumpFilterId =
  | "all" | "top" | "intra" | "buy" | "watch"
  | "micro" | "new" | "volume" | "dev" | "gained";

export type PumpSortId =
  | "score" | "gain_now" | "ath_gain" | "volume"
  | "price_change" | "newest" | "oldest_detect" | "txns";

function hasDevKeyword(name?: string | null, symbol?: string | null): boolean {
  const combined = `${name || ""} ${symbol || ""}`.toLowerCase();
  return PUMP_DEV_KEYWORDS.some((kw) => combined.includes(kw));
}

/** Filter + sort parity with pump-fullend FilterBar.applyFilters */
export function applyPumpDeskFilters<T extends {
  name?: string | null;
  symbol?: string | null;
  pumpScore: number | null;
  pumpGrade: PumpGrade | null;
  pumpBuySignal: PumpBuyLevel | null;
  pumpIntraSignal: PumpIntraLevel | null;
  pumpTags: PumpSignalTag[];
  pumpMarketCap?: number | null;
  pumpLiquidityUsd?: number | null;
  pumpVolume24h?: number | null;
  pumpTxns24h?: number | null;
  pumpPairCreatedAt?: number | null;
  pumpPriceChange24h?: number | null;
  pumpGainSinceDetection?: number | null;
  pumpAthGain?: number | null;
  pumpDetectedAt?: number | null;
  pumpSocialSignal?: number | null;
}>(
  cards: T[],
  filter: PumpFilterId,
  sort: PumpSortId,
  minScore: number,
  opts?: { maxPairAgeMin?: number; maxDetectAgeMin?: number },
): T[] {
  const now = Date.now();
  let filtered = cards.filter((c) => (c.pumpScore ?? 0) >= minScore);

  const maxPair = opts?.maxPairAgeMin;
  if (maxPair != null && maxPair > 0) {
    const cutoff = now - maxPair * 60_000;
    filtered = filtered.filter((c) => (c.pumpPairCreatedAt ?? 0) >= cutoff);
  }
  const maxDetect = opts?.maxDetectAgeMin;
  if (maxDetect != null && maxDetect > 0) {
    const cutoff = now - maxDetect * 60_000;
    filtered = filtered.filter((c) => (c.pumpDetectedAt ?? 0) >= cutoff);
  }

  switch (filter) {
    case "intra":
      filtered = filtered.filter((c) =>
        c.pumpIntraSignal === "INTRA_NOW" || c.pumpIntraSignal === "INTRA_SOON");
      break;
    case "top":
      filtered = filtered.filter((c) => c.pumpGrade === "S" || c.pumpGrade === "A");
      break;
    case "buy":
      filtered = filtered.filter((c) => c.pumpBuySignal === "STRONG_BUY");
      break;
    case "watch":
      filtered = filtered.filter((c) => c.pumpBuySignal === "WATCH");
      break;
    case "micro":
      filtered = filtered.filter((c) => {
        const mcap = c.pumpMarketCap ?? 0;
        return mcap > 0 && mcap < 50_000 && (c.pumpLiquidityUsd ?? 0) >= 3_000;
      });
      break;
    case "new": {
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;
      filtered = filtered.filter((c) => (c.pumpPairCreatedAt ?? 0) > twoHoursAgo);
      break;
    }
    case "volume":
      filtered = filtered.filter((c) => (c.pumpVolume24h ?? 0) >= 50_000);
      break;
    case "dev":
      filtered = filtered.filter((c) =>
        hasDevKeyword(c.name, c.symbol)
        || (c.pumpSocialSignal ?? 0) >= 4);
      break;
    case "gained":
      filtered = filtered.filter((c) => (c.pumpGainSinceDetection ?? 0) >= 50);
      break;
    default:
      break;
  }

  const sorted = [...filtered];
  switch (sort) {
    case "gain_now":
      sorted.sort((a, b) => (b.pumpGainSinceDetection ?? 0) - (a.pumpGainSinceDetection ?? 0));
      break;
    case "ath_gain":
      sorted.sort((a, b) => (b.pumpAthGain ?? 0) - (a.pumpAthGain ?? 0));
      break;
    case "volume":
      sorted.sort((a, b) => (b.pumpVolume24h ?? 0) - (a.pumpVolume24h ?? 0));
      break;
    case "price_change":
      sorted.sort((a, b) => (b.pumpPriceChange24h ?? 0) - (a.pumpPriceChange24h ?? 0));
      break;
    case "newest":
      sorted.sort((a, b) => (b.pumpPairCreatedAt ?? 0) - (a.pumpPairCreatedAt ?? 0));
      break;
    case "oldest_detect":
      sorted.sort((a, b) => (a.pumpDetectedAt ?? Infinity) - (b.pumpDetectedAt ?? Infinity));
      break;
    case "txns":
      sorted.sort((a, b) => (b.pumpTxns24h ?? 0) - (a.pumpTxns24h ?? 0));
      break;
    case "score":
    default:
      sorted.sort((a, b) => (b.pumpScore ?? 0) - (a.pumpScore ?? 0));
      break;
  }
  return sorted;
}

export function parsePumpScan(raw: unknown): PumpScanPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const grade = String(o.grade ?? "");
  if (!["S", "A", "B", "C", "D"].includes(grade)) return null;
  const score = Number(o.score);
  if (!Number.isFinite(score)) return null;
  const num = (k: string, d = 0) => {
    const n = Number(o[k]);
    return Number.isFinite(n) ? n : d;
  };
  const conds = (k: string) =>
    Array.isArray(o[k])
      ? (o[k] as Array<{ id?: string; label?: string; pass?: boolean }>)
        .filter((c) => c && typeof c.label === "string")
        .map((c) => ({
          id: String(c.id ?? ""),
          label: String(c.label),
          pass: Boolean(c.pass),
        }))
      : [];

  // Never invent detectedAt as Date.now() — that corrupts sticky anchors
  const detectedAt = num("detectedAt", 0);
  const priceAtDetection = num("priceAtDetection");
  const mcAtDetection = num("mcAtDetection");
  const athPrice = num("athPrice");
  const athMc = num("athMc");
  const gainSinceDetection = num("gainSinceDetection");
  const athGain = num("athGain");
  let mcGainSinceDetection = num("mcGainSinceDetection");
  let athMcGain = num("athMcGain");
  // Backfill MC gains for older payloads that only had price gains
  if (mcAtDetection > 0 && mcGainSinceDetection === 0 && num("marketCap") > 0) {
    mcGainSinceDetection = pctGain(mcAtDetection, num("marketCap"));
  }
  if (mcAtDetection > 0 && athMcGain === 0 && athMc > 0) {
    athMcGain = pctGain(mcAtDetection, athMc);
  }

  return {
    score,
    grade: grade as PumpGrade,
    recommendation: String(o.recommendation ?? ""),
    scores: (o.scores as PumpScoreBreakdown) ?? {
      graduationSpeed: 0, volumeVelocity: 0, priceMultiple: 0, buyPressure: 0,
      liquidityDepth: 0, txFrequency: 0, vlEfficiency: 0, socialSignal: 0, earlyExplosionIndex: 0,
    },
    tags: Array.isArray(o.tags)
      ? (o.tags as PumpSignalTag[]).filter((t) => t && typeof t.label === "string")
      : [],
    buySignal: o.buySignal === "STRONG_BUY" || o.buySignal === "WATCH"
      ? o.buySignal
      : null,
    intraSignal: o.intraSignal === "INTRA_NOW" || o.intraSignal === "INTRA_SOON"
      ? o.intraSignal
      : null,
    buyPassCount: num("buyPassCount"),
    intraPassCount: num("intraPassCount"),
    buyFiredAt: num("buyFiredAt") || null,
    intraFiredAt: num("intraFiredAt") || null,
    buyConditions: conds("buyConditions"),
    intraConditions: conds("intraConditions"),
    pairAddress: o.pairAddress != null ? String(o.pairAddress) : null,
    dexId: o.dexId != null ? String(o.dexId) : null,
    scannedAt: o.scannedAt != null ? String(o.scannedAt) : new Date(0).toISOString(),
    source: "token_buys",
    marketCap: num("marketCap"),
    liquidityUsd: num("liquidityUsd"),
    volume24h: num("volume24h"),
    volume1h: num("volume1h"),
    txns24h: num("txns24h"),
    pairCreatedAt: o.pairCreatedAt != null && Number.isFinite(Number(o.pairCreatedAt))
      ? Number(o.pairCreatedAt)
      : null,
    priceChange24h: num("priceChange24h"),
    priceUsd: num("priceUsd"),
    freshnessMultiplier: num("freshnessMultiplier", 1),
    socialSignal: num("socialSignal"),
    detectedAt,
    priceAtDetection,
    athPrice,
    athAt: num("athAt", detectedAt),
    gainSinceDetection,
    athGain,
    mcAtDetection,
    athMc,
    mcGainSinceDetection,
    athMcGain,
  };
}
