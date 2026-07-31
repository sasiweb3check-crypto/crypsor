/**
 * GMGN Official OpenAPI client — https://openapi.gmgn.ai
 *
 * This is the supported path for GMGN_API_KEY (from https://gmgn.ai/ai).
 * It does NOT scrape gmgn.ai website endpoints, so Cloudflare bot challenges
 * on the site do not apply the same way.
 *
 * Auth (read / "exist"):
 *   Header: X-APIKEY: <key>
 *   Query:  timestamp (unix sec) + client_id (uuid)
 *
 * Important: putting GMGN_API_KEY on gmgn.ai scrape requests does NOT bypass
 * Cloudflare. Use this OpenAPI host instead.
 */

import { randomUUID } from "node:crypto";
import { logger as rootLogger } from "./logger";
import type { GmgnResult } from "./gmgn-client";

const log = rootLogger.child({ module: "gmgn-openapi" });

const OPENAPI_HOST = (process.env.GMGN_OPENAPI_HOST ?? "https://openapi.gmgn.ai").replace(/\/$/, "");

/** Collapse parallel remaps of the same OpenAPI path (pro-verify used to fan out). */
const inflight = new Map<string, Promise<GmgnResult>>();
const recent = new Map<string, { at: number; result: GmgnResult }>();
const CACHE_TTL_MS = 8_000;

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

/**
 * Authenticated GET against OpenAPI. Returns same GmgnResult shape as scrape client.
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

  const run = (async (): Promise<GmgnResult> => {
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
        signal: AbortSignal.timeout(15_000),
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
      const code = (json as { code?: number })?.code;
      // OpenAPI often returns HTTP 200 with business code in body
      const businessOk = code === 0 || code === undefined;
      const ok = resp.ok && businessOk;
      if (!ok) {
        log.warn(
          {
            path,
            status: resp.status,
            code,
            error: (json as { error?: string })?.error,
            message: (json as { message?: string })?.message,
          },
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

    // /api/v1/token_info/{chain}/{addr}
    let m = u.pathname.match(/^\/api\/v1\/token_info\/([^/]+)\/([^/]+)$/);
    if (m) return { kind: "token_info", path: "/v1/token/info", query: { chain: m[1], address: m[2] } };

    // token_stat / token_link / wallet_tags / holder_stat → all live inside /v1/token/info
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

    // /api/v1/token_pool/{chain}/{addr}
    m = u.pathname.match(/^\/api\/v1\/token_pool(?:_info)?\/([^/]+)\/([^/]+)$/);
    if (m) return { kind: "pool_info", path: "/v1/token/pool_info", query: { chain: m[1], address: m[2] } };

    // /vas/api/v1/token_holders/{chain}/{addr}
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

    // /defi/quotation/v1/tokens/top_traders/{chain}/{addr}
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

    // /api/v1/rank/{chain}/swaps/{interval}
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

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function unwrapOpenApiData(json: unknown): Record<string, unknown> {
  const root = asRecord(json);
  return asRecord(root.data);
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
      // Scrape token_stat is flat; OpenAPI nests under `stat` (+ a few siblings)
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
      // Map OpenAPI tags/stat into scrape holder_stat field names
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

export async function openApiHealthCheck(mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"): Promise<{
  configured: boolean;
  ok: boolean;
  status: number;
  error?: string;
  host: string;
}> {
  if (!hasGmgnOpenApiKey()) {
    return { configured: false, ok: false, status: 0, error: "GMGN_API_KEY not set", host: OPENAPI_HOST };
  }
  const r = await gmgnOpenApiGet("/v1/token/info", { chain: "sol", address: mint });
  const body = asRecord(r.data);
  const err = !r.ok
    ? String(body.error ?? body.message ?? r.status)
    : undefined;
  return {
    configured: true,
    ok: r.ok,
    status: r.status,
    error: err,
    host: OPENAPI_HOST,
  };
}
