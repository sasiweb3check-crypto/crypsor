/**
 * GMGN Official OpenAPI client — https://openapi.gmgn.ai
 *
 * Auth (https://gmgn.ai/ai):
 *   Header: X-APIKEY: <key>
 *   Query:  timestamp (unix sec) + client_id (uuid)
 *
 * Rate limit (docs): leaky bucket rate=20, capacity=20.
 * Route weights: token info/security/pool=1, holders/traders=5, kline=2, trenches=3.
 * On RATE_LIMIT_BANNED respect reset_at — do NOT spam (extends ban).
 *
 * Website scrape of gmgn.ai is a separate path; the API key does not bypass CF there.
 */

import { randomUUID } from "node:crypto";
import { logger as rootLogger } from "./logger";
import type { GmgnResult } from "./gmgn-client";

const log = rootLogger.child({ module: "gmgn-openapi" });

const OPENAPI_HOST = (process.env.GMGN_OPENAPI_HOST ?? "https://openapi.gmgn.ai").replace(/\/$/, "");

/** Docs: leaky-bucket rate=20 capacity=20 */
const BUCKET_CAPACITY = 20;
const BUCKET_RATE_PER_SEC = 18; // stay slightly under advertised 20
const CACHE_TTL_MS = 12_000;

const ROUTE_WEIGHT: Record<string, number> = {
  "/v1/token/info": 1,
  "/v1/token/security": 1,
  "/v1/token/pool_info": 1,
  "/v1/market/token_top_holders": 5,
  "/v1/market/token_top_traders": 5,
  "/v1/market/rank": 1,
  "/v1/market/token_kline": 2,
  "/v1/trenches": 3,
};

const inflight = new Map<string, Promise<GmgnResult>>();
const recent = new Map<string, { at: number; result: GmgnResult }>();

let tokens = BUCKET_CAPACITY;
let lastRefillMs = Date.now();
let bannedUntilMs = 0;
let waitChain: Promise<void> = Promise.resolve();

export type OpenApiScrapeKind =
  | "token_info"
  | "token_stat"
  | "token_link"
  | "wallet_tags_stat"
  | "holder_stat"
  | "pool_info"
  | "top_holders"
  | "top_traders"
  | "rank";

export function hasGmgnOpenApiKey(): boolean {
  return Boolean(process.env.GMGN_API_KEY?.trim());
}

export function openApiLimiterStatus(): {
  tokens: number;
  bannedUntilMs: number;
  banned: boolean;
  host: string;
} {
  refill();
  return {
    tokens: Math.floor(tokens * 10) / 10,
    bannedUntilMs,
    banned: Date.now() < bannedUntilMs,
    host: OPENAPI_HOST,
  };
}

function routeWeight(path: string): number {
  return ROUTE_WEIGHT[path] ?? 1;
}

function refill(): void {
  const now = Date.now();
  const elapsed = (now - lastRefillMs) / 1000;
  if (elapsed <= 0) return;
  tokens = Math.min(BUCKET_CAPACITY, tokens + elapsed * BUCKET_RATE_PER_SEC);
  lastRefillMs = now;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Serialize acquires so parallel callers share one bucket cleanly. */
async function acquireWeight(weight: number): Promise<void> {
  const run = waitChain.then(async () => {
    for (;;) {
      const now = Date.now();
      if (now < bannedUntilMs) {
        await sleep(Math.min(bannedUntilMs - now + 50, 60_000));
        continue;
      }
      refill();
      if (tokens >= weight) {
        tokens -= weight;
        return;
      }
      const need = weight - tokens;
      const waitMs = Math.ceil((need / BUCKET_RATE_PER_SEC) * 1000) + 25;
      await sleep(Math.min(waitMs, 5_000));
    }
  });
  waitChain = run.catch(() => undefined);
  await run;
}

function markBanned(resetAtSec?: number): void {
  const until = resetAtSec && resetAtSec > 0
    ? resetAtSec * 1000
    : Date.now() + 60_000;
  bannedUntilMs = Math.max(bannedUntilMs, until);
  tokens = 0;
  log.warn(
    { bannedUntil: new Date(bannedUntilMs).toISOString() },
    "GMGN OpenAPI rate-limited — pausing requests",
  );
}

function buildAuthQuery(): { timestamp: number; client_id: string } {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  };
}

function buildUrl(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${OPENAPI_HOST}${path}?${qs}` : `${OPENAPI_HOST}${path}`;
}

function cacheKey(path: string, query: Record<string, string | number | undefined>): string {
  const authless = { ...query };
  delete authless.timestamp;
  delete authless.client_id;
  return `${path}?${JSON.stringify(authless)}`;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function unwrapOpenApiData(json: unknown): Record<string, unknown> {
  return asRecord(asRecord(json).data);
}

/**
 * Authenticated GET against OpenAPI with weight-aware rate limiting.
 */
export async function gmgnOpenApiGet(
  path: string,
  query: Record<string, string | number | undefined> = {},
): Promise<GmgnResult> {
  const key = process.env.GMGN_API_KEY?.trim();
  if (!key) {
    return { ok: false, status: 0, data: { error: "GMGN_API_KEY missing" } };
  }

  const ck = cacheKey(path, query);
  const hit = recent.get(ck);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const existing = inflight.get(ck);
  if (existing) return existing;

  const weight = routeWeight(path);
  const run = (async (): Promise<GmgnResult> => {
    await acquireWeight(weight);
    const auth = buildAuthQuery();
    const url = buildUrl(path, { ...query, ...auth });
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          "X-APIKEY": key,
          "Content-Type": "application/json",
          "User-Agent": "crypsor/1.0 (gmgn-openapi)",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(18_000),
      });
      const text = await resp.text();
      if (!text || text.trimStart().startsWith("<")) {
        return {
          ok: false,
          status: resp.status,
          data: { error: "cloudflare_blocked", status: resp.status },
        };
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, status: resp.status, data: { error: "invalid_json", body: text.slice(0, 120) } };
      }

      const body = asRecord(json);
      const code = body.code as number | undefined;
      const errName = String(body.error ?? "");
      const resetAt = typeof body.reset_at === "number" ? body.reset_at : undefined;

      if (
        resp.status === 429
        || code === 429
        || errName === "RATE_LIMIT_EXCEEDED"
        || errName === "RATE_LIMIT_BANNED"
      ) {
        markBanned(resetAt);
        return {
          ok: false,
          status: 429,
          data: { error: errName || "RATE_LIMIT", message: body.message, reset_at: resetAt },
        };
      }

      const businessOk = code === 0 || code === undefined;
      const ok = resp.ok && businessOk;
      if (!ok) {
        log.warn(
          { path, status: resp.status, code, error: body.error, message: body.message },
          "GMGN OpenAPI request failed",
        );
      }
      const result: GmgnResult = { ok, status: resp.status, data: json };
      if (ok) recent.set(ck, { at: Date.now(), result });
      return result;
    } catch (e: unknown) {
      return { ok: false, status: 0, data: { error: String(e) } };
    } finally {
      inflight.delete(ck);
    }
  })();

  inflight.set(ck, run);
  return run;
}

type MappedOpenApi = {
  kind: OpenApiScrapeKind;
  path: string;
  query: Record<string, string | number | undefined>;
};

/** Map scrape-style website URLs → OpenAPI path+query when possible. */
export function rewriteScrapeUrlToOpenApi(scrapeUrl: string): MappedOpenApi | null {
  try {
    const u = new URL(scrapeUrl);
    const host = u.hostname;
    if (host !== "gmgn.ai" && host !== "www.gmgn.ai") return null;

    let m = u.pathname.match(/^\/api\/v1\/token_info\/([^/]+)\/([^/]+)$/);
    if (m) return { kind: "token_info", path: "/v1/token/info", query: { chain: m[1], address: m[2] } };

    m = u.pathname.match(/^\/api\/v1\/token_stat\/([^/]+)\/([^/]+)$/);
    if (m) return { kind: "token_stat", path: "/v1/token/info", query: { chain: m[1], address: m[2] } };

    m = u.pathname.match(/^\/api\/v1\/token_link\/([^/]+)\/([^/]+)$/);
    if (m) return { kind: "token_link", path: "/v1/token/info", query: { chain: m[1], address: m[2] } };

    m = u.pathname.match(/^\/api\/v1\/token_wallet_tags_stat\/([^/]+)\/([^/]+)$/);
    if (m) {
      return { kind: "wallet_tags_stat", path: "/v1/token/info", query: { chain: m[1], address: m[2] } };
    }

    m = u.pathname.match(/^\/vas\/api\/v1\/token_holder_stat\/([^/]+)\/([^/]+)$/);
    if (m) return { kind: "holder_stat", path: "/v1/token/info", query: { chain: m[1], address: m[2] } };

    m = u.pathname.match(/^\/api\/v1\/token_pool(?:_info)?\/([^/]+)\/([^/]+)$/);
    if (m) return { kind: "pool_info", path: "/v1/token/pool_info", query: { chain: m[1], address: m[2] } };

    m = u.pathname.match(/^\/vas\/api\/v1\/token_holders\/([^/]+)\/([^/]+)$/);
    if (m) {
      return {
        kind: "top_holders",
        path: "/v1/market/token_top_holders",
        query: {
          chain: m[1],
          address: m[2],
          limit: u.searchParams.get("limit") ?? 40,
          offset: u.searchParams.get("offset") ?? undefined,
          tag: u.searchParams.get("tag") ?? undefined,
          order_by: u.searchParams.get("orderby") ?? u.searchParams.get("order_by") ?? "amount_percentage",
          direction: u.searchParams.get("direction") ?? "desc",
        },
      };
    }

    m = u.pathname.match(/^\/defi\/quotation\/v1\/tokens\/top_traders\/([^/]+)\/([^/]+)$/);
    if (m) {
      return {
        kind: "top_traders",
        path: "/v1/market/token_top_traders",
        query: {
          chain: m[1],
          address: m[2],
          limit: u.searchParams.get("limit") ?? 20,
          order_by: u.searchParams.get("orderby") ?? "profit",
          direction: u.searchParams.get("direction") ?? "desc",
          tag: u.searchParams.get("tag") ?? undefined,
        },
      };
    }

    m = u.pathname.match(/^\/api\/v1\/rank\/([^/]+)\/swaps\/([^/]+)$/);
    if (m) {
      return {
        kind: "rank",
        path: "/v1/market/rank",
        query: { chain: m[1], interval: m[2] },
      };
    }

    return null;
  } catch {
    return null;
  }
}

/** Reshape OpenAPI token/info into the scrape envelope callers already unwrap. */
function reshapeForScrapeKind(kind: OpenApiScrapeKind, result: GmgnResult): GmgnResult {
  if (!result.ok) return result;
  const info = unwrapOpenApiData(result.data);
  const stat = asRecord(info.stat);
  const tags = asRecord(info.wallet_tags_stat);
  const link = asRecord(info.link);

  switch (kind) {
    case "wallet_tags_stat":
      return { ok: true, status: result.status, data: { code: 0, data: tags } };

    case "token_link":
      return { ok: true, status: result.status, data: { code: 0, data: link } };

    case "token_stat":
      return {
        ok: true,
        status: result.status,
        data: {
          code: 0,
          data: {
            ...stat,
            top_10_holder_rate: stat.top_10_holder_rate ?? info.top_10_holder_rate,
            creator_created_count: info.creator_created_count ?? stat.creator_created_count,
          },
        },
      };

    case "holder_stat":
      return {
        ok: true,
        status: result.status,
        data: {
          code: 0,
          data: {
            renowned_count: tags.renowned_wallets ?? 0,
            smart_degen_count: tags.smart_wallets ?? 0,
            sniper_count: tags.sniper_wallets ?? 0,
            top10_holder_rate: stat.top_10_holder_rate ?? info.top_10_holder_rate ?? null,
            bluechip_owner_count: tags.bluechip_owner_wallets ?? null,
            whale_count: tags.whale_wallets ?? null,
            rat_trader_count: tags.rat_trader_wallets ?? null,
            bundler_count: tags.bundler_wallets ?? null,
          },
        },
      };

    case "token_info":
      return { ok: true, status: result.status, data: { code: 0, data: info } };

    default:
      return result;
  }
}

function normalizeListEnvelope(result: GmgnResult): GmgnResult {
  if (!result.ok || !result.data || typeof result.data !== "object") return result;
  const root = result.data as { data?: unknown };
  const inner = root.data;
  if (Array.isArray(inner)) {
    return { ...result, data: { code: 0, data: { list: inner } } };
  }
  if (inner && typeof inner === "object" && Array.isArray((inner as { list?: unknown[] }).list)) {
    return result;
  }
  if (inner && typeof inner === "object" && Array.isArray((inner as { holders?: unknown[] }).holders)) {
    return {
      ...result,
      data: { code: 0, data: { list: (inner as { holders: unknown[] }).holders } },
    };
  }
  return result;
}

/**
 * Prefer OpenAPI when key is set and URL can be rewritten; otherwise return null
 * so the scrape client handles it.
 */
export async function tryGmgnOpenApi(scrapeUrl: string): Promise<GmgnResult | null> {
  if (!hasGmgnOpenApiKey()) return null;
  const mapped = rewriteScrapeUrlToOpenApi(scrapeUrl);
  if (!mapped) return null;
  const result = await gmgnOpenApiGet(mapped.path, mapped.query);
  if (
    mapped.kind === "token_info"
    || mapped.kind === "token_stat"
    || mapped.kind === "token_link"
    || mapped.kind === "wallet_tags_stat"
    || mapped.kind === "holder_stat"
  ) {
    return reshapeForScrapeKind(mapped.kind, result);
  }
  if (mapped.kind === "top_holders" || mapped.kind === "top_traders") {
    return normalizeListEnvelope(result);
  }
  return result;
}

/** One-shot Pro bundle: info + security + KOL/smart holders (weight ~12). */
export async function fetchOpenApiTokenBundle(
  chain: string,
  address: string,
  holderLimit = 40,
): Promise<{
  info: GmgnResult;
  security: GmgnResult;
  kolHolders: GmgnResult;
  smartHolders: GmgnResult;
}> {
  // Sequential acquire inside each get — fire in parallel; bucket serializes tokens.
  const [info, security, kolHolders, smartHolders] = await Promise.all([
    gmgnOpenApiGet("/v1/token/info", { chain, address }),
    gmgnOpenApiGet("/v1/token/security", { chain, address }),
    gmgnOpenApiGet("/v1/market/token_top_holders", {
      chain,
      address,
      limit: holderLimit,
      tag: "renowned",
      order_by: "amount_percentage",
      direction: "desc",
    }),
    gmgnOpenApiGet("/v1/market/token_top_holders", {
      chain,
      address,
      limit: holderLimit,
      tag: "smart_degen",
      order_by: "amount_percentage",
      direction: "desc",
    }),
  ]);
  return {
    info,
    security,
    kolHolders: normalizeListEnvelope(kolHolders),
    smartHolders: normalizeListEnvelope(smartHolders),
  };
}

export async function openApiHealthCheck(mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"): Promise<{
  configured: boolean;
  ok: boolean;
  status: number;
  error?: string;
  host: string;
  limiter?: ReturnType<typeof openApiLimiterStatus>;
  sample?: {
    symbol?: string;
    smartWallets?: number;
    renownedWallets?: number;
    top10HolderRate?: number;
  };
}> {
  if (!hasGmgnOpenApiKey()) {
    return { configured: false, ok: false, status: 0, error: "GMGN_API_KEY not set", host: OPENAPI_HOST };
  }
  const r = await gmgnOpenApiGet("/v1/token/info", { chain: "sol", address: mint });
  const body = asRecord(r.data);
  const info = unwrapOpenApiData(r.data);
  const tags = asRecord(info.wallet_tags_stat);
  const stat = asRecord(info.stat);
  const err = !r.ok ? String(body.error ?? body.message ?? r.status) : undefined;
  return {
    configured: true,
    ok: r.ok,
    status: r.status,
    error: err,
    host: OPENAPI_HOST,
    limiter: openApiLimiterStatus(),
    sample: r.ok
      ? {
          symbol: typeof info.symbol === "string" ? info.symbol : undefined,
          smartWallets: typeof tags.smart_wallets === "number" ? tags.smart_wallets : undefined,
          renownedWallets: typeof tags.renowned_wallets === "number" ? tags.renowned_wallets : undefined,
          top10HolderRate: stat.top_10_holder_rate != null ? Number(stat.top_10_holder_rate) : undefined,
        }
      : undefined,
  };
}
