import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus, type PriceUpdatedEvent } from "./event-bus";
import { healthMonitor } from "./health-monitor";
import { CoalesceQueue } from "../lib/async-pool";

// ── Market cap lifecycle thresholds (USD) ─────────────────────────────────────
const MC = {
  ACTIVE:         50_000,  // >= $50K  → active
  WATCH:          10_000,  // >= $10K  → watch
  ARCHIVE:         4_500,  // < $4.5K  → triggers archive (with hysteresis)
  REVIVE_WATCH:    8_000,  // archived/dumped → revived (watch-level recovery)
  REVIVE_ACTIVE:  20_000,  // archived/dumped → active directly (skips revived)
} as const;

// ── Dump detection thresholds ─────────────────────────────────────────────────
// A token is "dumped" when it has had a meaningful run (ATH >= $10K) but has
// since drawn down >75% from that ATH. This is smarter than the MC-floor archive.
const DUMP_ATH_FLOOR   = 10_000; // ATH must have been at least $10K for dump to trigger
const DUMP_DRAWDOWN    = 0.75;   // >75% decline from ATH → dumped

type LifecycleStatus = "new" | "active" | "watch" | "archive" | "revived" | "dumped";

// ── In-memory hysteresis: consecutive archive-eligible check counts ────────────
// A token must be below MC.ARCHIVE for ARCHIVE_CONSECUTIVE_REQUIRED consecutive
// price-update cycles before it transitions to "archive". This prevents tokens
// oscillating in the $4.5K–$12K range from getting stuck.
const ARCHIVE_CONSECUTIVE_REQUIRED = 2;
const archivePending = new Map<number, number>(); // tokenId → consecutive count

function computeNextStatus(
  mc: number,
  athMc: number,
  current: string,
): LifecycleStatus | "pending_archive" {
  // ── Dumped tokens: check revival thresholds (same as archive) ─────────────
  if (current === "dumped") {
    if (mc >= MC.REVIVE_ACTIVE) return "active";
    if (mc >= MC.REVIVE_WATCH)  return "revived";
    return "dumped";
  }

  // ── Archived tokens: check revival thresholds ──────────────────────────────
  if (current === "archive") {
    if (mc >= MC.REVIVE_ACTIVE) return "active";   // strong recovery → skip revived
    if (mc >= MC.REVIVE_WATCH)  return "revived";  // partial recovery
    return "archive";                               // still below revival floor
  }

  // ── Dump zone: >75% drawdown from a meaningful ATH ────────────────────────
  // Only triggers when the token had a real run (ATH >= DUMP_ATH_FLOOR).
  if (athMc >= DUMP_ATH_FLOOR && mc < athMc * (1 - DUMP_DRAWDOWN)) {
    return "dumped";
  }

  // ── Standard tier rules ───────────────────────────────────────────────────
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
    // Compute current ATH before decision so dump-detection can use it
    const athMcCurrent = athMarketCapUsd ? parseFloat(athMarketCapUsd) : 0;
    const decision = computeNextStatus(mc, athMcCurrent, prev);

    // ── Hysteresis gate for archive ───────────────────────────────────────────
    let next: LifecycleStatus;
    if (decision === "pending_archive") {
      const count = (archivePending.get(e.tokenId) ?? 0) + 1;
      if (count < ARCHIVE_CONSECUTIVE_REQUIRED) {
        archivePending.set(e.tokenId, count);
        // Still accumulating — update ATH only, no status change
        const newAth = mc > athMcCurrent ? String(mc) : (athMarketCapUsd ?? String(mc));
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

    const newAth = mc > athMcCurrent ? String(mc) : (athMarketCapUsd ?? String(mc));

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
  // Coalesce + bound concurrency: a price refresh can emit hundreds of
  // price:updated events; firing applyLifecycle for each in parallel exhausted
  // the Postgres pool and contributed to Render crash loops.
  const pending = new Map<number, PriceUpdatedEvent>();
  const queue = new CoalesceQueue(
    async (tokenId) => {
      const evt = pending.get(tokenId);
      pending.delete(tokenId);
      if (evt) await applyLifecycle(evt);
    },
    { concurrency: 3, debounceMs: 150 },
  );

  eventBus.on("price:updated", (e) => {
    pending.set(e.tokenId, e); // keep latest payload per token
    queue.schedule(e.tokenId);
  });
  logger.info(
    `Lifecycle engine started — hysteresis: ${ARCHIVE_CONSECUTIVE_REQUIRED} consecutive checks to archive ` +
    `| dump: >${DUMP_DRAWDOWN * 100}% drawdown from ATH>=$${(DUMP_ATH_FLOOR / 1000).toFixed(0)}K ` +
    `| revival: >=$${(MC.REVIVE_WATCH / 1000).toFixed(0)}K→revived, >=$${(MC.REVIVE_ACTIVE / 1000).toFixed(0)}K→active`,
  );
}
