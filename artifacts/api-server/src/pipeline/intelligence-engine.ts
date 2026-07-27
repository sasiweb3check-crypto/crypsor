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
 *   15% KOL / Smart      — quality-weighted smart-money signal
 *    5% Liquidity Health  — LP stability / adequate depth
 *
 * Age multipliers:
 *   < 2h  → ×1.30  (early momentum window)
 *   2–7h  → ×1.00
 *   > 24h → ×0.95
 *   > 48h → ×0.90
 *   > 7d  → ×0.80
 *
 * Graduation: a "new" token advances to "active" via the intelligence path
 * when intelligenceScore ≥ 55 AND ≥ 3/5 sub-scores are positive (≥ 40)
 * for THREE consecutive 5-minute checks, regardless of the MC threshold.
 *
 * Snapshot retention: token_price_snapshots older than 48 h are pruned here.
 *
 * Intel log: every run that moves the score by ≥ 1 point OR changes lifecycle
 * status writes a full-detail row to token_intel_log for auditability.
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

const log = logger.child({ module: "intelligence-engine" });

// ── Constants ──────────────────────────────────────────────────────────────────

const WEIGHTS = {
  mcGrowth:     0.35,
  volume:       0.25,
  holderVel:    0.20,
  kolSmart:     0.15,
  liquidity:    0.05,
} as const;

const GRADUATION_SCORE_THRESHOLD = 55;
const GRADUATION_POSITIVE_SIGNALS = 3;    // of 5 sub-scores must be ≥ 40
const GRADUATION_CONSECUTIVE = 3;         // consecutive checks required
const SIGNAL_POSITIVE_FLOOR = 40;         // sub-score threshold for "positive"

const PRUNE_OLDER_THAN_MS = 48 * 60 * 60 * 1000; // 48h retention

// In-memory graduation counters (mirrors lifecycle-engine's archivePending pattern)
const graduationPending = new Map<number, number>(); // tokenId → consecutive count

// In-memory cache of the last logged intel score per token (for delta detection)
const lastLoggedScore = new Map<number, number>(); // tokenId → last score written to log

// ── Helpers ────────────────────────────────────────────────────────────────────

function clamp(v: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

function r1(v: number) {
  return Math.round(v * 10) / 10;
}

function calcAgeMultiplier(firstDetectedAt: Date): number {
  const hrs = (Date.now() - firstDetectedAt.getTime()) / 3_600_000;
  if (hrs < 2)   return 1.30;
  if (hrs < 7)   return 1.00;
  if (hrs < 24)  return 0.97;
  if (hrs < 48)  return 0.92;
  return 0.82;   // > 7 days is handled by archive anyway
}

// ── 1. MC Growth Score (0–100) ────────────────────────────────────────────────
//
// Measures the trajectory of market cap from the oldest recent snapshot (up to
// 2 h ago) to now.  Rewards sustained growth; penalises dumps.

function computeMcGrowthScore(
  snapshots: Array<{ marketCapUsd: string | null; snapshotAt: Date }>,
  currentMcUsd: string | null,
  peakMcUsd: number | null,
): number {
  if (!currentMcUsd) return 20; // no price data yet → neutral-low

  const currentMc = parseFloat(currentMcUsd);
  if (!isFinite(currentMc) || currentMc <= 0) return 20;

  // Use peak to detect severe draw-down (zombie / rug indicator)
  if (peakMcUsd && peakMcUsd > 0) {
    const drawdown = (peakMcUsd - currentMc) / peakMcUsd;
    if (drawdown > 0.70) return 5;   // > 70% from peak → near zero
    if (drawdown > 0.50) return 15;
  }

  // Find a reference MC from ~1h ago (most representative growth window)
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

  const refSnap = snapshots.find(s =>
    s.snapshotAt.getTime() <= oneHourAgo && s.snapshotAt.getTime() >= twoHoursAgo && s.marketCapUsd,
  ) ?? snapshots[snapshots.length - 1]; // fallback: oldest

  if (!refSnap?.marketCapUsd) return 30;
  const refMc = parseFloat(refSnap.marketCapUsd);
  if (!isFinite(refMc) || refMc <= 0) return 30;

  const growthPct = ((currentMc - refMc) / refMc) * 100;

  // Map growth % to 0–100 score
  if (growthPct >= 100)  return 100;
  if (growthPct >= 50)   return 85 + ((growthPct - 50) / 50) * 15;
  if (growthPct >= 20)   return 65 + ((growthPct - 20) / 30) * 20;
  if (growthPct >= 5)    return 50 + ((growthPct - 5)  / 15) * 15;
  if (growthPct >= -5)   return 40 + ((growthPct + 5)  / 10) * 10;
  if (growthPct >= -20)  return 20 + ((growthPct + 20) / 15) * 20;
  if (growthPct >= -50)  return 5  + ((growthPct + 50) / 30) * 15;
  return 5;
}

// ── 2. Volume Intensity Score (0–100) ─────────────────────────────────────────
//
// Real DexScreener 24h volume normalised min-max across all tokens of the same
// age cohort (<2h, 2–24h, >24h).  Being in the top cohort-percentile signals
// healthy trading activity.

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
  const percentile = rank / sorted.length; // 0–1

  // Map percentile to score with a bonus for top 30%
  let score: number;
  if (percentile >= 0.90) score = 100;
  else if (percentile >= 0.70) score = 75 + (percentile - 0.70) / 0.20 * 25;
  else if (percentile >= 0.50) score = 55 + (percentile - 0.50) / 0.20 * 20;
  else if (percentile >= 0.30) score = 35 + (percentile - 0.30) / 0.20 * 20;
  else score = 15 + percentile / 0.30 * 20;

  return { score, percentile };
}

// ── 3. Holder Velocity Score (0–100) ──────────────────────────────────────────
//
// Computes new holders per hour by diffing the two most recent holder snapshots.
// Also uses the holderCount already stored on the token as a fallback.

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
    return {
      score: clamp(30 + Math.min(currentHolderCount / 2, 20)),
      velocityPerHour: 0,
    };
  }

  let score: number;
  if (allVelocities.length === 0) {
    // Absolute scale: > 50 new holders/hr is strong for low-cap memes
    if (newHoldersPerHour >= 100) score = 100;
    else if (newHoldersPerHour >= 50)  score = 80;
    else if (newHoldersPerHour >= 20)  score = 60;
    else if (newHoldersPerHour >= 5)   score = 40;
    else if (newHoldersPerHour > 0)    score = 25;
    else score = 10;
  } else {
    // Relative: percentile in current cohort
    const sorted = [...allVelocities].sort((a, b) => a - b);
    const rank = sorted.filter(v => v <= newHoldersPerHour).length;
    const pct  = rank / sorted.length;
    score = clamp(10 + pct * 90);
  }

  return { score, velocityPerHour: newHoldersPerHour };
}

// ── 4. KOL / Smart Signal Score (0–100) ───────────────────────────────────────
//
// Combines:
//   a) Raw KOL + smart-money holder counts as a fraction of total holders
//   b) Fraction of monitored wallet buys that came from labelled smart/KOL wallets
//
// NOTE: holderQualityScore / holderMomentumScore are NOT used — they are dummy
// values from an earlier pipeline phase and carry no signal.

function computeKolSmartScore(
  holderKolCount:     number,
  holderSmartCount:   number,
  holderCount:        number,
  labeledBuyFraction: number, // 0–1: labelled buy txns / total buy txns
): number {
  const base = Math.max(holderCount, 1);
  const density = (holderKolCount + holderSmartCount) / base; // 0–1
  // density contribution: 0–70 (raw counts, no quality multiplier)
  const densityScore = clamp(density * 300, 0, 70);
  // labeled buy contribution: 0–30
  const buyScore = clamp(labeledBuyFraction * 150, 0, 30);
  return clamp(densityScore + buyScore);
}

// ── 5. Liquidity Health Score (0–100) ─────────────────────────────────────────
//
// Rewards adequate and stable liquidity.  Uses the current value plus trend
// from recent snapshots.

function computeLiquidityHealthScore(
  liquidityUsd: string | null,
  lowLiquidityFlag: boolean,
  snapshots: Array<{ liquidityUsd: string | null; snapshotAt: Date }>,
): number {
  if (!liquidityUsd) return 20;
  const liq = parseFloat(liquidityUsd);
  if (!isFinite(liq) || liq <= 0) return 20;

  if (lowLiquidityFlag || liq < 5_000)  return 10;

  // Base score from absolute liquidity depth
  let base: number;
  if (liq >= 500_000) base = 95;
  else if (liq >= 100_000) base = 80 + ((liq - 100_000) / 400_000) * 15;
  else if (liq >= 50_000)  base = 65 + ((liq - 50_000)  / 50_000)  * 15;
  else if (liq >= 20_000)  base = 50 + ((liq - 20_000)  / 30_000)  * 15;
  else if (liq >= 10_000)  base = 35 + ((liq - 10_000)  / 10_000)  * 15;
  else base = 20 + (liq / 10_000) * 15;

  // Trend bonus/penalty from recent snapshots (last 3)
  const recentLiqs = snapshots
    .slice(0, 3)
    .map(s => (s.liquidityUsd ? parseFloat(s.liquidityUsd) : null))
    .filter((v): v is number => v !== null && isFinite(v) && v > 0);

  if (recentLiqs.length >= 2) {
    const oldest = recentLiqs[recentLiqs.length - 1];
    const newest = recentLiqs[0];
    const liqChange = (newest - oldest) / oldest;
    if (liqChange > 0.10)  base = clamp(base + 8);   // growing → bonus
    if (liqChange < -0.20) base = clamp(base - 15);  // big pull → penalty
    if (liqChange < -0.40) base = clamp(base - 25);  // major pull → red flag
  }

  return clamp(base);
}

// ── Batch computation ──────────────────────────────────────────────────────────

export async function refreshAllIntelligence(): Promise<void> {
  const t0 = Date.now();

  try {
    // ── Prune stale snapshots first ───────────────────────────────────────────
    const pruneTs = new Date(Date.now() - PRUNE_OLDER_THAN_MS);
    await db.delete(token_price_snapshots).where(
      lt(token_price_snapshots.snapshotAt, pruneTs),
    );

    // ── Load all tokens ───────────────────────────────────────────────────────
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
      lowLiquidityFlag:  tracked_tokens.lowLiquidityFlag,
      peakMcUsd:         tracked_tokens.peakMcUsd,
      athMarketCapUsd:   tracked_tokens.athMarketCapUsd,
      intelligenceScore: tracked_tokens.intelligenceScore,
    }).from(tracked_tokens);

    if (tokens.length === 0) return;

    const tokenIds = tokens.map(t => t.id);

    // ── Load recent price snapshots (last 2h, all tokens in one query) ────────
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const priceSnaps = await db.select({
      tokenId:      token_price_snapshots.tokenId,
      snapshotAt:   token_price_snapshots.snapshotAt,
      marketCapUsd: token_price_snapshots.marketCapUsd,
      liquidityUsd: token_price_snapshots.liquidityUsd,
    }).from(token_price_snapshots)
      .where(
        and(
          inArray(token_price_snapshots.tokenId, tokenIds),
          gte(token_price_snapshots.snapshotAt, twoHoursAgo),
        ),
      )
      .orderBy(sql`snapshot_at DESC`);

    // Group by tokenId
    const snapsByToken = new Map<number, typeof priceSnaps>();
    for (const s of priceSnaps) {
      if (!snapsByToken.has(s.tokenId)) snapsByToken.set(s.tokenId, []);
      snapsByToken.get(s.tokenId)!.push(s);
    }

    // ── Load 2 most recent holder snapshots per token ─────────────────────────
    const holderSnaps = await db.select({
      tokenId:     token_holder_snapshots.tokenId,
      holderCount: token_holder_snapshots.holderCount,
      snapshotAt:  token_holder_snapshots.snapshotAt,
    }).from(token_holder_snapshots)
      .where(inArray(token_holder_snapshots.tokenId, tokenIds))
      .orderBy(sql`snapshot_at DESC`)
      .limit(tokenIds.length * 2); // 2 per token approximate

    const holderSnapsByToken = new Map<number, typeof holderSnaps>();
    for (const s of holderSnaps) {
      if (!holderSnapsByToken.has(s.tokenId)) holderSnapsByToken.set(s.tokenId, []);
      if ((holderSnapsByToken.get(s.tokenId)?.length ?? 0) < 2) {
        holderSnapsByToken.get(s.tokenId)!.push(s);
      }
    }

    // ── Load labelled-wallet buy fractions ────────────────────────────────────
    // Fraction of buy transactions from wallets that are KOL / smart_money
    const labeledWallets = await db.select({
      id:    walletdatasource.id,
      label: walletdatasource.label,
    }).from(walletdatasource);

    const smartWalletIds = new Set(
      labeledWallets
        .filter(w => /smart|kol|whale/i.test(w.label ?? ""))
        .map(w => w.id),
    );

    // Total buys per token and smart buys per token
    const allBuys = await db.select({
      tokenId:  token_buys.tokenId,
      walletId: token_buys.walletId,
    }).from(token_buys)
      .where(inArray(token_buys.tokenId, tokenIds));

    const totalBuysByToken  = new Map<number, number>();
    const smartBuysByToken  = new Map<number, number>();
    for (const b of allBuys) {
      totalBuysByToken.set(b.tokenId, (totalBuysByToken.get(b.tokenId) ?? 0) + 1);
      if (smartWalletIds.has(b.walletId)) {
        smartBuysByToken.set(b.tokenId, (smartBuysByToken.get(b.tokenId) ?? 0) + 1);
      }
    }

    // ── Build age cohorts for volume normalisation ────────────────────────────
    type AgeGroup = "new" | "young" | "mature";
    const ageGroup = (firstDetectedAt: Date): AgeGroup => {
      const hrs = (Date.now() - firstDetectedAt.getTime()) / 3_600_000;
      if (hrs < 2) return "new";
      if (hrs < 24) return "young";
      return "mature";
    };

    const cohortVolumes: Record<AgeGroup, number[]> = { new: [], young: [], mature: [] };
    const cohortVelocities: Record<AgeGroup, number[]> = { new: [], young: [], mature: [] };

    // First pass: collect raw values for cohort normalisation
    const tokenRaws: Array<{
      token: typeof tokens[number];
      rawVol: number;
      rawVelocity: number;
      group: AgeGroup;
    }> = [];

    for (const t of tokens) {
      const group = ageGroup(t.firstDetectedAt);
      const vol   = t.volume24hUsd ? parseFloat(t.volume24hUsd) : 0;
      const hSnaps = holderSnapsByToken.get(t.id) ?? [];
      let vel = 0;
      if (hSnaps.length >= 2) {
        const [latest, prev] = hSnaps;
        const deltaCnt  = (latest.holderCount ?? 0) - (prev.holderCount ?? 0);
        const deltaHrs  = Math.max((latest.snapshotAt.getTime() - prev.snapshotAt.getTime()) / 3_600_000, 0.01);
        vel = Math.max(0, deltaCnt / deltaHrs);
      }
      cohortVolumes[group].push(vol);
      cohortVelocities[group].push(vel);
      tokenRaws.push({ token: t, rawVol: vol, rawVelocity: vel, group });
    }

    // ── Intel log entries to batch-insert ─────────────────────────────────────
    const logEntries: (typeof token_intel_log.$inferInsert)[] = [];

    // ── Second pass: compute scores + persist ─────────────────────────────────
    for (const { token: t, rawVol, rawVelocity, group } of tokenRaws) {
      const pSnaps    = snapsByToken.get(t.id) ?? [];
      const hSnaps    = holderSnapsByToken.get(t.id) ?? [];
      const totalBuys = totalBuysByToken.get(t.id) ?? 0;
      const smartBuys = smartBuysByToken.get(t.id) ?? 0;
      const labeledFraction = totalBuys > 0 ? smartBuys / totalBuys : 0;

      // Maintain running peak MC
      const currentMcNum = t.marketCapUsd ? parseFloat(t.marketCapUsd) : 0;
      const prevPeak     = t.peakMcUsd ?? (t.athMarketCapUsd ? parseFloat(t.athMarketCapUsd) : 0);
      const newPeak      = Math.max(prevPeak, currentMcNum > 0 ? currentMcNum : 0) || null;

      // Compute sub-scores
      const mcGrowthScore = r1(clamp(computeMcGrowthScore(pSnaps, t.marketCapUsd, newPeak)));

      const volResult = computeVolumeScore(t.volume24hUsd, cohortVolumes[group]);
      const volumeIntensityScore = r1(clamp(volResult.score));

      const holderVelResult = computeHolderVelocityScore(
        hSnaps,
        t.holderCount,
        cohortVelocities[group],
      );
      const holderVelocityScore = r1(clamp(holderVelResult.score));

      const kolSmartScore = r1(clamp(computeKolSmartScore(
        t.holderKolCount,
        t.holderSmartCount,
        t.holderCount,
        labeledFraction,
      )));

      const liquidityHealthScore = r1(clamp(computeLiquidityHealthScore(
        t.liquidityUsd,
        t.lowLiquidityFlag,
        pSnaps,
      )));

      // Age factor
      const ageHrs = (Date.now() - t.firstDetectedAt.getTime()) / 3_600_000;
      const ageMult = calcAgeMultiplier(t.firstDetectedAt);

      // Master score (weighted, age-adjusted)
      const rawMaster =
        WEIGHTS.mcGrowth  * mcGrowthScore +
        WEIGHTS.volume    * volumeIntensityScore +
        WEIGHTS.holderVel * holderVelocityScore +
        WEIGHTS.kolSmart  * kolSmartScore +
        WEIGHTS.liquidity * liquidityHealthScore;

      const intelligenceScore = r1(clamp(rawMaster * ageMult));

      // ── Graduation gate (New → Active via intelligence path) ───────────────
      const subScoresAboveFloor = [mcGrowthScore, volumeIntensityScore, holderVelocityScore, kolSmartScore, liquidityHealthScore]
        .filter(s => s >= SIGNAL_POSITIVE_FLOOR).length;
      const graduationThresholdMet =
        intelligenceScore >= GRADUATION_SCORE_THRESHOLD &&
        subScoresAboveFloor >= GRADUATION_POSITIVE_SIGNALS;

      let newConsecutive = t.status === "new" ? (
        graduationThresholdMet
          ? (graduationPending.get(t.id) ?? 0) + 1
          : 0
      ) : 0;

      let statusOverride: string | undefined;
      if (t.status === "new" && newConsecutive >= GRADUATION_CONSECUTIVE) {
        statusOverride = "active";
        newConsecutive = 0;
        graduationPending.delete(t.id);
        log.info({ tokenId: t.id, intelligenceScore }, "Token graduated to active via intelligence score");
        eventBus.emit("price:updated", {
          tokenId: t.id,
          tokenAddress: "",
          chain: "",
          priceUsd: null,
          marketCapUsd: t.marketCapUsd ?? null,
          athPriceUsd:  null,
        });
      } else if (t.status === "new") {
        if (newConsecutive > 0) graduationPending.set(t.id, newConsecutive);
        else graduationPending.delete(t.id);
      }

      // ── Determine whether to write a log entry ─────────────────────────────
      const prevScore = lastLoggedScore.get(t.id);
      const statusAfter = statusOverride ?? t.status;
      const statusChanged = statusAfter !== t.status;
      const scoreDelta = prevScore === undefined ? null : Math.abs(intelligenceScore - prevScore);
      const isFirst = prevScore === undefined;
      const scoreChangedEnough = scoreDelta !== null && scoreDelta >= 1.0;

      if (isFirst || scoreChangedEnough || statusChanged) {
        let trigger: string;
        if (isFirst) trigger = "first";
        else if (statusChanged) trigger = "status_change";
        else trigger = "score_change";

        logEntries.push({
          tokenId:      t.id,
          tokenAddress: t.address,
          computedAt:   new Date(),

          intelligenceScore,
          prevIntelligenceScore: prevScore ?? null,

          mcGrowthScore,
          volumeIntensityScore,
          holderVelocityScore,
          kolSmartScore,
          liquidityHealthScore,

          ageMultiplier:  ageMult,
          tokenAgeHours:  r1(ageHrs),

          marketCapUsd:  t.marketCapUsd,
          volume24hUsd:  t.volume24hUsd,
          liquidityUsd:  t.liquidityUsd,
          peakMcUsd:     newPeak,

          holderCount:      t.holderCount,
          holderKolCount:   t.holderKolCount,
          holderSmartCount: t.holderSmartCount,

          totalBuys,
          smartBuys,
          labeledFraction:  r1(labeledFraction),

          ageGroup:               group,
          cohortSize:             cohortVolumes[group].length,
          cohortVolumePercentile: r1(volResult.percentile),
          holderVelocityPerHour:  r1(holderVelResult.velocityPerHour),

          graduationConsecutive:  newConsecutive,
          graduationThresholdMet,

          statusBefore:  t.status,
          statusAfter,
          statusChanged,

          trigger,
        });

        lastLoggedScore.set(t.id, intelligenceScore);

        log.info(
          {
            tokenId: t.id,
            trigger,
            intelligenceScore,
            prev: prevScore ?? null,
            mcGrowthScore,
            volumeIntensityScore,
            holderVelocityScore,
            kolSmartScore,
            liquidityHealthScore,
            ageMult,
            statusBefore: t.status,
            statusAfter,
            mc: t.marketCapUsd,
          },
          "Intel score log entry",
        );
      }

      await db.update(tracked_tokens).set({
        intelligenceScore,
        mcGrowthScore,
        volumeIntensityScore,
        holderVelocityScore,
        kolSmartScore,
        liquidityHealthScore,
        intelligenceUpdatedAt: new Date(),
        consecutivePositiveChecks: newConsecutive,
        peakMcUsd: newPeak ?? undefined,
        ...(statusOverride ? { status: statusOverride, lastStatusChangeAt: new Date() } : {}),
      }).where(eq(tracked_tokens.id, t.id));
    }

    // ── Batch-insert log entries ───────────────────────────────────────────────
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

export function startIntelligenceEngine() {
  // Run 30s after startup so price snapshots have been written first
  setTimeout(() => {
    refreshAllIntelligence().catch(() => {});
    setInterval(() => refreshAllIntelligence().catch(() => {}), 5 * 60 * 1000);
  }, 30_000);

  logger.info(
    `Intelligence engine started — weights: MC ${WEIGHTS.mcGrowth * 100}% | Vol ${WEIGHTS.volume * 100}% | HolderVel ${WEIGHTS.holderVel * 100}% | KOL/Smart ${WEIGHTS.kolSmart * 100}% | Liq ${WEIGHTS.liquidity * 100}%`,
  );
}
