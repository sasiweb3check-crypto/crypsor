/**
 * PipelineQueue — in-process priority job queue
 *
 * Provides the core BullMQ concepts (priority, dedup, concurrency, retries,
 * stats) without requiring Redis. All state is in-process; jobs do not
 * survive a server restart (acceptable for background pipeline work that
 * will be re-enqueued by the next scan cycle).
 *
 * Can be swapped for real BullMQ + Redis later without changing callers —
 * the public API mirrors BullMQ's Worker/Queue surface.
 */

import { logger as rootLogger } from "./logger";

const log = rootLogger.child({ module: "job-queue" });

// ── Types ─────────────────────────────────────────────────────────────────────

export type QueueName = "discovery" | "metadata" | "holders" | "price" | "migration";

export interface EnqueueOptions {
  /** Higher number = processed sooner. Default 0. */
  priority?: number;
  /**
   * If set, this job is skipped when an identical key is already waiting
   * or actively processing. Cleared when the job begins (so re-enqueue
   * after completion is allowed).
   */
  dedupKey?: string;
  /** Delay before the job becomes eligible for processing. */
  delayMs?: number;
}

interface PendingJob<T = unknown> {
  id:          string;
  name:        QueueName;
  data:        T;
  priority:    number;
  addedAt:     number;
  dedupKey:    string | undefined;
  attempts:    number;
  maxAttempts: number;
}

export type JobHandler<T = unknown> = (data: T, attempt: number) => Promise<void>;

// ── Per-queue configuration ────────────────────────────────────────────────────

const QUEUE_CONFIG: Record<QueueName, { concurrency: number; maxAttempts: number }> = {
  discovery: { concurrency: 5, maxAttempts: 3 },
  metadata:  { concurrency: 3, maxAttempts: 3 },
  holders:   { concurrency: 2, maxAttempts: 2 }, // rate-limit GMGN
  price:     { concurrency: 5, maxAttempts: 2 },
  migration: { concurrency: 2, maxAttempts: 2 },
};

// ── PipelineQueue ─────────────────────────────────────────────────────────────

export class PipelineQueue {
  private queues   = new Map<QueueName, PendingJob[]>();
  private dedup    = new Map<QueueName, Set<string>>();
  private active   = new Map<QueueName, number>();
  private handlers = new Map<QueueName, JobHandler<unknown>>();
  private stats    = new Map<QueueName, { processed: number; failed: number }>();

  constructor() {
    for (const name of Object.keys(QUEUE_CONFIG) as QueueName[]) {
      this.queues.set(name, []);
      this.dedup.set(name, new Set());
      this.active.set(name, 0);
      this.stats.set(name, { processed: 0, failed: 0 });
    }
  }

  // ── Registration ─────────────────────────────────────────────────────────────

  register<T>(name: QueueName, handler: JobHandler<T>): void {
    this.handlers.set(name, handler as JobHandler<unknown>);
    log.debug({ queue: name }, "Queue handler registered");
  }

  // ── Enqueue ───────────────────────────────────────────────────────────────────

  /**
   * Add a job to the named queue.
   * Returns `true` if enqueued, `false` if skipped (dedup hit).
   */
  enqueue<T>(name: QueueName, data: T, opts: EnqueueOptions = {}): boolean {
    const dedupKey = opts.dedupKey;
    const deduped  = this.dedup.get(name)!;

    if (dedupKey && deduped.has(dedupKey)) {
      log.debug({ queue: name, dedupKey }, "Job skipped (dedup hit)");
      return false;
    }

    if (dedupKey) deduped.add(dedupKey);

    const job: PendingJob<T> = {
      id:          `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      data,
      priority:    opts.priority ?? 0,
      addedAt:     Date.now(),
      dedupKey,
      attempts:    0,
      maxAttempts: QUEUE_CONFIG[name].maxAttempts,
    };

    // Insert maintaining descending priority order
    const queue = this.queues.get(name)!;
    const idx   = queue.findIndex(j => j.priority < job.priority);
    if (idx === -1) queue.push(job as PendingJob);
    else            queue.splice(idx, 0, job as PendingJob);

    if (opts.delayMs && opts.delayMs > 0) {
      setTimeout(() => this._drain(name), opts.delayMs);
    } else {
      setImmediate(() => this._drain(name));
    }

    return true;
  }

  // ── Drain ─────────────────────────────────────────────────────────────────────

  private async _drain(name: QueueName): Promise<void> {
    const config = QUEUE_CONFIG[name];
    const active = this.active.get(name)!;
    if (active >= config.concurrency) return;

    const queue = this.queues.get(name)!;
    const job   = queue.shift();
    if (!job) return;

    // Clear dedup as soon as job starts so re-enqueue after completion works
    if (job.dedupKey) {
      this.dedup.get(name)!.delete(job.dedupKey);
    }

    this.active.set(name, active + 1);

    const handler = this.handlers.get(name);
    if (!handler) {
      log.warn({ queue: name }, "No handler registered for queue — job dropped");
      this.active.set(name, (this.active.get(name) ?? 1) - 1);
      setImmediate(() => this._drain(name));
      return;
    }

    try {
      job.attempts++;
      await handler(job.data, job.attempts);
      this.stats.get(name)!.processed++;
    } catch (err) {
      log.warn({ queue: name, jobId: job.id, attempt: job.attempts, err }, "Job failed");
      if (job.attempts < job.maxAttempts) {
        // Exponential backoff re-enqueue
        const delay = 2_000 * job.attempts;
        if (job.dedupKey) this.dedup.get(name)!.add(job.dedupKey); // re-lock during retry
        setTimeout(() => {
          const q = this.queues.get(name)!;
          q.unshift(job); // back to front so it runs next
          this._drain(name).catch(() => {});
        }, delay);
        return; // don't release active slot yet (counted in dequeued, not re-queued)
      } else {
        this.stats.get(name)!.failed++;
      }
    } finally {
      this.active.set(name, Math.max(0, (this.active.get(name) ?? 1) - 1));
      setImmediate(() => this._drain(name));
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────────

  getStatus(): Record<QueueName, { waiting: number; active: number; processed: number; failed: number }> {
    const result = {} as Record<QueueName, { waiting: number; active: number; processed: number; failed: number }>;
    for (const name of Object.keys(QUEUE_CONFIG) as QueueName[]) {
      result[name as QueueName] = {
        waiting:   this.queues.get(name as QueueName)!.length,
        active:    this.active.get(name as QueueName)!,
        processed: this.stats.get(name as QueueName)!.processed,
        failed:    this.stats.get(name as QueueName)!.failed,
      };
    }
    return result;
  }

  /** Total jobs waiting across all queues */
  totalWaiting(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }
}

/** Singleton queue shared across the entire API server process. */
export const pipelineQueue = new PipelineQueue();
