import { db } from "@workspace/db";
import { walletdatasource } from "@workspace/db";
import { asc, lte, or, isNull, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { healthMonitor } from "./health-monitor";

export interface WalletJob {
  id: number;
  address: string;
  label: string;
  chain: string;
  priority: number;
}

// In-process queue — filled by scheduler, consumed by monitor workers
const queue: WalletJob[] = [];

/** Pick wallets whose next_scan_at is due and add them to the queue */
async function enqueueDue(): Promise<void> {
  try {
    const t0 = Date.now();
    const now = new Date();
    const due = await db
      .select({
        id:           walletdatasource.id,
        address:      walletdatasource.address,
        label:        walletdatasource.label,
        chain:        walletdatasource.chain,
        scanPriority: walletdatasource.scanPriority,
      })
      .from(walletdatasource)
      .where(or(isNull(walletdatasource.nextScanAt), lte(walletdatasource.nextScanAt, now)))
      .orderBy(asc(walletdatasource.scanPriority), asc(walletdatasource.nextScanAt));

    const alreadyQueued = new Set(queue.map(j => j.id));
    let added = 0;
    for (const w of due) {
      if (!alreadyQueued.has(w.id)) {
        queue.push({ id: w.id, address: w.address, label: w.label, chain: w.chain, priority: w.scanPriority });
        added++;
      }
    }
    if (added > 0) logger.debug({ added, queueSize: queue.length }, "Scheduler enqueued wallets");
    healthMonitor.ok("wallet-scheduler", Date.now() - t0);
  } catch (err) {
    healthMonitor.error("wallet-scheduler", err);
    logger.warn({ err }, "Scheduler enqueue failed");
  }
}

export function nextJob(): WalletJob | undefined {
  return queue.shift();
}

export function queueSize(): number {
  return queue.length;
}

/** Called after a successful wallet scan */
export async function markScanned(walletId: number, nextScanMs = 120_000): Promise<void> {
  try {
    await db.update(walletdatasource).set({
      lastScanAt:          new Date(),
      nextScanAt:          new Date(Date.now() + nextScanMs),
      backoffSeconds:      0,
      consecutiveFailures: 0,
      health:              "good",
      lastError:           null,
    }).where(eq(walletdatasource.id, walletId));
  } catch { /* non-fatal */ }
}

/** Called after a failed wallet scan — applies exponential backoff */
export async function markFailed(walletId: number, error: string): Promise<void> {
  try {
    const [row] = await db
      .select({ consecutiveFailures: walletdatasource.consecutiveFailures })
      .from(walletdatasource)
      .where(eq(walletdatasource.id, walletId))
      .limit(1);

    const failures = (row?.consecutiveFailures ?? 0) + 1;
    // 30s → 60s → 120s → 240s → 300s (cap)
    const backoff  = Math.min(300, 30 * Math.pow(2, Math.min(failures - 1, 4)));
    const health   = failures >= 5 ? "failing" : failures >= 3 ? "degraded" : "good";

    await db.update(walletdatasource).set({
      consecutiveFailures: failures,
      backoffSeconds:      backoff,
      nextScanAt:          new Date(Date.now() + backoff * 1_000),
      health,
      lastError:           error.slice(0, 500),
    }).where(eq(walletdatasource.id, walletId));
  } catch { /* non-fatal */ }
}

/** Start the scheduler — enqueues due wallets every 30 s */
export function startScheduler(): void {
  const run = () => {
    enqueueDue().catch(() => {}).finally(() => setTimeout(run, 30_000));
  };
  run();
  logger.info("Wallet scheduler started (30s poll, priority-ordered)");
}
