import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus, type PriceUpdatedEvent } from "./event-bus";
import { healthMonitor } from "./health-monitor";

// ── Market cap lifecycle thresholds (USD) ─────────────────────────────────────
const MC = {
  ACTIVE:         50_000,  // >= $50K  → active
  WATCH:          10_000,  // >= $10K  → watch
  ARCHIVE:         4_500,  // < $4.5K  → triggers archive (with hysteresis)
  REVIVE_WATCH:    8_000,  // archived → revived (watch-level recovery)
  REVIVE_ACTIVE:  20_000,  // archived → active directly (skips revived)
} as const;

type LifecycleStatus = "new" | "active" | "watch" | "archive" | "revived";

// ── In-memory hysteresis: consecutive archive-eligible check counts ────────────
// A token must be below MC.ARCHIVE for ARCHIVE_CONSECUTIVE_REQUIRED consecutive
// price-update cycles before it transitions to "archive". This prevents tokens
// oscillating in the $4.5K–$12K range from getting stuck.
const ARCHIVE_CONSECUTIVE_REQUIRED = 2;
const archivePending = new Map<number, number>(); // tokenId → consecutive count

function computeNextStatus(mc: number, current: string): LifecycleStatus | "pending_archive" {
  // ── Archived tokens: check revival thresholds ──────────────────────────────
  if (current === "archive") {
    if (mc >= MC.REVIVE_ACTIVE) return "active";   // strong recovery → skip revived
    if (mc >= MC.REVIVE_WATCH)  return "revived";  // partial recovery
    return "archive";                               // still below revival floor
  }

  // ── All other statuses: standard tier rules ────────────────────────────────
  if (mc >= MC.ACTIVE) return "active";
  if (mc >= MC.WATCH)  return "watch";

  // Below archive trigger → needs ARCHIVE_CONSECUTIVE_REQUIRED consecutive checks
  if (mc < MC.ARCHIVE) return "pending_archive";

  // Grey zone [$4.5K, $10K) → no change
  return current as LifecycleStatus;
}

async function applyLifecycle(e: PriceUpdatedEvent): Promise<void> {
  const t0 = Date.now();
  try {
    if (!e.marketCapUsd) return;
    const mc = parseFloat(e.marketCapUsd);
    if (!isFinite(mc) || mc <= 0) return;

    const rows = await db
      .select({
        status:          tracked_tokens.status,
        athMarketCapUsd: tracked_tokens.athMarketCapUsd,
      })
      .from(tracked_tokens)
      .where(eq(tracked_tokens.id, e.tokenId))
      .limit(1);

    if (!rows.length) return;
    const { status: prev, athMarketCapUsd } = rows[0];
    const decision = computeNextStatus(mc, prev);

    // ── Hysteresis gate for archive ───────────────────────────────────────────
    let next: LifecycleStatus;
    if (decision === "pending_archive") {
      const count = (archivePending.get(e.tokenId) ?? 0) + 1;
      if (count < ARCHIVE_CONSECUTIVE_REQUIRED) {
        archivePending.set(e.tokenId, count);
        // Still accumulating — update ATH only, no status change
        const athMc = athMarketCapUsd ? parseFloat(athMarketCapUsd) : 0;
        const newAth = mc > athMc ? String(mc) : (athMarketCapUsd ?? String(mc));
        await db.update(tracked_tokens)
          .set({ athMarketCapUsd: newAth })
          .where(eq(tracked_tokens.id, e.tokenId));
        healthMonitor.ok("lifecycle-engine", Date.now() - t0);
        return;
      }
      // Threshold reached — commit archive
      archivePending.delete(e.tokenId);
      next = "archive";
    } else {
      // Clear any pending archive counter — token recovered
      if (archivePending.has(e.tokenId)) archivePending.delete(e.tokenId);
      next = decision;
    }

    const athMc  = athMarketCapUsd ? parseFloat(athMarketCapUsd) : 0;
    const newAth = mc > athMc ? String(mc) : (athMarketCapUsd ?? String(mc));

    // ── Status transition ─────────────────────────────────────────────────────
    const statusChanged = next !== prev;
    if (statusChanged) {
      logger.info(
        { tokenId: e.tokenId, from: prev, to: next, mc: Math.round(mc) },
        "Lifecycle transition",
      );
    }

    await db.update(tracked_tokens)
      .set({
        status:          next,
        athMarketCapUsd: newAth,
        ...(statusChanged ? { lastStatusChangeAt: new Date() } : {}),
      })
      .where(eq(tracked_tokens.id, e.tokenId));

    healthMonitor.ok("lifecycle-engine", Date.now() - t0);
  } catch (err) {
    healthMonitor.error("lifecycle-engine", err);
    logger.warn({ err, tokenId: e.tokenId }, "Lifecycle update failed");
  }
}

export function startLifecycleEngine() {
  eventBus.on("price:updated", (e) => {
    applyLifecycle(e).catch(() => {});
  });
  logger.info(
    `Lifecycle engine started — hysteresis: ${ARCHIVE_CONSECUTIVE_REQUIRED} consecutive checks to archive ` +
    `| revival: >=$${(MC.REVIVE_WATCH / 1000).toFixed(0)}K→revived, >=$${(MC.REVIVE_ACTIVE / 1000).toFixed(0)}K→active`,
  );
}
