/**
 * Pump.fun creator + graduation enricher.
 *
 * Sources (free):
 *   GET frontend-api-v3.pump.fun/coins/:mint
 *   GET frontend-api-v3.pump.fun/coins?creator=:wallet
 *   GET frontend-api-v3.pump.fun/users/:wallet
 *
 * Note: pump.fun coin payload has no CTO flag — CTO stays GMGN (`sec_cto_flag`).
 * We persist graduated (`migrated`), creator wallet/username, and creator track record.
 */

import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const PUMP_API = "https://frontend-api-v3.pump.fun";
const UA = "Mozilla/5.0 (compatible; Crypsor/1.0)";

export type CreatorTokenRow = {
  mint: string;
  symbol: string | null;
  name: string | null;
  complete: boolean;
  usdMc: number | null;
  athMc: number | null;
  createdAt: string | null;
  twitter: string | null;
};

export type CreatorTrustLabel = "trusted" | "proven" | "serial" | "fresh" | "unknown";

export type CreatorStatsPayload = {
  address: string;
  username: string | null;
  followers: number | null;
  tokenCount: number;
  migratedCount: number;
  maxAthUsd: number | null;
  trustLabel: CreatorTrustLabel;
  /** True when track record looks like a real runner (not first rug wallet). */
  trustedDev: boolean;
  tokens: CreatorTokenRow[];
  fetchedAt: string;
  source: "pump.fun";
};

type PumpCoin = {
  mint?: string;
  name?: string;
  symbol?: string;
  creator?: string;
  username?: string;
  complete?: boolean;
  usd_market_cap?: number;
  ath_market_cap?: number;
  ath_market_cap_timestamp?: number;
  created_timestamp?: number;
  twitter?: string;
  pump_swap_pool?: string | null;
  raydium_pool?: string | null;
  image_uri?: string;
};

type PumpUser = {
  address?: string;
  username?: string | null;
  followers?: number;
  x_username?: string | null;
};

function tsIso(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const n = ms > 1e12 ? ms : ms * 1000;
  try {
    return new Date(n).toISOString();
  } catch {
    return null;
  }
}

async function pumpGet<T>(path: string, timeoutMs = 12_000): Promise<T | null> {
  try {
    const res = await fetch(`${PUMP_API}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json", "User-Agent": UA },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err, path }, "pump.fun fetch failed");
    return null;
  }
}

export function trustLabelFromStats(input: {
  tokenCount: number;
  migratedCount: number;
  maxAthUsd: number | null;
}): { trustLabel: CreatorTrustLabel; trustedDev: boolean } {
  const { tokenCount, migratedCount, maxAthUsd } = input;
  const ath = maxAthUsd ?? 0;

  if (tokenCount <= 0) return { trustLabel: "unknown", trustedDev: false };
  if (tokenCount === 1 && migratedCount === 0) return { trustLabel: "fresh", trustedDev: false };

  // Strong prior runner
  if (migratedCount >= 1 && ath >= 1_000_000) {
    return { trustLabel: "trusted", trustedDev: true };
  }
  // Solid mid runner
  if (migratedCount >= 1 && ath >= 100_000) {
    return { trustLabel: "proven", trustedDev: true };
  }
  // Many launches but weak ATH → serial launcher (caution)
  if (tokenCount >= 5) {
    return { trustLabel: "serial", trustedDev: false };
  }
  if (migratedCount >= 1 && ath >= 50_000) {
    return { trustLabel: "proven", trustedDev: true };
  }
  if (tokenCount >= 2) return { trustLabel: "serial", trustedDev: false };
  return { trustLabel: "fresh", trustedDev: false };
}

export async function fetchPumpCoin(mint: string): Promise<PumpCoin | null> {
  return pumpGet<PumpCoin>(`/coins/${mint}`);
}

export async function fetchCreatorCoins(creator: string, limit = 50): Promise<PumpCoin[]> {
  const list = await pumpGet<PumpCoin[]>(
    `/coins?offset=0&limit=${Math.min(limit, 50)}&sort=created_timestamp&order=DESC&creator=${creator}`,
  );
  return Array.isArray(list) ? list : [];
}

export async function fetchPumpUser(wallet: string): Promise<PumpUser | null> {
  return pumpGet<PumpUser>(`/users/${wallet}`);
}

export function buildCreatorStats(
  creator: string,
  coins: PumpCoin[],
  user: PumpUser | null,
): CreatorStatsPayload {
  const tokens: CreatorTokenRow[] = coins
    .filter((c) => c.mint)
    .map((c) => ({
      mint: String(c.mint),
      symbol: c.symbol ?? null,
      name: c.name ?? null,
      complete: Boolean(c.complete || c.pump_swap_pool || c.raydium_pool),
      usdMc: typeof c.usd_market_cap === "number" ? c.usd_market_cap : null,
      athMc: typeof c.ath_market_cap === "number" ? c.ath_market_cap : null,
      createdAt: tsIso(c.created_timestamp),
      twitter: c.twitter ?? null,
    }));

  const migratedCount = tokens.filter((t) => t.complete).length;
  const maxAthUsd = tokens.reduce<number | null>((best, t) => {
    if (t.athMc == null || !Number.isFinite(t.athMc)) return best;
    return best == null ? t.athMc : Math.max(best, t.athMc);
  }, null);

  const { trustLabel, trustedDev } = trustLabelFromStats({
    tokenCount: tokens.length,
    migratedCount,
    maxAthUsd,
  });

  return {
    address: creator,
    username: user?.username ?? coins.find((c) => c.username)?.username ?? null,
    followers: user?.followers ?? null,
    tokenCount: tokens.length,
    migratedCount,
    maxAthUsd,
    trustLabel,
    trustedDev,
    tokens: tokens.slice(0, 20),
    fetchedAt: new Date().toISOString(),
    source: "pump.fun",
  };
}

export type CreatorEnrichResult = {
  graduated: boolean;
  creatorAddress: string | null;
  creatorUsername: string | null;
  pumpAthMarketCapUsd: number | null;
  creatorStats: CreatorStatsPayload | null;
};

/** Fetch pump coin + creator history (no DB write). */
export async function enrichCreatorFromPump(mint: string): Promise<CreatorEnrichResult> {
  const coin = await fetchPumpCoin(mint);
  if (!coin) {
    return {
      graduated: false,
      creatorAddress: null,
      creatorUsername: null,
      pumpAthMarketCapUsd: null,
      creatorStats: null,
    };
  }

  const graduated = Boolean(coin.complete || coin.pump_swap_pool || coin.raydium_pool);
  const creatorAddress = coin.creator?.trim() || null;
  const pumpAth =
    typeof coin.ath_market_cap === "number" && Number.isFinite(coin.ath_market_cap)
      ? coin.ath_market_cap
      : null;

  let creatorStats: CreatorStatsPayload | null = null;
  let creatorUsername = coin.username ?? null;

  if (creatorAddress) {
    const [coins, user] = await Promise.all([
      fetchCreatorCoins(creatorAddress),
      fetchPumpUser(creatorAddress),
    ]);
    // Ensure current mint is in the list even if creator filter misses it
    if (coin.mint && !coins.some((c) => c.mint === coin.mint)) {
      coins.unshift(coin);
    }
    creatorStats = buildCreatorStats(creatorAddress, coins, user);
    creatorUsername = creatorStats.username ?? creatorUsername;
  }

  return {
    graduated,
    creatorAddress,
    creatorUsername,
    pumpAthMarketCapUsd: pumpAth,
    creatorStats,
  };
}

const STALE_MS = 30 * 60_000; // 30m

/**
 * Persist pump creator/graduation onto tracked_tokens.
 * Skips network if creator_stats_fetched_at is fresh (unless force).
 */
export async function ensureTokenCreatorStats(
  tokenId: number,
  mint: string,
  opts?: { force?: boolean },
): Promise<CreatorEnrichResult | null> {
  try {
    const [row] = await db
      .select({
        creatorStatsFetchedAt: tracked_tokens.creatorStatsFetchedAt,
        migrated: tracked_tokens.migrated,
        secCreatorAddress: tracked_tokens.secCreatorAddress,
        creatorUsername: tracked_tokens.creatorUsername,
        pumpAthMarketCapUsd: tracked_tokens.pumpAthMarketCapUsd,
        creatorStats: tracked_tokens.creatorStats,
        athMarketCapUsd: tracked_tokens.athMarketCapUsd,
      })
      .from(tracked_tokens)
      .where(eq(tracked_tokens.id, tokenId))
      .limit(1);

    if (!row) return null;

    const fetchedAt = row.creatorStatsFetchedAt?.getTime() ?? 0;
    if (!opts?.force && fetchedAt > 0 && Date.now() - fetchedAt < STALE_MS && row.creatorStats) {
      const stats = row.creatorStats as CreatorStatsPayload;
      return {
        graduated: Boolean(row.migrated),
        creatorAddress: row.secCreatorAddress,
        creatorUsername: row.creatorUsername,
        pumpAthMarketCapUsd: row.pumpAthMarketCapUsd != null
          ? Number(row.pumpAthMarketCapUsd)
          : null,
        creatorStats: stats,
      };
    }

    const enrich = await enrichCreatorFromPump(mint);
    if (!enrich.creatorStats && !enrich.creatorAddress && !enrich.graduated) {
      // Still stamp fetch time lightly so we don't hammer a dead mint
      await db
        .update(tracked_tokens)
        .set({ creatorStatsFetchedAt: new Date() })
        .where(eq(tracked_tokens.id, tokenId));
      return enrich;
    }

    const patch: Partial<typeof tracked_tokens.$inferInsert> = {
      creatorStatsFetchedAt: new Date(),
    };

    if (enrich.graduated) patch.migrated = true;
    if (enrich.creatorAddress) {
      // Prefer pump creator when we don't have one yet
      if (!row.secCreatorAddress) patch.secCreatorAddress = enrich.creatorAddress;
      else if (row.secCreatorAddress !== enrich.creatorAddress) {
        // Keep existing GMGN creator if set; still store pump creator in stats
        patch.secCreatorAddress = enrich.creatorAddress;
      }
    }
    if (enrich.creatorUsername) patch.creatorUsername = enrich.creatorUsername;
    if (enrich.pumpAthMarketCapUsd != null) {
      patch.pumpAthMarketCapUsd = String(enrich.pumpAthMarketCapUsd);
      const existingAth = row.athMarketCapUsd != null ? Number(row.athMarketCapUsd) : 0;
      if (!Number.isFinite(existingAth) || enrich.pumpAthMarketCapUsd > existingAth) {
        patch.athMarketCapUsd = String(enrich.pumpAthMarketCapUsd);
      }
    }
    if (enrich.creatorStats) {
      patch.creatorStats = enrich.creatorStats;
      patch.secCreatorCreatedCount = enrich.creatorStats.tokenCount;
    }

    await db.update(tracked_tokens).set(patch).where(eq(tracked_tokens.id, tokenId));
    return enrich;
  } catch (err) {
    logger.warn({ err, tokenId, mint }, "ensureTokenCreatorStats failed");
    return null;
  }
}
