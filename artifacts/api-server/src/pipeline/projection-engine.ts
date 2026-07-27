/**
 * Projection Engine
 *
 * Listens to price:updated and token:bought events.
 * Computes all derived metrics (gainPct, athGainPct, buyPressure) and writes
 * them to the DB so that routes and the dashboard never compute anything.
 *
 * Philosophy: token_state is the source of truth. Dashboard reads, never computes.
 */

import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus } from "./event-bus";
import { healthMonitor } from "./health-monitor";

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

/** Full pass — reproject every token. Runs on startup and every 60 s. */
async function projectAll(): Promise<void> {
  try {
    const tokens = await db.select({ id: tracked_tokens.id }).from(tracked_tokens);
    await Promise.allSettled(tokens.map(t => projectToken(t.id)));
  } catch (err) {
    logger.warn({ err }, "Projection full-pass failed");
  }
}

export function startProjectionEngine(): void {
  healthMonitor.register("projection-engine");

  // React to price updates
  eventBus.on("price:updated", async (evt) => {
    await projectToken(evt.tokenId);
  });

  // React to new buys (momentum changed)
  eventBus.on("token:bought", async (evt) => {
    await projectToken(evt.tokenId);
  });

  // Full pass on startup then every 60 s
  setTimeout(() => projectAll(), 3_000);
  setInterval(() => projectAll(), 60_000);

  logger.info("Projection engine started");
}
