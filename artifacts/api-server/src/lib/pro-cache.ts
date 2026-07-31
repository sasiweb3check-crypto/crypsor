/**
 * Lightweight cache for Pro API — Redis when AIVEN_REDIS_URL is set,
 * otherwise in-process Map. Failures never break requests.
 */

import type { Redis } from "ioredis";
import { logger } from "./logger";

const log = logger.child({ module: "pro-cache" });

const memory = new Map<string, { expires: number; body: string }>();
let redis: Redis | null | undefined; // undefined = not tried yet

async function getRedis(): Promise<Redis | null> {
  if (redis !== undefined) return redis;
  const url = process.env.AIVEN_REDIS_URL?.trim();
  if (!url) {
    redis = null;
    return null;
  }
  try {
    const { createRedisClient } = await import("./redis");
    const client = createRedisClient("pro-cache");
    // Probe once
    await client.ping();
    redis = client;
    log.info("Pro cache using Redis");
    return redis;
  } catch (err) {
    log.warn({ err }, "Pro cache Redis unavailable — using memory");
    redis = null;
    return null;
  }
}

export async function proCacheGet<T>(key: string): Promise<T | null> {
  try {
    const r = await getRedis();
    if (r) {
      const raw = await r.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    }
  } catch {
    /* fall through to memory */
  }
  const hit = memory.get(key);
  if (!hit || hit.expires < Date.now()) {
    if (hit) memory.delete(key);
    return null;
  }
  try {
    return JSON.parse(hit.body) as T;
  } catch {
    return null;
  }
}

export async function proCacheSet(key: string, value: unknown, ttlSec: number): Promise<void> {
  const body = JSON.stringify(value);
  try {
    const r = await getRedis();
    if (r) {
      await r.set(key, body, "EX", Math.max(1, ttlSec));
      return;
    }
  } catch {
    /* memory fallback */
  }
  memory.set(key, { body, expires: Date.now() + ttlSec * 1000 });
  // Cap memory map
  if (memory.size > 200) {
    const first = memory.keys().next().value;
    if (first) memory.delete(first);
  }
}

/** Drop Pro feed/stats caches so a new call is visible on the next request. */
export async function invalidateProCaches(): Promise<void> {
  try {
    for (const key of [...memory.keys()]) {
      if (key.startsWith("pro:feed:") || key.startsWith("pro:stats:")) memory.delete(key);
    }
    const r = await getRedis();
    if (r) {
      // Known keys — keep simple (no KEYS scan on Redis)
      const keys = [
        "pro:stats:v2",
        "pro:stats:v3",
        "pro:feed:v2:150",
        "pro:feed:v2:200",
        "pro:feed:v2:300",
        "pro:feed:v2:400",
        "pro:feed:v4:150",
        "pro:feed:v4:200",
        "pro:feed:v4:300",
        "pro:feed:v4:400",
        "pro:feed:v5:150",
        "pro:feed:v5:200",
        "pro:feed:v5:300",
        "pro:feed:v5:400",
        "pro:feed:v6:150",
        "pro:feed:v6:200",
        "pro:feed:v6:300",
        "pro:feed:v6:400",
        "pro:feed:v7:150",
        "pro:feed:v7:200",
        "pro:feed:v7:300",
        "pro:feed:v7:400",
      ];
      if (keys.length) await r.del(...keys);
    }
  } catch {
    /* never break callers */
  }
}

/** Normalize PG timestamp-without-tz / Date into ISO UTC string. */
export function toIsoUtc(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  }
  const s = String(value).trim();
  if (!s) return null;
  if (/Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // "2026-07-31 08:06:00.531" or "2026-07-31T08:06:00.531" → treat as UTC
  const normalized = s.includes("T") ? `${s}Z` : `${s.replace(" ", "T")}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
