/**
 * Intelligence Engine
 *
 * Computes a master intelligence score (0–100) for every tracked token by
 * blending five signal components drawn from DexScreener market data, GMGN
 * holder data, and wallet-buy history.
 *
 * Signal weights:
 *   35% MC Growth        — sustained market-cap growth from first snapshot
 *   25% Volume Intensity — real 24h volume vs age-cohort average
 *   20% Holder Velocity  — new holders per hour from snapshot diffs
 *   12% KOL / Smart      — quality-weighted smart-money signal
 *    8% Liquidity Health  — LP stability / adequate depth
 *
 * Periodic refresh runs every 5 minutes after the previous pass completes.
 */

import { db } from "@workspace/db";
import {
  tracked_tokens,
  token_price_snapshots,
  token_holder_snapshots,
  token_buys,
  walletdatasource,
  token_intel_log,
} from "@workspace/db";
import { eq, and, gte, lt, sql, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { healthMonitor } from "./health-monitor";
import { eventBus } from "./event-bus";
import { computeCompositeScore, type RawSignal } from "../lib/scoring-engine";

const log = logger.child({ module: "intelligence-engine" });

// ── Constants ──────────────────────────────────────────────────────────────────

const WEIGHTS = {
  mcGrowth:     0.27,  // reduced from 0.30 — sheds 3 pts to fund KOL/Smart bump
  volume:       0.25,
  holderVel:    0.22,  // strong leading indicator
  kolSmart:     0.18,  // increased from 0.15 — KOL/smart signal is high conviction
  liquidity:    0.08,
} as const;

const GRADUATION_SCORE_THRESHOLD = 55;
const GRADUATION_POSITIVE_SIGNALS = 3;
const GRADUATION_CONSECUTIVE = 3;
const SIGNAL_POSITIVE_FLOOR = 40;
const PRUNE_OLDER_THAN_MS = 48 * 60 * 60 * 1000;

const graduationPending = new Map<number, number>();
const lastLoggedScore   = new Map<number, number>();

// ── Helpers ────────────────────────────────────────────────────────────────────

function clamp(v: number, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, v)); }
function r1(v: number) { return Math.round(v * 10) / 10; }

function calcAgeMultiplier(firstDetectedAt: Date): number {
  const hrs = (Date.now() - firstDetectedAt.getTime()) / 3_600_000;
  if (hrs < 2)  return 1.30;
  if (hrs < 7)  return 1.00;
  if (hrs < 24) return 0.97;
  if (hrs < 48) return 0.92;
  return 0.82;
}

// ── 1. MC Growth Score ────────────────────────────────────────────────────────

function computeMcGrowthScore(
  snapshots: Array<{ marketCapUsd: string | null; snapshotAt: Date }>,
  currentMcUsd: string | null,
  peakMcUsd: number | null,
): number {
  if (!currentMcUsd) return 20;
  const currentMc = parseFloat(currentMcUsd);
  if (!isFinite(currentMc) || currentMc <= 0) return 20;

  if (peakMcUsd && peakMcUsd > 0) {
    const drawdown = (peakMcUsd - currentMc) / peakMcUsd;
    if (drawdown > 0.70) return 5;
    if (drawdown > 0.50) return 15;
  }

  const oneHourAgo  = Date.now() - 60 * 60 * 1000;
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const refSnap = snapshots.find(s =>
    s.snapshotAt.getTime() <= oneHourAgo && s.snapshotAt.getTime() >= twoHoursAgo && s.marketCapUsd,
  ) ?? snapshots[snapshots.length - 1];

  if (!refSnap?.marketCapUsd) return 30;
  const refMc = parseFloat(refSnap.marketCapUsd);
  if (!isFinite(refMc) || refMc <= 0) return 30;

  const growthPct = ((currentMc - refMc) / refMc) * 100;
  if (growthPct >= 100) return 100;
  if (growthPct >= 50)  return 85 + ((growthPct - 50) / 50) * 15;
  if (growthPct >= 20)  return 65 + ((growthPct - 20) / 30) * 20;
  if (growthPct >= 5)   return 50 + ((growthPct - 5)  / 15) * 15;
  if (growthPct >= -5)  return 40 + ((growthPct + 5)  / 10) * 10;
  if (growthPct >= -20) return 20 + ((growthPct + 20) / 15) * 20;
  if (growthPct >= -50) return 5  + ((growthPct + 50) / 30) * 15;
  return 5;
}

// ── 2. Volume Intensity Score ─────────────────────────────────────────────────

function computeVolumeScore(
  volume24hUsd: string | null,
  cohortVolumes: number[],
): { score: number; percentile: number } {
  if (!volume24hUsd) return { score: 20, percentile: 0 };
  const vol = parseFloat(volume24hUsd);
  if (!isFinite(vol) || vol <= 0) return { score: 20, percentile: 0 };
  if (cohortVolumes.length === 0) return { score: 40, percentile: 0.5 };

  const sorted = [...cohortVolumes].sort((a, b) => a - b);
  const rank = sorted.filter(v => v <= vol).length;
  const percentile = rank / sorted.length;

  let score: number;
  if (percentile >= 0.90) score = 100;
  else if (percentile >= 0.70) score = 75 + (percentile - 0.70) / 0.20 * 25;
  else if (percentile >= 0.50) score = 55 + (percentile - 0.50) / 0.20 * 20;
  else if (percentile >= 0.30) score = 35 + (percentile - 0.30) / 0.20 * 20;
  else score = 15 + percentile / 0.30 * 20;

  return { score, percentile };
}

// ── 3. Holder Velocity Score ──────────────────────────────────────────────────

function computeHolderVelocityScore(
  holderSnapshots: Array<{ holderCount: number | null; snapshotAt: Date }>,
  currentHolderCount: number,
  allVelocities: number[],
): { score: number; velocityPerHour: number } {
  let newHoldersPerHour = 0;

  if (holderSnapshots.length >= 2) {
    const [latest, prev] = holderSnapshots;
    const deltaCnt  = (latest.holderCount ?? 0) - (prev.holderCount ?? 0);
    const deltaHrs  = Math.max(
      (latest.snapshotAt.getTime() - prev.snapshotAt.getTime()) / 3_600_000,
      0.01,
    );
    newHoldersPerHour = Math.max(0, deltaCnt / deltaHrs);
  } else if (currentHolderCount > 0) {
    return { score: clamp(30 + Math.min(currentHolderCount / 2, 20)), velocityPerHour: 0 };
  }

  let score: number;
  if (allVelocities.length === 0) {
    if (newHoldersPerHour >= 100) score = 100;
    else if (newHoldersPerHour >= 50) score = 80;
    else if (newHoldersPerHour >= 20) score = 60;
    else if (newHoldersPerHour >= 5)  score = 40;
    else if (newHoldersPerHour > 0)   score = 25;
    else score = 10;
  } else {
    const sorted = [...allVelocities].sort((a, b) => a - b);
    const rank = sorted.filter(v => v <= newHoldersPerHour).length;
    score = clamp(10 + (rank / sorted.length) * 90);
  }
  return { score, velocityPerHour: newHoldersPerHour };
}

// ── 4. KOL / Smart Signal Score ───────────────────────────────────────────────
// Two sources of KOL/smart signal, takes the higher of both:
//
//  A) GMGN holder classification — density of KOL + smart holders vs total.
//     kolWeight   = (kolCount  / total) * 100 * 2.5  (capped at 100)
//     smartWeight = (smartCount / total) * 100 * 2.0  (capped at 100)
//
//  B) Tracked wallet buys — any wallet in walletdatasource that bought is a
//     high-conviction signal regardless of label. Score = distinctCount * 25
//     (1 wallet = 25, 2 = 50, 3 = 75, 4+ = 100).
//
// Using max() means GMGN data takes over when available, but tracked wallet
// buys provide a reliable fallback when GMGN holder data hasn't arrived yet.

function computeKolSmartScore(
  holderKolCount:        number,
  holderSmartCount:      number,
  holderCount:           number,
  distinctTrackedWallets = 0,
): number {
  // Source A: GMGN holder classification
  const gmgnScore = holderCount > 0
    ? (holderKolCount / holderCount) * 100 * 2.5 + (holderSmartCount / holderCount) * 100 * 2.0
    : 0;
  // Source B: tracked wallet buys (each distinct wallet = 25 pts, cap 100)
  const trackedScore = Math.min(100, distinctTrackedWallets * 25);
  return clamp(Math.round(Math.max(gmgnScore, trackedScore)));
}

// ── Quality label from final score ────────────────────────────────────────────

function computeQualityLabel(score: number): string {
  if (score >= 82) return "Elite";
  if (score >= 72) return "Excellent";
  if (score >= 62) return "Strong";
  if (score >= 52) return "Good";
  if (score >= 40) return "Average";
  if (score >= 25) return "Speculative";
  return "Weak";
}

// ── 5. Liquidity Health Score ─────────────────────────────────────────────────

function computeLiquidityHealthScore(
  liquidityUsd: string | null,
  lowLiquidityFlag: boolean,
  snapshots: Array<{ liquidityUsd: string | null; snapshotAt: Date }>,
): number {
  if (!liquidityUsd) return 20;
  const liq = parseFloat(liquidityUsd);
  if (!isFinite(liq) || liq <= 0) return 20;
  if (lowLiquidityFlag || liq < 5_000) return 10;

  let base: number;
  if (liq >= 500_000) base = 95;
  else if (liq >= 100_000) base = 80 + ((liq - 100_000) / 400_000) * 15;
  else if (liq >= 50_000)  base = 65 + ((liq - 50_000)  / 50_000)  * 15;
  else if (liq >= 20_000)  base = 50 + ((liq - 20_000)  / 30_000)  * 15;
  else if (liq >= 10_000)  base = 35 + ((liq - 10_000)  / 10_000)  * 15;
  else base = 20 + (liq / 10_000) * 15;

  const recentLiqs = snapshots
    .slice(0, 3)
    .map(s => (s.liquidityUsd ? parseFloat(s.liquidityUsd) : null))
    .filter((v): v is number => v !== null && isFinite(v) && v > 0);

  if (recentLiqs.length >= 2) {
    const oldest = recentLiqs[recentLiqs.length - 1];
    const newest = recentLiqs[0];
    const liqChange = (newest - oldest) / oldest;
    if (liqChange > 0.10)  base = clamp(base + 8);
    if (liqChange < -0.20) base = clamp(base - 15);
    if (liqChange < -0.40) base = clamp(base - 25);
  }
  return clamp(base);
}

// ── Batch computation ──────────────────────────────────────────────────────────

export async function refreshAllIntelligence(): Promise<void> {
  const t0 = Date.now();
  try {
    const pruneTs = new Date(Date.now() - PRUNE_OLDER_THAN_MS);
    await db.delete(token_price_snapshots).where(lt(token_price_snapshots.snapshotAt, pruneTs));

    const tokens = await db.select({
      id:                tracked_tokens.id,
      address:           tracked_tokens.address,
      status:            tracked_tokens.status,
      firstDetectedAt:   tracked_tokens.firstDetectedAt,
      marketCapUsd:      tracked_tokens.marketCapUsd,
      volume24hUsd:      tracked_tokens.volume24hUsd,
      liquidityUsd:      tracked_tokens.liquidityUsd,
      holderCount:       tracked_tokens.holderCount,
      holderKolCount:    tracked_tokens.holderKolCount,
      holderSmartCount:  tracked_tokens.holderSmartCount,
      holderTop10Pct:    tracked_tokens.holderTop10Pct,
      lowLiquidityFlag:  tracked_tokens.lowLiquidityFlag,
      peakMcUsd:         tracked_tokens.peakMcUsd,
      athMarketCapUsd:   tracked_tokens.athMarketCapUsd,
      intelligenceScore: tracked_tokens.intelligenceScore,
      gainPct:           tracked_tokens.gainPct,
      athGainPct:        tracked_tokens.athGainPct,
    }).from(tracked_tokens);

    if (tokens.length === 0) return;

    const tokenIds = tokens.map(t => t.id);

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const priceSnaps = await db.select({
      tokenId:      token_price_snapshots.tokenId,
      snapshotAt:   token_price_snapshots.snapshotAt,
      marketCapUsd: token_price_snapshots.marketCapUsd,
      liquidityUsd: token_price_snapshots.liquidityUsd,
    }).from(token_price_snapshots)
      .where(and(
        inArray(token_price_snapshots.tokenId, tokenIds),
        gte(token_price_snapshots.snapshotAt, twoHoursAgo),
      ))
      .orderBy(sql`snapshot_at DESC`);

    const snapsByToken = new Map<number, typeof priceSnaps>();
    for (const s of priceSnaps) {
      if (!snapsByToken.has(s.tokenId)) snapsByToken.set(s.tokenId, []);
      snapsByToken.get(s.tokenId)!.push(s);
    }

    const holderSnaps = await db.select({
      tokenId:     token_holder_snapshots.tokenId,
      holderCount: token_holder_snapshots.holderCount,
      snapshotAt:  token_holder_snapshots.snapshotAt,
    }).from(token_holder_snapshots)
      .where(inArray(token_holder_snapshots.tokenId, tokenIds))
      .orderBy(sql`snapshot_at DESC`)
      .limit(tokenIds.length * 2);

    const holderSnapsByToken = new Map<number, typeof holderSnaps>();
    for (const s of holderSnaps) {
      if (!holderSnapsByToken.has(s.tokenId)) holderSnapsByToken.set(s.tokenId, []);
      if ((holderSnapsByToken.get(s.tokenId)?.length ?? 0) < 2) {
        holderSnapsByToken.get(s.tokenId)!.push(s);
      }
    }

    // ALL wallets in walletdatasource are treated as KOL/smart — they were
    // specifically added to the tracking list, which is itself a conviction signal.
    // The old /smart|kol|whale/i label regex excluded wallets like v1/v2/v3/deepents
    // that are legitimate tracked wallets and should count as smart-money signals.
    const labeledWallets = await db.select({ id: walletdatasource.id, label: walletdatasource.label }).from(walletdatasource);
    const smartWalletIds = new Set(labeledWallets.map(w => w.id));

    const allBuys = await db.select({ tokenId: token_buys.tokenId, walletId: token_buys.walletId })
      .from(token_buys).where(inArray(token_buys.tokenId, tokenIds));

    const totalBuysByToken     = new Map<number, number>();
    const smartBuysByToken     = new Map<number, number>();
    // Track distinct wallet IDs per token so the kol_smart_score uses conviction
    // count rather than raw transaction count (3 wallets each buying once = 3,
    // not 3 × transaction count).
    const distinctSmartWalletsByToken = new Map<number, Set<number>>();
    for (const b of allBuys) {
      totalBuysByToken.set(b.tokenId, (totalBuysByToken.get(b.tokenId) ?? 0) + 1);
      if (smartWalletIds.has(b.walletId)) {
        smartBuysByToken.set(b.tokenId, (smartBuysByToken.get(b.tokenId) ?? 0) + 1);
        if (!distinctSmartWalletsByToken.has(b.tokenId)) {
          distinctSmartWalletsByToken.set(b.tokenId, new Set());
        }
        distinctSmartWalletsByToken.get(b.tokenId)!.add(b.walletId);
      }
    }

    type AgeGroup = "new" | "young" | "mature";
    const ageGroup = (d: Date): AgeGroup => {
      const hrs = (Date.now() - d.getTime()) / 3_600_000;
      if (hrs < 2) return "new";
      if (hrs < 24) return "young";
      return "mature";
    };

    const cohortVolumes:    Record<AgeGroup, number[]> = { new: [], young: [], mature: [] };
    const cohortVelocities: Record<AgeGroup, number[]> = { new: [], young: [], mature: [] };
    const tokenRaws: Array<{ token: typeof tokens[number]; rawVol: number; rawVelocity: number; group: AgeGroup }> = [];

    for (const t of tokens) {
      const group = ageGroup(t.firstDetectedAt);
      const vol   = t.volume24hUsd ? parseFloat(t.volume24hUsd) : 0;
      const hSnaps = holderSnapsByToken.get(t.id) ?? [];
      let vel = 0;
      if (hSnaps.length >= 2) {
        const [latest, prev] = hSnaps;
        const deltaCnt = (latest.holderCount ?? 0) - (prev.holderCount ?? 0);
        const deltaHrs = Math.max((latest.snapshotAt.getTime() - prev.snapshotAt.getTime()) / 3_600_000, 0.01);
        vel = Math.max(0, deltaCnt / deltaHrs);
      }
      cohortVolumes[group].push(vol);
      cohortVelocities[group].push(vel);
      tokenRaws.push({ token: t, rawVol: vol, rawVelocity: vel, group });
    }

    const logEntries: (typeof token_intel_log.$inferInsert)[] = [];

    for (const { token: t, rawVelocity, group } of tokenRaws) {
      const pSnaps    = snapsByToken.get(t.id) ?? [];
      const hSnaps    = holderSnapsByToken.get(t.id) ?? [];
      const totalBuys = totalBuysByToken.get(t.id) ?? 0;
      const smartBuys = smartBuysByToken.get(t.id) ?? 0;
      const labeledFraction = totalBuys > 0 ? smartBuys / totalBuys : 0;

      const currentMcNum = t.marketCapUsd ? parseFloat(t.marketCapUsd) : 0;
      const prevPeak     = t.peakMcUsd ?? (t.athMarketCapUsd ? parseFloat(t.athMarketCapUsd) : 0);
      const newPeak      = Math.max(prevPeak, currentMcNum > 0 ? currentMcNum : 0) || null;

      const mcGrowthScore         = r1(clamp(computeMcGrowthScore(pSnaps, t.marketCapUsd, newPeak)));
      const volResult             = computeVolumeScore(t.volume24hUsd, cohortVolumes[group]);
      const volumeIntensityScore  = r1(clamp(volResult.score));
      const holderVelResult       = computeHolderVelocityScore(hSnaps, t.holderCount, cohortVelocities[group]);
      const holderVelocityScore   = r1(clamp(holderVelResult.score));
      const distinctTracked       = distinctSmartWalletsByToken.get(t.id)?.size ?? 0;
      const kolSmartScore         = r1(clamp(computeKolSmartScore(t.holderKolCount, t.holderSmartCount, t.holderCount, distinctTracked)));
      const liquidityHealthScore  = r1(clamp(computeLiquidityHealthScore(t.liquidityUsd, t.lowLiquidityFlag, pSnaps)));

      const ageHrs  = (Date.now() - t.firstDetectedAt.getTime()) / 3_600_000;
      const ageMult = calcAgeMultiplier(t.firstDetectedAt);

      const rawMaster =
        WEIGHTS.mcGrowth  * mcGrowthScore +
        WEIGHTS.volume    * volumeIntensityScore +
        WEIGHTS.holderVel * holderVelocityScore +
        WEIGHTS.kolSmart  * kolSmartScore +
        WEIGHTS.liquidity * liquidityHealthScore;

      // Apply age multiplier then quality risk/bonus adjustments
      let rawScore = rawMaster * ageMult;

      // ── Risk penalties ──────────────────────────────────────────────────────
      // holderTop10Pct is stored 0–100; spec thresholds are 0–1 (multiply by 100)
      const top10Frac = (t.holderTop10Pct ?? 0) / 100;
      if      (top10Frac > 0.78) rawScore -= 28;
      else if (top10Frac > 0.68) rawScore -= 18;
      else if (top10Frac > 0.58) rawScore -= 8;

      // Micro-cap penalty: tokens under $5k market cap are highly speculative
      const mcUsdNum = t.marketCapUsd ? parseFloat(t.marketCapUsd) : 0;
      if (mcUsdNum > 0 && mcUsdNum < 5_000) rawScore -= 10;

      // Post-peak distribution penalty: large drawdown from peak often means selling
      // pressure masquerading as high volume. Softened if token is still well up from
      // detection entry (a 280X that corrected 60% is healthier than a 1.2X that did).
      if (newPeak && newPeak > 0 && currentMcNum > 0) {
        const peakDrawdown = (newPeak - currentMcNum) / newPeak;
        if (peakDrawdown > 0.60) {
          // currentGainFactor: how many X is the token still up from entry (1 = flat)
          const currentGainFactor = t.gainPct != null ? (t.gainPct / 100) + 1 : 1;
          // Soften penalty proportionally: a 100X+ winner gets up to 50% reduction
          const softener = Math.min(0.5, Math.log10(Math.max(1, currentGainFactor)) / 4);
          rawScore -= Math.round(12 * (1 - softener)); // 6–12 pts depending on entry gain
        } else if (peakDrawdown > 0.40) {
          rawScore -= 5; // moderate correction — mild penalty
        }
      }

      // ── Bonuses ─────────────────────────────────────────────────────────────
      if ((t.holderCount ?? 0) > 75) rawScore += 9;
      if (kolSmartScore > 85)         rawScore += 6;
      if (volumeIntensityScore > 90 && mcGrowthScore > 85) rawScore += 7;

      const intelligenceScore = r1(clamp(rawScore));
      const qualityLabel      = computeQualityLabel(intelligenceScore);

      const subScoresAboveFloor = [mcGrowthScore, volumeIntensityScore, holderVelocityScore, kolSmartScore, liquidityHealthScore]
        .filter(s => s >= SIGNAL_POSITIVE_FLOOR).length;
      const graduationThresholdMet =
        intelligenceScore >= GRADUATION_SCORE_THRESHOLD &&
        subScoresAboveFloor >= GRADUATION_POSITIVE_SIGNALS;

      let newConsecutive = t.status === "new" ? (
        graduationThresholdMet ? (graduationPending.get(t.id) ?? 0) + 1 : 0
      ) : 0;

      let statusOverride: string | undefined;
      if (t.status === "new" && newConsecutive >= GRADUATION_CONSECUTIVE) {
        statusOverride = "active";
        newConsecutive = 0;
        graduationPending.delete(t.id);
        log.info({ tokenId: t.id, intelligenceScore }, "Token graduated to active via intelligence score");
        eventBus.emit("price:updated", {
          tokenId: t.id, tokenAddress: "", chain: "",
          priceUsd: "", marketCapUsd: t.marketCapUsd ?? null, athPriceUsd: "",
        });
      } else if (t.status === "new") {
        if (newConsecutive > 0) graduationPending.set(t.id, newConsecutive);
        else graduationPending.delete(t.id);
      }

      const prevScore       = lastLoggedScore.get(t.id);
      const statusAfter     = statusOverride ?? t.status;
      const statusChanged   = statusAfter !== t.status;
      const scoreDelta      = prevScore === undefined ? null : Math.abs(intelligenceScore - prevScore);
      const isFirst         = prevScore === undefined;
      const scoreChangedEnough = scoreDelta !== null && scoreDelta >= 1.0;

      if (isFirst || scoreChangedEnough || statusChanged) {
        const trigger = isFirst ? "first" : statusChanged ? "status_change" : "score_change";
        logEntries.push({
          tokenId: t.id, tokenAddress: t.address, computedAt: new Date(),
          intelligenceScore, prevIntelligenceScore: prevScore ?? null,
          mcGrowthScore, volumeIntensityScore, holderVelocityScore, kolSmartScore, liquidityHealthScore,
          ageMultiplier: ageMult, tokenAgeHours: r1(ageHrs),
          marketCapUsd: t.marketCapUsd, volume24hUsd: t.volume24hUsd, liquidityUsd: t.liquidityUsd, peakMcUsd: newPeak,
          // Use effectiveKolCount so the pro-scanner (which checks holder_kol_count >= 1)
          // can see the signal from tracked wallet buys even before GMGN holder data arrives.
          holderCount: t.holderCount,
          holderKolCount: Math.max(t.holderKolCount ?? 0, distinctTracked),
          holderSmartCount: t.holderSmartCount,
          totalBuys, smartBuys, labeledFraction: r1(labeledFraction),
          ageGroup: group, cohortSize: cohortVolumes[group].length,
          cohortVolumePercentile: r1(volResult.percentile), holderVelocityPerHour: r1(holderVelResult.velocityPerHour),
          graduationConsecutive: newConsecutive, graduationThresholdMet,
          statusBefore: t.status, statusAfter, statusChanged, trigger,
        });
        lastLoggedScore.set(t.id, intelligenceScore);
        log.info({ tokenId: t.id, trigger, intelligenceScore, prev: prevScore ?? null, ageMult, statusBefore: t.status, statusAfter }, "Intel score log entry");
      }

      // ── Composite score (holder-velocity-dominant, from scoringEngine.ts) ──
      const rawSignal: RawSignal = {
        tokenAddress:    t.address,
        mcGrowth:        mcGrowthScore,
        volIntensity:    volumeIntensityScore,
        holderVelocity:  holderVelocityScore,
        kolSmart:        kolSmartScore,
        liquidityHealth: liquidityHealthScore,
        ageMultiplier:   ageMult,
        ageHours:        r1(ageHrs),
        holderCount:     t.holderCount,
        holderKolCount:  t.holderKolCount,
        holderSmartCount: t.holderSmartCount,
        totalBuys,
        smartBuys,
        labeledFraction: r1(labeledFraction),
        marketCapUsd:    currentMcNum,
        volume24hUsd:    t.volume24hUsd ? parseFloat(t.volume24hUsd) : 0,
        liquidityUsd:    t.liquidityUsd ? parseFloat(t.liquidityUsd) : 0,
      };
      const compositeResult = computeCompositeScore(rawSignal);

      await db.update(tracked_tokens).set({
        intelligenceScore, qualityLabel,
        mcGrowthScore, volumeIntensityScore, holderVelocityScore,
        kolSmartScore, liquidityHealthScore, intelligenceUpdatedAt: new Date(),
        consecutivePositiveChecks: newConsecutive, peakMcUsd: newPeak ?? undefined,
        compositeScore:    compositeResult.compositeScore,
        compositeFactors:  compositeResult.factors,
        compositeUpdatedAt: new Date(),
        ...(statusOverride ? { status: statusOverride, lastStatusChangeAt: new Date() } : {}),
      }).where(eq(tracked_tokens.id, t.id));
    }

    if (logEntries.length > 0) {
      await db.insert(token_intel_log).values(logEntries);
      log.debug({ count: logEntries.length }, "Intel log entries written");
    }

    healthMonitor.ok("intelligence-engine", Date.now() - t0);
    log.debug({ count: tokens.length, ms: Date.now() - t0 }, "Intelligence refresh complete");
  } catch (err) {
    healthMonitor.error("intelligence-engine", err);
    log.warn({ err }, "Intelligence refresh failed");
  }
}

/**
 * Start the intelligence engine.
 * Periodic refresh runs every 5 minutes after the previous pass completes (no overlap).
 */
export function startIntelligenceEngine() {
  const loop = () => {
    refreshAllIntelligence()
      .catch(err => logger.warn({ err }, "Intelligence refresh failed"))
      .finally(() => setTimeout(loop, 300_000));
  };
  setTimeout(loop, 300_000);
  logger.info(
    `Intelligence engine ready (5 min cycle) — weights: MC ${WEIGHTS.mcGrowth * 100}% | Vol ${WEIGHTS.volume * 100}% | HolderVel ${WEIGHTS.holderVel * 100}% | KOL/Smart ${WEIGHTS.kolSmart * 100}% | Liq ${WEIGHTS.liquidity * 100}%`,
  );
}
