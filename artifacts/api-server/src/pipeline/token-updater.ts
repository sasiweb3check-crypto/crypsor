/**
 * TokenUpdater — single source of truth for holder snapshots + metadata writes.
 *
 * Responsibilities:
 *   1. Creating `token_holder_snapshots` rows (with JSONB holders_data)
 *   2. Linking `latest_holder_snapshot_id` on tracked_tokens
 *   3. Updating `last_holders_updated_at` after each snapshot
 *   4. Updating token metadata (name/symbol/price) from queue jobs
 *   5. Storing `raw_metadata` JSONB for debugging / re-processing
 *   6. Emitting `holders:updated` on the event bus for SSE
 *
 * All other DB writes (prices, lifecycle, momentum, projection) continue
 * through their own services — TokenUpdater focuses on the snapshot layer.
 */

import { db } from "@workspace/db";
import { tracked_tokens, token_holder_snapshots } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus } from "./event-bus";
import { healthMonitor } from "./health-monitor";
import { buildHolderIntel, type HolderIntel } from "../lib/holder-intel";

// ── Snapshot computation ──────────────────────────────────────────────────────

type RawHolder = {
  amount_percentage?: number | null;
  tags?:             string[];
  maker_token_tags?: string[];
  realized_profit?:  number | null;
  address?:          string;
  account_address?:  string;
  twitter_name?:     string | null;
  twitter_username?: string | null;
};

function computeSummary(holderList: unknown[]): {
  holderCount:     number;
  top10Pct:        string;
  smartMoneyCount: number;
  devHoldPct:      string;
  totalPnl:        string;
} {
  const holders = holderList as RawHolder[];

  const holderCount    = holders.length;
  const allLabels = (h: RawHolder) => [...(h.tags ?? []), ...(h.maker_token_tags ?? [])];

  const sorted = [...holders].sort(
    (a, b) => (b.amount_percentage ?? 0) - (a.amount_percentage ?? 0),
  );
  // GMGN returns amount_percentage as a decimal fraction (0.021 = 2.1%).
  // Multiply by 100 to store as a normalised percent (0–100), consistent with
  // tracked_tokens.holder_top10_pct which uses the status.top_10_holder_rate path.
  const top10Pct = (
    sorted.slice(0, 10).reduce((s, h) => s + (h.amount_percentage ?? 0), 0) * 100
  ).toFixed(2);

  const smartMoneyCount = holders.filter(h =>
    allLabels(h).some(l => ["smart_money", "smart_degen"].includes(l)),
  ).length;

  // GMGN tags vary by endpoint — check all known creator/dev label variants.
  // amount_percentage is a fraction (0.021 = 2.1%), multiply by 100 for percent.
  const DEV_TAGS = ["dev", "creator", "coin_deployer", "project_dev"];
  const devHoldPct = (
    holders
      .filter(h => allLabels(h).some(l => DEV_TAGS.includes(l)))
      .reduce((s, h) => s + (h.amount_percentage ?? 0), 0) * 100
  ).toFixed(2);

  const totalPnl = holders
    .reduce((s, h) => s + (h.realized_profit ?? 0), 0)
    .toFixed(2);

  return { holderCount, top10Pct, smartMoneyCount, devHoldPct, totalPnl };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SnapshotInput {
  tokenId:              number;
  tokenAddress:         string;
  holderList:           unknown[];
  rawGmgnPayload?:      unknown;
  snapshotMarketCapUsd?: string | null;
  snapshotType?:        "discovery" | "post_buy" | "hourly" | "daily" | "manual" | "default";
  holderIntel?:         HolderIntel;
}

/**
 * Create a holder snapshot and link it to the token.
 * Returns the new snapshot ID, or null on failure / empty list.
 */
export async function createHolderSnapshot(input: SnapshotInput): Promise<number | null> {
  if (!input.holderList.length) return null;

  const t0 = Date.now();
  try {
    const summary = computeSummary(input.holderList);
    const intel = input.holderIntel ?? buildHolderIntel({ fetchedTopCount: input.holderList.length });

    const [snapshot] = await db
      .insert(token_holder_snapshots)
      .values({
        tokenId:              input.tokenId,
        snapshotType:         input.snapshotType ?? "default",
        holdersData:          input.holderList,
        rawGmgnPayload:       input.rawGmgnPayload ?? null,
        snapshotMarketCapUsd: input.snapshotMarketCapUsd ?? null,
        fetchedTopCount:      input.holderList.length,
        holderCount:          summary.holderCount,
        top10Pct:             summary.top10Pct,
        smartMoneyCount:      summary.smartMoneyCount,
         kolCount:             intel.kolCount,
         freshWalletCount:     intel.freshCount,
         botCount:             intel.botCount,
         insiderCount:         intel.insiderCount,
         devCount:             intel.devCount,
         bluechipCount:        intel.bluechipCount,
         bundlerCount:         intel.bundlerCount,
         sniperCount:          intel.sniperCount,
        devHoldPct:           summary.devHoldPct,
        totalPnl:             summary.totalPnl,
         holdingRate:          String(intel.holdingRate),
         boughtRate:           String(intel.boughtRate),
         boughtMore:           intel.boughtMore,
         holdCount:             intel.hold,
         soldPart:             intel.soldPart,
         soldCount:             intel.sold,
         momentumScore:         String(intel.momentumScore),
         momentumLabel:         intel.momentumLabel,
         qualityScore:          intel.qualityScore,
         momentumScoreV2:       intel.momentumScoreV2,
         clusterCount:          intel.clusters.clusterCount,
         cabalDetected:         intel.clusters.cabalDetected,
         clusterData:           intel.clusters as unknown as Record<string, unknown>,
      })
      .returning({ id: token_holder_snapshots.id });

    if (!snapshot) return null;

    // Update the token's snapshot pointer
    await db
      .update(tracked_tokens)
      .set({
        latestHolderSnapshotId: snapshot.id,
        lastHoldersUpdatedAt:   new Date(),
        holderMomentumScore:    intel.momentumScore,
        holderMomentumLabel:    intel.momentumLabel,
        holderCount:            intel.holderCount,
        holderKolCount:         intel.kolCount,
        holderSmartCount:        intel.smartCount,
        holderTop10Pct:          intel.top10Pct,
        holderHoldingRate:       intel.holdingRate,
        holderBoughtRate:        intel.boughtRate,
        holderQualityScore:      intel.qualityScore,
        holderBundlerCount:      intel.bundlerCount,
        holderSniperCount:       intel.sniperCount,
        holderMomentumUpdatedAt: new Date(),
        holderMomentumScoreV2:   intel.momentumScoreV2,
        holderClusterCount:      intel.clusters.clusterCount,
        holderCabalDetected:     intel.clusters.cabalDetected,
        holderLargestClusterPct: intel.clusters.largestClusterPct,
      })
      .where(eq(tracked_tokens.id, input.tokenId));

    // Emit SSE event for real-time dashboard updates
    eventBus.emit("holders:updated", {
      tokenId:      input.tokenId,
      tokenAddress: input.tokenAddress,
      count:        summary.holderCount,
      source:       "background",
    });

    healthMonitor.ok("token-updater", Date.now() - t0);
    logger.info(
      {
        tokenId:     input.tokenId,
        snapshotId:  snapshot.id,
        holderCount: summary.holderCount,
        type:        input.snapshotType ?? "default",
      },
      "TokenUpdater: snapshot created",
    );

    return snapshot.id;
  } catch (err) {
    healthMonitor.error("token-updater", err);
    logger.warn({ err, tokenId: input.tokenId }, "TokenUpdater: snapshot creation failed");
    return null;
  }
}

/**
 * Update token metadata from a queue job.
 * Stores raw_metadata JSONB for debugging / re-processing.
 */
export async function updateTokenMetadata(
  tokenId: number,
  metadata: {
    name?:           string | null;
    symbol?:         string | null;
    logoUri?:        string | null;
    priceUsd?:       string | null;
    marketCapUsd?:   string | null;
    fdvUsd?:         string | null;
    liquidityUsd?:   string | null;
    volume24hUsd?:   string | null;
    tokenCreatedAt?: Date | null;
    rawPayload?:     unknown;
  },
): Promise<void> {
  try {
    await db
      .update(tracked_tokens)
      .set({
        ...(metadata.name          ? { name:            metadata.name }          : {}),
        ...(metadata.symbol        ? { symbol:          metadata.symbol }        : {}),
        ...(metadata.logoUri       ? { logoUri:         metadata.logoUri }       : {}),
        ...(metadata.priceUsd      ? { currentPriceUsd: metadata.priceUsd, priceUpdatedAt: new Date() } : {}),
        ...(metadata.marketCapUsd  ? { marketCapUsd:    metadata.marketCapUsd }  : {}),
        ...(metadata.fdvUsd        ? { fdvUsd:          metadata.fdvUsd }        : {}),
        ...(metadata.liquidityUsd  ? { liquidityUsd:    metadata.liquidityUsd }  : {}),
        ...(metadata.volume24hUsd  ? { volume24hUsd:    metadata.volume24hUsd }  : {}),
        ...(metadata.tokenCreatedAt ? { tokenCreatedAt: metadata.tokenCreatedAt } : {}),
        ...(metadata.rawPayload !== undefined ? { rawMetadata: metadata.rawPayload as Record<string, unknown> } : {}),
      })
      .where(eq(tracked_tokens.id, tokenId));
  } catch (err) {
    logger.warn({ err, tokenId }, "TokenUpdater: metadata update failed (non-fatal)");
  }
}

export function startTokenUpdater(): void {
  healthMonitor.register("token-updater");
  logger.info("TokenUpdater started (SSOT for holder snapshots + raw_metadata)");
}
