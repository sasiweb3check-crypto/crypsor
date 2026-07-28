/**
 * Holders Refresh Service
 *
 * Architecture:
 *   • All holder fetches are routed through the `holders` PipelineQueue so
 *     identical jobs are deduped (no double-fetching the same token), and
 *     GMGN concurrency is capped to 2 to avoid rate-limiting.
 *   • Every successful fetch writes to BOTH:
 *       - token_holders (flat upsert — existing behaviour, no change)
 *       - token_holder_snapshots (new — full JSONB snapshot via TokenUpdater)
 *
 * Triggers:
 *   1. token:bought — enqueue a high-priority discovery/post_buy snapshot
 *      after INITIAL_FETCH_DELAY so metadata has settled first.
 *   2. Every REFRESH_INTERVAL_MS — enqueue hourly snapshots for all
 *      tokens that still have active momentum (5m/15m/30m/1h > 0).
 */

import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { gt, or, eq, isNull, lt, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus, type TokenBoughtEvent } from "./event-bus";
import { healthMonitor } from "./health-monitor";
import { gmgnFetch, nextProxy, persistHolders, CHAIN_MAP } from "../lib/gmgn-client";
import { pipelineQueue }         from "../lib/job-queue";
import { createHolderSnapshot }  from "./token-updater";
import { buildHolderIntel }      from "../lib/holder-intel";

const REFRESH_INTERVAL_MS  = 60_000;         // 60 s between momentum-refresh cycles
const STARTUP_DELAY_MS     = 45_000;         // stagger so other services boot first
const INITIAL_FETCH_DELAY  = 12_000;         // 12 s after token:bought
const INITIAL_FETCH_COOLDOWN = 5 * 60_000;  // max one initial fetch per 5 min per token

// In-memory cooldown: prevents duplicate initial fetches per token
const lastInitialFetch = new Map<number, number>();
// Tracks which tokens have already had a discovery snapshot so subsequent
// token:bought events use "post_buy" instead of "discovery" (G5 fix).
const discoveredTokens = new Set<number>();

// ── Job data shape ────────────────────────────────────────────────────────────

export interface HoldersJobData {
  tokenId:      number;
  address:      string;
  chain:        string;
  name:         string | null;
  symbol:       string | null;
  marketCapUsd: string | null;
  snapshotType: "discovery" | "post_buy" | "hourly" | "manual" | "default";
}

// ── Core fetch + persist ──────────────────────────────────────────────────────

async function fetchAndPersistToken(
  token: HoldersJobData,
): Promise<{ count: number; ok: boolean }> {
  try {
    const chain       = CHAIN_MAP[token.chain.toLowerCase()] ?? "sol";
    const stickyProxy = nextProxy();
    const tokenLabel  = [token.name, token.symbol].filter(Boolean).join(" / ") || token.address.slice(0, 8);
    const mcUsd       = token.marketCapUsd ? parseFloat(token.marketCapUsd) : null;
    const mcLabel     = mcUsd != null ? `$${(mcUsd / 1000).toFixed(1)}K` : "unknown";

    // Fetch sequentially to avoid hammering GMGN with 4 simultaneous requests
    // per job (queue concurrency=2 × 4 parallel = 8 concurrent hits → 429).
    const res           = await gmgnFetch(`https://gmgn.ai/vas/api/v1/token_holders/${chain}/${token.address}?limit=200`, stickyProxy);
    const tokenInfoRes  = await gmgnFetch(`https://gmgn.ai/api/v1/token_info/${chain}/${token.address}`, stickyProxy);
    const holderStatRes = await gmgnFetch(`https://gmgn.ai/vas/api/v1/token_holder_stat/${chain}/${token.address}`, stickyProxy);
    // top_buyers endpoint was retired by GMGN (returns 404) — omitted

    const responseData = res.data as {
      data?: { data?: { list?: unknown[] }; list?: unknown[] };
    };
    const list: unknown[] = responseData?.data?.data?.list
      ?? responseData?.data?.list
      ?? [];

    if (list.length === 0) {
      logger.warn(
        { tokenId: token.tokenId, tokenLabel, mcAtSnapshot: mcLabel, httpStatus: res.status },
        "Holders snapshot: empty list from GMGN",
      );
      return { count: 0, ok: false };
    }

    // 1. Upsert into flat token_holders table (existing behaviour — never removed)
    const count = await persistHolders(
      token.tokenId, list, token.marketCapUsd, tokenLabel,
    );

    // 2. Create a rich JSONB snapshot via TokenUpdater (new behaviour)
    createHolderSnapshot({
      tokenId:              token.tokenId,
      tokenAddress:         token.address,
      holderList:           list,
      rawGmgnPayload:       res.data,
      snapshotMarketCapUsd: token.marketCapUsd,
      snapshotType:         token.snapshotType,
      holderIntel: buildHolderIntel({
        tokenInfo: tokenInfoRes.data,
        holderStat: holderStatRes.data,
        // topBuyers omitted — GMGN endpoint retired (404)
        fetchedTopCount: list.length,
        rawHolderList: list,
      }),
    }).catch(err =>
      logger.warn({ err, tokenId: token.tokenId }, "Holders refresh: snapshot creation failed (non-fatal)"),
    );

    logger.info(
      { tokenId: token.tokenId, tokenLabel, mcAtSnapshot: mcLabel, count, source: "background" },
      "Holders snapshot: stored",
    );

    return { count, ok: true };
  } catch (err) {
    logger.warn({ err, tokenId: token.tokenId }, "Holders refresh: token fetch failed");
    return { count: 0, ok: false };
  }
}

// ── Register queue handler ────────────────────────────────────────────────────

function registerQueueHandler(): void {
  pipelineQueue.register<HoldersJobData>("holders", async (data) => {
    await fetchAndPersistToken(data);
  });
}

// ── Periodic momentum-refresh cycle ──────────────────────────────────────────

async function refreshCycle(): Promise<void> {
  const t0 = Date.now();
  try {
    // Refresh tokens that EITHER have active momentum OR have stale / missing
    // holder data. This ensures archived tokens with zero recent buys still get
    // live GMGN snapshots rather than freezing at whatever was last fetched.
    //   • momentum-active  → refresh every 60s cycle (always included)
    //   • stale (>30 min)  → included until fresh; priority = 0 (background)
    //   • never fetched    → always included (first-time hydration)
    const tokens = await db
      .select({
        id:                    tracked_tokens.id,
        address:               tracked_tokens.address,
        chain:                 tracked_tokens.chain,
        name:                  tracked_tokens.name,
        symbol:                tracked_tokens.symbol,
        marketCapUsd:          tracked_tokens.marketCapUsd,
        lastHoldersUpdatedAt:  tracked_tokens.lastHoldersUpdatedAt,
      })
      .from(tracked_tokens)
      .where(
        or(
          gt(tracked_tokens.momentum5m,  0),
          gt(tracked_tokens.momentum15m, 0),
          gt(tracked_tokens.momentum30m, 0),
          gt(tracked_tokens.momentum1h,  0),
          isNull(tracked_tokens.lastHoldersUpdatedAt),
          lt(tracked_tokens.lastHoldersUpdatedAt, sql`NOW() - INTERVAL '30 minutes'`),
        ),
      )
      .limit(30); // cap per cycle — prevents flooding the queue with hundreds of jobs at startup

    if (tokens.length === 0) {
      healthMonitor.ok("holders-refresh", Date.now() - t0);
      return;
    }

    logger.info({ tokens: tokens.length }, "Holders refresh: enqueueing momentum tokens");

    let enqueued = 0;
    let skipped  = 0;

    for (const token of tokens) {
      const added = pipelineQueue.enqueue<HoldersJobData>(
        "holders",
        {
          tokenId:      token.id,
          address:      token.address,
          chain:        token.chain,
          name:         token.name,
          symbol:       token.symbol,
          marketCapUsd: token.marketCapUsd,
          snapshotType: "hourly",
        },
        {
          priority:  0,
          dedupKey: `holders:${token.id}`,
        },
      );
      // BullMQ dedup is async — enqueue() always returns true; count every call.
      void added;
      enqueued++;
    }

    healthMonitor.ok("holders-refresh", Date.now() - t0);
    logger.info(
      { enqueued, skipped, ms: Date.now() - t0 },
      "Holders refresh: cycle enqueued",
    );
  } catch (err) {
    healthMonitor.error("holders-refresh", err);
    logger.error({ err }, "Holders refresh: cycle error");
  }
}

// ── Initial fetch on token discovery ─────────────────────────────────────────

async function scheduleInitialFetch(e: TokenBoughtEvent): Promise<void> {
  const lastFetch = lastInitialFetch.get(e.tokenId);
  if (lastFetch && Date.now() - lastFetch < INITIAL_FETCH_COOLDOWN) return;
  lastInitialFetch.set(e.tokenId, Date.now());

  try {
    const rows = await db
      .select({
        address:      tracked_tokens.address,
        chain:        tracked_tokens.chain,
        name:         tracked_tokens.name,
        symbol:       tracked_tokens.symbol,
        marketCapUsd: tracked_tokens.marketCapUsd,
      })
      .from(tracked_tokens)
      .where(eq(tracked_tokens.id, e.tokenId))
      .limit(1);

    if (!rows.length) return;
    const token = rows[0];

    // G5 fix: first ever token:bought → "discovery"; subsequent buys → "post_buy".
    // discoveredTokens persists in-process so restarts reset to "discovery" for
    // any token not yet seen this session, which is acceptable.
    const snapshotType = discoveredTokens.has(e.tokenId) ? "post_buy" : "discovery";
    discoveredTokens.add(e.tokenId);

    pipelineQueue.enqueue<HoldersJobData>(
      "holders",
      {
        tokenId:      e.tokenId,
        address:      token.address,
        chain:        token.chain,
        name:         token.name,
        symbol:       token.symbol,
        marketCapUsd: token.marketCapUsd,
        snapshotType,
      },
      {
        priority: snapshotType === "post_buy" ? 8 : 10, // discovery > post_buy priority
        dedupKey: `holders:${e.tokenId}:${snapshotType}`,
        delayMs:  INITIAL_FETCH_DELAY,
      },
    );
  } catch (err) {
    logger.warn({ err, tokenId: e.tokenId }, "Holders refresh: initial enqueue failed (non-fatal)");
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

export function startHoldersRefresh(): void {
  registerQueueHandler();

  // On new token detection: enqueue a discovery snapshot after metadata settles
  eventBus.on("token:bought", (e: TokenBoughtEvent) => {
    scheduleInitialFetch(e).catch(err =>
      logger.warn({ err, tokenId: e.tokenId }, "Holders refresh: initial schedule error"),
    );
  });

  // Periodic cycle — enqueues hourly snapshots for momentum tokens
  setTimeout(() => {
    refreshCycle().catch(err => logger.error({ err }, "Holders refresh: unhandled cycle error"));
    setInterval(
      () => refreshCycle().catch(err => logger.error({ err }, "Holders refresh: unhandled cycle error")),
      REFRESH_INTERVAL_MS,
    );
  }, STARTUP_DELAY_MS);

  logger.info(
    `Holders refresh service started (queue-backed, concurrency=2, initial discovery ${INITIAL_FETCH_DELAY / 1000}s after detection)`,
  );
}
