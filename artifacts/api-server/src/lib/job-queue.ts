/**
 * PipelineQueue — BullMQ-backed priority job queue.
 *
 * Drop-in replacement for the old in-process PipelineQueue.  Public API
 * is unchanged so all callers (metadata-service, holders-refresh, etc.)
 * require no modification.
 *
 * Key differences from the in-process version:
 *   • Jobs are durable: stored in Aiven Redis, survive process restarts.
 *   • Workers are created by calling register(); the queue itself is safe
 *     to import in the API process (Queue instances connect lazily).
 *   • Dedup via BullMQ jobId: a second enqueue() with the same dedupKey
 *     while the job is still waiting is silently ignored by BullMQ.
 *   • Priority is inverted: callers use "higher = sooner" (same as before);
 *     we convert to BullMQ's "lower number = higher priority" internally.
 *   • totalWaiting() is synchronous via a cached counter updated every 5 s
 *     (only in worker process — triggered by the first register() call).
 */

import { Queue, Worker, type JobsOptions, type WorkerOptions } from "bullmq";
import { getBullMQRedisOpts } from "./redis";
import { logger as rootLogger } from "./logger";

const log = rootLogger.child({ module: "job-queue" });

// ── Types (unchanged public API) ──────────────────────────────────────────────

export type QueueName = "discovery" | "metadata" | "holders" | "price" | "migration";

export interface EnqueueOptions {
  /** Higher number = processed sooner. Default 0. */
  priority?: number;
  /**
   * If set, BullMQ deduplicates: a job with this jobId that is already
   * waiting or delayed will not be replaced by a new one.
   */
  dedupKey?: string;
  /** Delay before the job becomes eligible (milliseconds). */
  delayMs?: number;
}

export type JobHandler<T = unknown> = (data: T, attempt: number) => Promise<void>;

// ── Per-queue configuration ───────────────────────────────────────────────────

const QUEUE_CONFIG: Record<QueueName, { concurrency: number; maxAttempts: number }> = {
  discovery: { concurrency: 5, maxAttempts: 3 },
  metadata:  { concurrency: 3, maxAttempts: 3 },
  holders:   { concurrency: 2, maxAttempts: 2 }, // rate-limit GMGN
  price:     { concurrency: 5, maxAttempts: 2 },
  migration: { concurrency: 2, maxAttempts: 2 },
};

// ── PipelineQueue ─────────────────────────────────────────────────────────────

export class PipelineQueue {
  private queues  = new Map<QueueName, Queue>();
  private workers = new Map<QueueName, Worker>();
  private stats   = new Map<QueueName, { waiting: number; processed: number; failed: number }>();
  private cachedTotalWaiting = 0;
  private pollingStarted     = false;

  constructor() {
    const connection = getBullMQRedisOpts();
    for (const name of Object.keys(QUEUE_CONFIG) as QueueName[]) {
      this.queues.set(name, new Queue(name, {
        connection,
        defaultJobOptions: {
          removeOnComplete: { count: 20 },
          removeOnFail:     { count: 10 },
        },
      }));
      this.stats.set(name, { waiting: 0, processed: 0, failed: 0 });
    }
  }

  // ── Private: background waiting-count refresh ──────────────────────────────

  private _startPolling(): void {
    if (this.pollingStarted) return;
    this.pollingStarted = true;
    setInterval(() => this._refreshWaitingCounts(), 5_000);
  }

  private async _refreshWaitingCounts(): Promise<void> {
    try {
      const entries = Array.from(this.queues.entries()) as [QueueName, Queue][];
      const counts  = await Promise.all(entries.map(([, q]) => q.getWaitingCount()));
      let total = 0;
      entries.forEach(([name], i) => {
        this.stats.get(name)!.waiting = counts[i];
        total += counts[i];
      });
      this.cachedTotalWaiting = total;
    } catch { /* non-fatal */ }
  }

  // ── Registration ───────────────────────────────────────────────────────────

  register<T>(name: QueueName, handler: JobHandler<T>): void {
    this._startPolling(); // Only poll when running as worker

    if (this.workers.has(name)) {
      log.warn({ queue: name }, "Queue handler already registered — skipping");
      return;
    }

    const config     = QUEUE_CONFIG[name];
    const connection = getBullMQRedisOpts();

    const worker = new Worker<Record<string, unknown>>(
      name,
      async (job) => {
        await handler(job.data as unknown as T, job.attemptsMade + 1);
        this.stats.get(name)!.processed++;
      },
      {
        connection,
        concurrency: config.concurrency,
        removeOnComplete: { count: 20 },
        removeOnFail:     { count: 10 },
      } as WorkerOptions,
    );

    worker.on("failed", (job, err) => {
      this.stats.get(name)!.failed++;
      log.warn({ queue: name, jobId: job?.id, attempt: job?.attemptsMade, err }, "Job failed");
    });

    worker.on("error", (err) => {
      log.error({ queue: name, err }, "Worker error");
    });

    this.workers.set(name, worker as unknown as Worker);
    log.debug({ queue: name, concurrency: config.concurrency }, "Queue handler registered");
  }

  // ── Enqueue ────────────────────────────────────────────────────────────────

  /**
   * Add a job to the named queue.
   * Always returns true — BullMQ silently deduplicates by jobId so we cannot
   * determine synchronously whether the job was enqueued or skipped.
   */
  enqueue<T>(name: QueueName, data: T, opts: EnqueueOptions = {}): boolean {
    const queue = this.queues.get(name)!;
    const config = QUEUE_CONFIG[name];

    const jobOpts: JobsOptions = {
      attempts: config.maxAttempts,
      backoff:  { type: "exponential", delay: 2_000 },
    };

    // BullMQ rejects job IDs containing ":" (reserved for its repeat key format).
    // Sanitize by replacing colons with hyphens to preserve uniqueness.
    if (opts.dedupKey)                   jobOpts.jobId    = opts.dedupKey.replace(/:/g, "-");
    if (opts.priority !== undefined)     jobOpts.priority = Math.max(1, 100 - opts.priority);
    if (opts.delayMs  && opts.delayMs > 0) jobOpts.delay  = opts.delayMs;

    queue.add(name, data as Record<string, unknown>, jobOpts).catch(err => {
      log.warn({ err, queue: name }, "Failed to enqueue job");
    });

    return true;
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  getStatus(): Record<QueueName, { waiting: number; active: number; processed: number; failed: number }> {
    const result = {} as Record<QueueName, { waiting: number; active: number; processed: number; failed: number }>;
    for (const name of Object.keys(QUEUE_CONFIG) as QueueName[]) {
      const s = this.stats.get(name as QueueName)!;
      result[name as QueueName] = {
        waiting:   s.waiting,
        active:    0, // BullMQ tracks this internally; not critical for dashboard
        processed: s.processed,
        failed:    s.failed,
      };
    }
    return result;
  }

  /** Total jobs waiting across all queues (cached; updated every 5 s in worker). */
  totalWaiting(): number {
    return this.cachedTotalWaiting;
  }

  async close(): Promise<void> {
    await Promise.all([
      ...Array.from(this.workers.values()).map(w => w.close()),
      ...Array.from(this.queues.values()).map(q => q.close()),
    ]);
  }
}

/** Singleton queue shared across the entire process. */
export const pipelineQueue = new PipelineQueue();
