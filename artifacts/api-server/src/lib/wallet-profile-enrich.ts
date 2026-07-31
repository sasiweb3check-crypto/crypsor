/**
 * Shared GMGN wallet profile enricher → wallet_profiles.
 * Used by security-service (creators) and on-demand wallet intel report.
 */

import { db } from "@workspace/db";
import { wallet_profiles } from "@workspace/db";
import { sql } from "drizzle-orm";
import { fetchWalletProfile, fetchWalletHoldings, nextProxy } from "./gmgn-client";
import { logger } from "./logger";

const log = logger.child({ module: "wallet-profile-enrich" });

export type EnrichedWalletProfile = {
  walletAddress: string;
  labels: string[];
  twitterName: string | null;
  twitterUsername: string | null;
  totalPnlUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  winRate: number | null;
  avgHoldTimeSec: number | null;
  totalTradeCount: number | null;
  solBalance: number | null;
  profileFetchedAt: string | null;
  gmgnRaw: unknown;
  holdingsRaw: unknown;
  ok: boolean;
  status: number;
};

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

/** Fetch GMGN wallet_info (+ holdings) and upsert wallet_profiles. */
export async function enrichAndPersistWalletProfile(
  chain: string,
  walletAddress: string,
  opts?: { extraLabels?: string[]; fetchHoldings?: boolean },
): Promise<EnrichedWalletProfile> {
  const address = walletAddress.trim();
  const proxy = nextProxy();
  const [profileRes, holdingsRes] = await Promise.all([
    fetchWalletProfile(chain, address, proxy),
    opts?.fetchHoldings === false
      ? Promise.resolve({ ok: false, status: 0, data: null })
      : fetchWalletHoldings(chain, address, proxy, 40),
  ]);

  if (!profileRes.ok) {
    return {
      walletAddress: address,
      labels: [],
      twitterName: null,
      twitterUsername: null,
      totalPnlUsd: null,
      realizedPnlUsd: null,
      unrealizedPnlUsd: null,
      winRate: null,
      avgHoldTimeSec: null,
      totalTradeCount: null,
      solBalance: null,
      profileFetchedAt: null,
      gmgnRaw: profileRes.data ?? null,
      holdingsRaw: holdingsRes.ok ? holdingsRes.data : null,
      ok: false,
      status: profileRes.status,
    };
  }

  const root = asRecord(profileRes.data);
  const data = asRecord(root.data ?? root);

  const totalPnl = num(data.total_profit_usd ?? data.pnl);
  const realizedPnl = num(data.realized_profit ?? data.realized_pnl);
  const unrealizedPnl = num(data.unrealized_profit ?? data.unrealized_pnl);
  let winRate = num(data.winrate ?? data.win_rate);
  if (winRate != null && winRate > 1) winRate = winRate / 100;
  const avgHoldRaw = data.avg_hold_duration ?? data.avg_hold_time;
  const totalTrades = data.total_trade_count ?? data.total_trades;
  const solBalance = num(data.sol_balance);
  const tags = [
    ...(Array.isArray(data.tags) ? data.tags.map(String) : []),
    ...(Array.isArray(data.maker_token_tags) ? data.maker_token_tags.map(String) : []),
    ...(opts?.extraLabels ?? []),
  ].filter(Boolean);

  const now = new Date();
  await db.insert(wallet_profiles).values({
    walletAddress: address,
    labels: [...new Set(tags)],
    twitterName: data.twitter_name != null ? String(data.twitter_name) : null,
    twitterUsername: data.twitter_username != null ? String(data.twitter_username) : null,
    totalPnlUsd: totalPnl,
    realizedPnlUsd: realizedPnl,
    unrealizedPnlUsd: unrealizedPnl,
    winRate,
    avgHoldTimeSec: avgHoldRaw != null ? Math.round(Number(avgHoldRaw)) : null,
    totalTradeCount: totalTrades != null ? Math.round(Number(totalTrades)) : null,
    solBalance,
    gmgnProfile: profileRes.data,
    profileFetchedAt: now,
    lastSeenAt: now,
  }).onConflictDoUpdate({
    target: wallet_profiles.walletAddress,
    set: {
      labels: sql`ARRAY(SELECT DISTINCT unnest(wallet_profiles.labels || excluded.labels))`,
      twitterName: sql`COALESCE(NULLIF(excluded.twitter_name, ''), wallet_profiles.twitter_name)`,
      twitterUsername: sql`COALESCE(NULLIF(excluded.twitter_username, ''), wallet_profiles.twitter_username)`,
      totalPnlUsd: sql`excluded.total_pnl_usd`,
      realizedPnlUsd: sql`excluded.realized_pnl_usd`,
      unrealizedPnlUsd: sql`excluded.unrealized_pnl_usd`,
      winRate: sql`excluded.win_rate`,
      avgHoldTimeSec: sql`excluded.avg_hold_time_sec`,
      totalTradeCount: sql`excluded.total_trade_count`,
      solBalance: sql`excluded.sol_balance`,
      gmgnProfile: sql`excluded.gmgn_profile`,
      profileFetchedAt: sql`excluded.profile_fetched_at`,
      lastSeenAt: sql`excluded.last_seen_at`,
    },
  });

  log.info(
    { address: address.slice(0, 8) + "…", winRate, totalPnl },
    "Wallet profile enriched",
  );

  return {
    walletAddress: address,
    labels: [...new Set(tags)],
    twitterName: data.twitter_name != null ? String(data.twitter_name) : null,
    twitterUsername: data.twitter_username != null ? String(data.twitter_username) : null,
    totalPnlUsd: totalPnl,
    realizedPnlUsd: realizedPnl,
    unrealizedPnlUsd: unrealizedPnl,
    winRate,
    avgHoldTimeSec: avgHoldRaw != null ? Math.round(Number(avgHoldRaw)) : null,
    totalTradeCount: totalTrades != null ? Math.round(Number(totalTrades)) : null,
    solBalance,
    profileFetchedAt: now.toISOString(),
    gmgnRaw: profileRes.data,
    holdingsRaw: holdingsRes.ok ? holdingsRes.data : null,
    ok: true,
    status: profileRes.status,
  };
}
