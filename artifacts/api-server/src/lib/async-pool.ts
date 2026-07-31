/**
 * Run async work over items with a fixed concurrency limit.
 * Prevents unbounded Promise.allSettled stampedes against the DB pool.
 */
export async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!, i);
    }
  });

  await Promise.all(workers);
}

/**
 * Coalescing work queue keyed by numeric id.
 * Multiple schedule(id) calls collapse to one run; work drains with limited concurrency.
 */
export class CoalesceQueue {
  private dirty = new Set<number>();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly handler: (id: number) => Promise<void>,
    private readonly opts: { concurrency?: number; debounceMs?: number } = {},
  ) {}

  schedule(id: number): void {
    this.dirty.add(id);
    if (this.timer !== null || this.running) return;
    const delay = this.opts.debounceMs ?? 100;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const concurrency = this.opts.concurrency ?? 3;
    try {
      while (this.dirty.size > 0) {
        const batch = [...this.dirty];
        this.dirty.clear();
        await mapPool(batch, concurrency, (id) => this.handler(id));
      }
    } finally {
      this.running = false;
      if (this.dirty.size > 0) {
        // More work arrived during the final batch — re-arm.
        this.schedule(this.dirty.values().next().value!);
      }
    }
  }
}
