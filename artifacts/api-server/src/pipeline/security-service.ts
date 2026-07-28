/**
 * Security Service
 *
 * Fetches GMGN security + pool data for tracked tokens and persists to
 * the sec_* columns on tracked_tokens. Also fetches top traders and
 * dev/creator wallet profiles.
 *
 * Triggers:
 *   1. token:bought — enqueue a security fetch 15s after detection
 *      (gives metadata service time to resolve the address).
 *   2. Every REFRESH_INTERVAL_MS — refresh security for all active/watch tokens
 *      that haven't been refreshed in the last STALE_AFTER_MS.
 *
 * Rate-limiting: all fetches use the shared gmgnFetch infrastructure with
 * optional proxy rotation — same Cloudflare bypass as holders-refresh.
 */

import { db } from "@workspace/db";
import { tracked_tokens, wallet_profiles } from "@workspace/db";
import { eq, or, isNull, lt, sql, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus, type TokenBoughtEvent } from "./event-bus";
import {
  fetchTokenSecurity,
  fetchTokenPool,
  fetchTopTraders,
  fetchWalletProfile,
  persistTraders,
  CHAIN_MAP,
  nextProxy,
  type GmgnSecurityData,
} from "../lib/gmgn-client";

const REFRESH_INTERVAL_MS = 5 * 60_000;   // 5 min between refresh cycles
const STARTUP_DELAY_MS    = 60_000;        // wait 60 s after boot
const INITIAL_FETCH_DELAY = 15_000;        // 15 s after token:bought
const STALE_AFTER_MS      = 30 * 60_000;  // re-fetch security if older than 30 min

const log = logger.child({ module: "security-service" });

// In-memory cooldown so we don't double-fetch on rapid re-detection
const lastFetched = new Map<number, number>();

// ── Core fetch ────────────────────────────────────────────────────────────────

async function fetchAndPersistSecurity(token: {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  marketCapUsd: string | null;
}): Promise<void> {
  const chain      = CHAIN_MAP[token.chain.toLowerCase()] ?? "sol";
  const proxy      = nextProxy();
  const tokenLabel = [token.name, token.symbol].filter(Boolean).join(" / ") || token.address.slice(0, 8);

  try {
    // Fetch security + pool + top traders in parallel
    const [secResult, poolResult, tradersResult] = await Promise.all([
      fetchTokenSecurity(token.chain, token.address, proxy),
      fetchTokenPool(token.chain, token.address, proxy),
      fetchTopTraders(token.chain, token.address, proxy, 40),
    ]);

    const s = secResult.security;

    // Persist security columns
    await db.update(tracked_tokens)
      .set({
        secIsHoneypot:          s.isHoneypot,
        secOwnerRenounced:      s.ownerRenounced,
        secMintRenounced:       s.mintRenounced,
        secFreezeRenounced:     s.freezeRenounced,
        secOpenSource:          s.openSource,
        secTop10HolderRate:     s.top10HolderRate,
        secRugRatio:            s.rugRatio,
        secSniperCount:         s.sniperCount != null ? Math.round(s.sniperCount) : null,
        secCreatorAddress:      s.creatorAddress || null,
        secCreatorClose:        s.creatorClose,
        secCreatorTokenStatus:  s.creatorTokenStatus,
        secBuyTax:              s.buyTax,
        secSellTax:             s.sellTax,
        secLpLocked:            s.lpLocked,
        secLpLockPercent:       s.lpLockPercent,
        secCtoFlag:             s.ctoFlag,
        secBluechipOwnerPct:    s.bluechipOwnerPct,
        secRatTraderAmtRate:    s.ratTraderAmtRate,
        secCreatorCreatedCount: s.creatorCreatedCount != null ? Math.round(s.creatorCreatedCount) : null,
        secFetchedAt:           new Date(),
      })
      .where(eq(tracked_tokens.id, token.id));

    log.info(
      {
        tokenId:       token.id,
        tokenLabel,
        honeypot:      s.isHoneypot,
        renounced:     s.ownerRenounced,
        rugRatio:      s.rugRatio,
        creator:       s.creatorAddress ? s.creatorAddress.slice(0, 8) + "…" : null,
        creatorClose:  s.creatorClose,
        lpLocked:      s.lpLocked,
        sniperCount:   s.sniperCount,
      },
      "Security data persisted",
    );

    // Persist top traders
    const traderList: unknown[] =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tradersResult.data as any)?.data?.list ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tradersResult.data as any)?.data ??
      [];
    if (Array.isArray(traderList) && traderList.length > 0) {
      await persistTraders(token.id, traderList, tokenLabel);
    }

    // Fetch dev/creator wallet profile if we have an address
    if (s.creatorAddress && s.creatorAddress.length > 8) {
      fetchCreatorProfile(chain, s.creatorAddress, token.id).catch(err =>
        log.warn({ err, tokenId: token.id }, "Creator profile fetch failed (non-fatal)"),
      );
    }

    lastFetched.set(token.id, Date.now());

    // Pool data is available in the raw API response — log it but we don't
    // currently store pool data in a dedicated table. It comes back as part
    // of the /api/tokens/:id/pool route response.
    if (poolResult.ok) {
      log.debug({ tokenId: token.id }, "Pool data fetched successfully");
    }
  } catch (err) {
    log.warn({ err, tokenId: token.id, tokenLabel }, "Security fetch failed (non-fatal)");
  }
}

// ── Creator / dev wallet profile ──────────────────────────────────────────────

async function fetchCreatorProfile(
  chain: string,
  creatorAddress: string,
  tokenId: number,
): Promise<void> {
  const proxy      = nextProxy();
  const [profileRes] = await Promise.all([
    fetchWalletProfile(chain, creatorAddress, proxy),
  ]);

  if (!profileRes.ok) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (profileRes.data as any)?.data ?? (profileRes.data as any) ?? {};

  const totalPnl       = parseFloat(data?.total_profit_usd     ?? data?.pnl             ?? "0") || null;
  const realizedPnl    = parseFloat(data?.realized_profit      ?? data?.realized_pnl    ?? "0") || null;
  const unrealizedPnl  = parseFloat(data?.unrealized_profit    ?? data?.unrealized_pnl  ?? "0") || null;
  const winRate        = parseFloat(data?.winrate              ?? data?.win_rate         ?? "0") || null;
  const avgHoldTimeSec = data?.avg_hold_duration ?? data?.avg_hold_time ?? null;
  const totalTrades    = data?.total_trade_count ?? data?.total_trades  ?? null;
  const solBalance     = parseFloat(data?.sol_balance ?? "0") || null;
  const labels: string[] = [
    ...(data?.tags ?? []),
    ...(data?.maker_token_tags ?? []),
    "dev",  // always tag creator as dev
  ].filter(Boolean);

  await db.insert(wallet_profiles).values({
    walletAddress:    creatorAddress,
    labels:           [...new Set(labels)],
    twitterName:      data?.twitter_name     ?? null,
    twitterUsername:  data?.twitter_username ?? null,
    totalPnlUsd:      totalPnl,
    realizedPnlUsd:   realizedPnl,
    unrealizedPnlUsd: unrealizedPnl,
    winRate:          winRate && winRate > 1 ? winRate / 100 : winRate,
    avgHoldTimeSec:   avgHoldTimeSec != null ? Math.round(Number(avgHoldTimeSec)) : null,
    totalTradeCount:  totalTrades   != null ? Math.round(Number(totalTrades))    : null,
    solBalance,
    gmgnProfile:      profileRes.data,
    profileFetchedAt: new Date(),
    lastSeenAt:       new Date(),
  }).onConflictDoUpdate({
    target: wallet_profiles.walletAddress,
    set: {
      labels:           sql`ARRAY(SELECT DISTINCT unnest(wallet_profiles.labels || excluded.labels))`,
      twitterName:      sql`COALESCE(NULLIF(excluded.twitter_name, ''), wallet_profiles.twitter_name)`,
      twitterUsername:  sql`COALESCE(NULLIF(excluded.twitter_username, ''), wallet_profiles.twitter_username)`,
      totalPnlUsd:      sql`excluded.total_pnl_usd`,
      realizedPnlUsd:   sql`excluded.realized_pnl_usd`,
      unrealizedPnlUsd: sql`excluded.unrealized_pnl_usd`,
      winRate:          sql`excluded.win_rate`,
      avgHoldTimeSec:   sql`excluded.avg_hold_time_sec`,
      totalTradeCount:  sql`excluded.total_trade_count`,
      solBalance:       sql`excluded.sol_balance`,
      gmgnProfile:      sql`excluded.gmgn_profile`,
      profileFetchedAt: sql`excluded.profile_fetched_at`,
      lastSeenAt:       sql`excluded.last_seen_at`,
    },
  });

  log.info(
    { creatorAddress: creatorAddress.slice(0, 8) + "…", tokenId, winRate, totalPnl },
    "Creator profile upserted",
  );
}

// ── Refresh cycle ─────────────────────────────────────────────────────────────

async function refreshCycle(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_AFTER_MS);

  const tokens = await db
    .select({
      id:           tracked_tokens.id,
      address:      tracked_tokens.address,
      chain:        tracked_tokens.chain,
      name:         tracked_tokens.name,
      symbol:       tracked_tokens.symbol,
      marketCapUsd: tracked_tokens.marketCapUsd,
    })
    .from(tracked_tokens)
    .where(
      and(
        or(
          eq(tracked_tokens.status, "active"),
          eq(tracked_tokens.status, "watch"),
          eq(tracked_tokens.status, "new"),
        ),
        or(
          isNull(tracked_tokens.secFetchedAt),
          lt(tracked_tokens.secFetchedAt, staleThreshold),
        ),
      ),
    )
    .limit(20); // cap per cycle to stay within rate limits

  if (tokens.length === 0) return;

  log.debug({ count: tokens.length }, "Security refresh cycle: fetching stale tokens");

  // Process sequentially with a small delay to avoid hammering GMGN
  for (const token of tokens) {
    const last = lastFetched.get(token.id) ?? 0;
    if (Date.now() - last < 60_000) continue; // 1-min per-token cooldown
    await fetchAndPersistSecurity(token);
    await new Promise(r => setTimeout(r, 500)); // 500ms between tokens
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

export function startSecurityService(): void {
  // On new token detection: enqueue security fetch after metadata settles
  eventBus.on("token:bought", (e: TokenBoughtEvent) => {
    setTimeout(async () => {
      try {
        const [token] = await db
          .select({
            id:           tracked_tokens.id,
            address:      tracked_tokens.address,
            chain:        tracked_tokens.chain,
            name:         tracked_tokens.name,
            symbol:       tracked_tokens.symbol,
            marketCapUsd: tracked_tokens.marketCapUsd,
          })
          .from(tracked_tokens)
          .where(eq(tracked_tokens.id, e.tokenId))
          .limit(1);
        if (token) {
          await fetchAndPersistSecurity(token);
        }
      } catch (err) {
        log.warn({ err, tokenId: e.tokenId }, "Security initial fetch failed (non-fatal)");
      }
    }, INITIAL_FETCH_DELAY);
  });

  // Periodic stale-token refresh
  setTimeout(() => {
    refreshCycle().catch(err => log.error({ err }, "Security refresh cycle error"));
    setInterval(
      () => refreshCycle().catch(err => log.error({ err }, "Security refresh cycle error")),
      REFRESH_INTERVAL_MS,
    );
  }, STARTUP_DELAY_MS);

  log.info("Security service started (GMGN security + pool + traders + creator profiles)");
}
