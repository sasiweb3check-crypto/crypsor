/**
 * Projection Engine
 *
 * Listens to price:updated and token:bought events.
 * Computes all derived metrics (gainPct, athGainPct, buyPressure) and writes
 * them to the DB so that routes and the dashboard never compute anything.
 *
 * Philosophy: token_state is the source of truth. Dashboard reads, never computes.
 *
 * Crash-hardening: never fan out one DB round-trip per token with unbounded
 * Promise.allSettled / EventEmitter concurrency — that exhausted the Postgres
 * pool (max ~5–8) and took the Render free instance down in a restart loop.
 */

import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq, notInArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus } from "./event-bus";
import { healthMonitor } from "./health-monitor";
import { CoalesceQueue, mapPool } from "../lib/async-pool";

const FULL_PASS_CONCURRENCY = 3;
const EVENT_CONCURRENCY = 3;
/** Skip cold tokens on the periodic full pass — event path still covers hot ones. */
const COLD_STATUSES = ["archive", "dumped"] as const;

// Weighted buy pressure score — recent windows count more
function computeBuyPressure(m5: number, m15: number, m30: number, m1h: number, m6h: number): number {
  return m5 * 10 + m15 * 5 + m30 * 3 + m1h * 2 + m6h * 1;
}

async function projectToken(tokenId: number): Promise<void> {
  const t0 = Date.now();
  try {
    const [token] = await db
      .select({
        id:               tracked_tokens.id,
        address:          tracked_tokens.address,
        detectedPriceUsd: tracked_tokens.detectedPriceUsd,
        currentPriceUsd:  tracked_tokens.currentPriceUsd,
        athPriceUsd:      tracked_tokens.athPriceUsd,
        momentum5m:       tracked_tokens.momentum5m,
        momentum15m:      tracked_tokens.momentum15m,
        momentum30m:      tracked_tokens.momentum30m,
        momentum1h:       tracked_tokens.momentum1h,
        momentum6h:       tracked_tokens.momentum6h,
        status:           tracked_tokens.status,
      })
      .from(tracked_tokens)
      .where(eq(tracked_tokens.id, tokenId))
      .limit(1);

    if (!token) return;

    const detected = token.detectedPriceUsd ? parseFloat(token.detectedPriceUsd) : null;
    const current  = token.currentPriceUsd  ? parseFloat(token.currentPriceUsd)  : null;
    const ath      = token.athPriceUsd      ? parseFloat(token.athPriceUsd)      : null;

    const gainPct    = detected && current && detected > 0 ? ((current - detected) / detected) * 100 : null;
    const athGainPct = detected && ath    && detected > 0 ? ((ath    - detected) / detected) * 100 : null;
    const buyPressure = computeBuyPressure(
      token.momentum5m, token.momentum15m, token.momentum30m,
      token.momentum1h, token.momentum6h,
    );

    await db.update(tracked_tokens).set({ gainPct, athGainPct, buyPressure }).where(eq(tracked_tokens.id, tokenId));

    // Broadcast to SSE clients
    eventBus.emit("projection:updated", {
      tokenId,
      tokenAddress: token.address,
      gainPct,
      athGainPct,
      buyPressure,
      status: token.status,
    });

    healthMonitor.ok("projection-engine", Date.now() - t0);
  } catch (err) {
    healthMonitor.error("projection-engine", err);
    logger.warn({ err, tokenId }, "Projection failed for token");
  }
}

const projectQueue = new CoalesceQueue(
  (tokenId) => projectToken(tokenId),
  { concurrency: EVENT_CONCURRENCY, debounceMs: 150 },
);

/** Full pass — reproject live tokens with bounded concurrency. */
export async function projectAll(): Promise<void> {
  try {
    const tokens = await db
      .select({ id: tracked_tokens.id })
      .from(tracked_tokens)
      .where(notInArray(tracked_tokens.status, [...COLD_STATUSES]));

    await mapPool(tokens, FULL_PASS_CONCURRENCY, (t: { id: number }) => projectToken(t.id));
  } catch (err) {
    logger.warn({ err }, "Projection full-pass failed");
  }
}

/**
 * Start the projection engine.
 * Periodic full-pass runs every 60 s with a 3 s initial delay.
 * Event-driven per-token projections are coalesced + concurrency-limited.
 */
export function startProjectionEngine(): void {
  healthMonitor.register("projection-engine");

  eventBus.on("price:updated", (evt) => {
    projectQueue.schedule(evt.tokenId);
  });

  eventBus.on("token:bought", (evt) => {
    projectQueue.schedule(evt.tokenId);
  });

  // Periodic full-pass — completion-chained to prevent overlapping runs
  const loop = () => {
    projectAll()
      .catch(err => logger.warn({ err }, "Projection full-pass failed"))
      .finally(() => setTimeout(loop, 60_000));
  };
  setTimeout(loop, 3_000);

  logger.info("Projection engine started (coalesced events + 60 s full-pass, concurrency 3)");
}
