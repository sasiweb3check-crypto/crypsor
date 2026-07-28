/**
 * Redis connection factory for Aiven (rediss:// TLS).
 *
 * Aiven uses a self-signed CA chain, so we must set
 * `tls: { rejectUnauthorized: false }` — the same pattern used for the
 * Aiven PostgreSQL connection in lib/db.
 *
 * BullMQ requires two specific ioredis options:
 *   maxRetriesPerRequest: null   (let BullMQ manage retries)
 *   enableReadyCheck: false      (avoid blocking on startup)
 */

import { Redis, type RedisOptions } from "ioredis";

export function parseRedisUrl(rawUrl: string): RedisOptions {
  const url = new URL(rawUrl);
  const opts: RedisOptions = {
    host:           url.hostname,
    port:           Number(url.port) || 6379,
    username:       url.username ? decodeURIComponent(url.username) : undefined,
    password:       url.password ? decodeURIComponent(url.password) : undefined,
    lazyConnect:    true,
    connectTimeout: 20_000,
    commandTimeout: 10_000,
    retryStrategy:  (times) => Math.min(times * 500, 5_000),
  };
  if (url.protocol === "rediss:") {
    opts.tls = { rejectUnauthorized: false };
  }
  return opts;
}

/**
 * Connection options for BullMQ.
 * BullMQ wraps ioredis internally and needs these two flags.
 */
export function getBullMQRedisOpts(): RedisOptions {
  const raw = process.env.AIVEN_REDIS_URL;
  if (!raw) throw new Error("AIVEN_REDIS_URL is required for BullMQ");
  return {
    ...parseRedisUrl(raw),
    maxRetriesPerRequest: null,
    enableReadyCheck:     false,
    lazyConnect:          false, // BullMQ connects eagerly on Worker creation
  };
}

/**
 * Create a plain ioredis client (pub/sub, health checks, etc.)
 * Does NOT use the BullMQ-specific flags — standard retry behaviour.
 */
export function createRedisClient(name = "redis"): Redis {
  const raw = process.env.AIVEN_REDIS_URL;
  if (!raw) throw new Error("AIVEN_REDIS_URL is required");
  const client = new Redis({ ...parseRedisUrl(raw), lazyConnect: false });
  client.on("error", (err: unknown) => {
    if (process.env.NODE_ENV !== "test") {
      console.error(`[redis:${name}] connection error:`, (err as Error).message ?? err);
    }
  });
  return client;
}
