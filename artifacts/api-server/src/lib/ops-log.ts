/**
 * Lightweight in-memory ops ring-buffer for pipeline visibility.
 * Optional Redis mirror when AIVEN_REDIS_URL is set (survives restarts).
 * Never throws into callers — logging must not affect scan/alert latency.
 */

import { logger } from "./logger";

const log = logger.child({ module: "ops-log" });

export type OpsKind =
  | "helius"
  | "wallet_buy"
  | "scan"
  | "pro_qualify"
  | "telegram"
  | "blocker"
  | "api"
  | "runner"
  | "dex";

export type OpsLevel = "info" | "warn" | "error";

export interface OpsEvent {
  id: number;
  ts: string;
  kind: OpsKind;
  level: OpsLevel;
  msg: string;
  meta?: Record<string, unknown>;
  latencyMs?: number;
}

const MAX_EVENTS = 500;
const REDIS_KEY = "crypsor:ops:log";
const REDIS_MAX = 400;

const ring: OpsEvent[] = [];
let seq = 0;

/** Rolling counters for summary (cheap, no DB). */
const counters = {
  heliusOk: 0,
  heliusErr: 0,
  buys: 0,
  proInserted: 0,
  telegramOk: 0,
  telegramErr: 0,
  lastHeliusLatencyMs: null as number | null,
  lastHeliusError: null as string | null,
  lastHeliusOkAt: null as string | null,
  lastBuyAt: null as string | null,
  lastTelegramOkAt: null as string | null,
  lastTelegramError: null as string | null,
  lastProQualifyAt: null as string | null,
  lastScanBuys: 0,
};

export function getOpsCounters() {
  return { ...counters };
}

export function opsLog(
  kind: OpsKind,
  level: OpsLevel,
  msg: string,
  meta?: Record<string, unknown>,
  latencyMs?: number,
): void {
  try {
    const event: OpsEvent = {
      id: ++seq,
      ts: new Date().toISOString(),
      kind,
      level,
      msg: msg.slice(0, 280),
      meta: meta && Object.keys(meta).length ? meta : undefined,
      latencyMs,
    };
    ring.push(event);
    if (ring.length > MAX_EVENTS) ring.splice(0, ring.length - MAX_EVENTS);

    // Counters
    if (kind === "helius") {
      if (level === "error" || level === "warn") {
        counters.heliusErr++;
        counters.lastHeliusError = msg;
      } else {
        counters.heliusOk++;
        counters.lastHeliusOkAt = event.ts;
        counters.lastHeliusError = null;
      }
      if (latencyMs != null) counters.lastHeliusLatencyMs = latencyMs;
    } else if (kind === "wallet_buy") {
      counters.buys++;
      counters.lastBuyAt = event.ts;
    } else if (kind === "pro_qualify" && level === "info" && meta?.inserted) {
      counters.proInserted++;
      counters.lastProQualifyAt = event.ts;
    } else if (kind === "pro_qualify") {
      counters.lastProQualifyAt = event.ts;
    } else if (kind === "telegram") {
      if (level === "error" || level === "warn") {
        counters.telegramErr++;
        counters.lastTelegramError = msg;
      } else {
        counters.telegramOk++;
        counters.lastTelegramOkAt = event.ts;
        counters.lastTelegramError = null;
      }
    } else if (kind === "scan" && typeof meta?.buys === "number") {
      counters.lastScanBuys = meta.buys as number;
    }

    // Fire-and-forget Redis mirror
    void mirrorToRedis(event);
  } catch (err) {
    log.debug({ err }, "opsLog swallow");
  }
}

async function mirrorToRedis(event: OpsEvent): Promise<void> {
  const url = process.env.AIVEN_REDIS_URL?.trim();
  if (!url) return;
  try {
    const { proCacheGet, proCacheSet } = await import("./pro-cache");
    // Reuse a small list stored as JSON array under one key via pro-cache Set
    // (simpler than raw Redis LPUSH when client may be memory-only).
    const key = REDIS_KEY;
    const prev = (await proCacheGet<OpsEvent[]>(key)) ?? [];
    prev.unshift(event);
    if (prev.length > REDIS_MAX) prev.length = REDIS_MAX;
    await proCacheSet(key, prev, 86_400);
  } catch {
    /* ignore */
  }
}

export function getOpsLog(opts?: {
  limit?: number;
  kind?: OpsKind | "all";
  level?: OpsLevel | "all";
}): OpsEvent[] {
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 300);
  let out = ring.slice();
  if (opts?.kind && opts.kind !== "all") {
    out = out.filter(e => e.kind === opts.kind);
  }
  if (opts?.level && opts.level !== "all") {
    out = out.filter(e => e.level === opts.level);
  }
  return out.slice(-limit).reverse();
}

/** Merge memory + Redis (Redis may have history from other restarts/instances). */
export async function getOpsLogMerged(opts?: {
  limit?: number;
  kind?: OpsKind | "all";
  level?: OpsLevel | "all";
}): Promise<OpsEvent[]> {
  const mem = getOpsLog({ limit: 300 });
  let redis: OpsEvent[] = [];
  try {
    if (process.env.AIVEN_REDIS_URL?.trim()) {
      const { proCacheGet } = await import("./pro-cache");
      // Bound Redis wait so Logs tab never stalls on a slow cache hop
      redis = await Promise.race([
        proCacheGet<OpsEvent[]>(REDIS_KEY).then(v => v ?? []),
        new Promise<OpsEvent[]>(resolve => setTimeout(() => resolve([]), 800)),
      ]);
    }
  } catch {
    redis = [];
  }
  const byId = new Map<string, OpsEvent>();
  for (const e of [...redis, ...mem]) {
    const k = `${e.ts}:${e.kind}:${e.msg}`;
    if (!byId.has(k)) byId.set(k, e);
  }
  let merged = Array.from(byId.values()).sort(
    (a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime(),
  );
  if (opts?.kind && opts.kind !== "all") {
    merged = merged.filter(e => e.kind === opts.kind);
  }
  if (opts?.level && opts.level !== "all") {
    merged = merged.filter(e => e.level === opts.level);
  }
  return merged.slice(0, Math.min(Math.max(opts?.limit ?? 100, 1), 300));
}
