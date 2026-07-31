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
import { tracked_tokens } from "@workspace/db";
import { eq, or, isNull, lt, and, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus, type TokenBoughtEvent } from "./event-bus";
import {
  fetchTokenSecurity,
  fetchTokenPool,
  CHAIN_MAP,
  nextProxy,
  type GmgnSecurityData,
} from "../lib/gmgn-client";
import { enrichAndPersistWalletProfile } from "../lib/wallet-profile-enrich";

const REFRESH_INTERVAL_MS = 5 * 60_000;   // 5 min between refresh cycles
const STARTUP_DELAY_MS    = 60_000;        // wait 60 s after boot
const INITIAL_FETCH_DELAY = 15_000;        // 15 s after token:bought
const STALE_AFTER_MS      = 30 * 60_000;  // re-fetch security if older than 30 min
/** Desk (good/very_good) — keep CTO / creator fresher than the general pool. */
const DESK_STALE_AFTER_MS = 8 * 60_000;

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
    // Fetch security (RugCheck + GMGN holder stat) — pool is supplementary
    // fetchTopTraders uses a GMGN endpoint that was retired (404); removed.
    const [secResult, poolResult] = await Promise.all([
      fetchTokenSecurity(token.chain, token.address, proxy),
      fetchTokenPool(token.chain, token.address, proxy),
    ]);

    // If both endpoints were blocked/failed, don't overwrite existing data with nulls
    if (!secResult.ok) {
      log.debug(
        { tokenId: token.id, tokenLabel, secStatus: secResult.ok, infoStatus: secResult.ok },
        "Security fetch blocked — skipping persist to avoid overwriting with nulls",
      );
      return;
    }

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
  const enriched = await enrichAndPersistWalletProfile(chain, creatorAddress, {
    extraLabels: ["dev"],
    fetchHoldings: false,
  });
  if (enriched.ok) {
    log.info(
      {
        creatorAddress: creatorAddress.slice(0, 8) + "…",
        tokenId,
        winRate: enriched.winRate,
        totalPnl: enriched.totalPnlUsd,
      },
      "Creator profile upserted",
    );
  }
}

// ── Refresh cycle ─────────────────────────────────────────────────────────────

async function refreshCycle(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_AFTER_MS);
  const deskStale = new Date(Date.now() - DESK_STALE_AFTER_MS);

  // Prefer desk tokens (good/very_good) that need fresher CTO checks
  const desk = await db.execute(sql`
    SELECT t.id, t.address, t.chain, t.name, t.symbol, t.market_cap_usd AS "marketCapUsd"
    FROM tracked_tokens t
    JOIN pro_calls pc ON pc.token_id = t.id
    WHERE pc.quality_label IN ('good', 'very_good')
      AND COALESCE(t.status, '') NOT IN ('ignored', 'archive')
      AND (t.sec_fetched_at IS NULL OR t.sec_fetched_at < ${deskStale})
    ORDER BY t.sec_fetched_at ASC NULLS FIRST
    LIMIT 12
  `).catch(() => null);

  const deskTokens = ((desk?.rows ?? []) as Array<Record<string, unknown>>).map(r => ({
    id: Number(r.id),
    address: String(r.address),
    chain: String(r.chain ?? "solana"),
    name: (r.name as string | null) ?? null,
    symbol: (r.symbol as string | null) ?? null,
    marketCapUsd: r.marketCapUsd != null ? String(r.marketCapUsd) : null,
  }));

  const tokens = deskTokens.length >= 8
    ? deskTokens
    : [
      ...deskTokens,
      ...(await db
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
        .limit(20 - deskTokens.length)),
    ];

  if (tokens.length === 0) return;

  log.debug({ count: tokens.length, desk: deskTokens.length }, "Security refresh cycle: fetching stale tokens");

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
