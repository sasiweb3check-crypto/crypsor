/**
 * Response cache — in-memory TTL by default.
 *
 * Redis is optional. One Render instance does not need it: SSE busts the
 * memory cache and short TTLs keep the desk snappy. Set REDIS_URL only if
 * you ever run more than one process (we still recommend a single instance).
 */
import { logger } from "./log";

type Entry = { value: unknown; exp: number };

const mem = new Map<string, Entry>();
const MAX_KEYS = 400;

let redis: { get(k: string): Promise<string | null>; set(k: string, v: string, ...rest: unknown[]): Promise<unknown>; del(...k: string[]): Promise<unknown> } | null = null;
let redisTried = false;
let redisOk = false;
let gen = 1;

function prune(): void {
  if (mem.size <= MAX_KEYS) return;
  const now = Date.now();
  for (const [k, e] of mem) {
    if (e.exp <= now) mem.delete(k);
  }
  if (mem.size <= MAX_KEYS) return;
  const extra = mem.size - MAX_KEYS;
  let n = 0;
  for (const k of mem.keys()) {
    mem.delete(k);
    n += 1;
    if (n >= extra) break;
  }
}

async function ensureRedis(): Promise<typeof redis> {
  if (redisTried) return redisOk ? redis : null;
  redisTried = true;
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  try {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1_500,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    await client.connect();
    redis = client;
    redisOk = true;
    logger.info("cache: redis connected");
    return redis;
  } catch (err) {
    logger.warn({ err }, "cache: REDIS_URL set but connect failed — using memory");
    redis = null;
    redisOk = false;
    return null;
  }
}

function namespaced(key: string): string {
  return `crypsor:${gen}:${key}`;
}

export function cacheBackend(): "redis" | "memory" {
  return redisOk ? "redis" : "memory";
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const k = namespaced(key);
  const hit = mem.get(k);
  if (hit) {
    if (hit.exp > Date.now()) return hit.value as T;
    mem.delete(k);
  }
  const r = await ensureRedis();
  if (!r) return undefined;
  try {
    const raw = await r.get(k);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as T;
    mem.set(k, { value, exp: Date.now() + 4_000 });
    return value;
  } catch {
    return undefined;
  }
}

export async function cacheSet(key: string, value: unknown, ttlMs: number): Promise<void> {
  const k = namespaced(key);
  const ttl = Math.max(500, ttlMs);
  mem.set(k, { value, exp: Date.now() + ttl });
  prune();
  const r = await ensureRedis();
  if (!r) return;
  try {
    await r.set(k, JSON.stringify(value), "PX", ttl);
  } catch {
    // memory still holds it
  }
}

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const value = await fn();
  await cacheSet(key, value, ttlMs);
  return value;
}

/** Drop all API caches. Called from SSE so the desk refreshes without Redis. */
export function cacheBust(): void {
  gen += 1;
  mem.clear();
}
