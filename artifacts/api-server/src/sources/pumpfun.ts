/**
 * pump.fun coin read — MC / image fallback when Dex is blank.
 */
import { logger } from "../core/log";

const BASE = "https://frontend-api-v3.pump.fun";
const HEADERS = {
  Accept: "application/json",
  Origin: "https://pump.fun",
  Referer: "https://pump.fun/",
  "User-Agent": "Mozilla/5.0 (compatible; Crypsor/2.0)",
};

export type PumpCoin = {
  mint: string;
  name?: string;
  symbol?: string;
  image_uri?: string;
  created_timestamp?: number;
  usd_market_cap?: number;
  market_cap_usd?: number;
  complete?: boolean;
  reply_count?: number;
  last_reply?: number;
  is_currently_live?: boolean;
  real_sol_reserves?: number;
  virtual_sol_reserves?: number;
  nsfw?: boolean;
  is_banned?: boolean;
  verified?: boolean;
  boost_mode?: string;
  holder_count?: number;
  total_supply?: number;
};

async function get<T>(path: string, timeoutMs = 10_000): Promise<T | null> {
  try {
    const resp = await fetch(`${BASE}${path}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return await resp.json() as T;
  } catch (err) {
    logger.debug({ err, path }, "pumpfun fetch failed");
    return null;
  }
}

export async function coin(mint: string): Promise<PumpCoin | null> {
  return get<PumpCoin>(`/coins/${encodeURIComponent(mint)}`, 6_000);
}

export function pumpMc(c: PumpCoin | null | undefined): number | null {
  const n = Number(c?.usd_market_cap ?? c?.market_cap_usd ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function curveSol(c: PumpCoin | null | undefined): number | null {
  const n = Number(c?.real_sol_reserves ?? 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 1e9;
}

export function pumpHolders(c: PumpCoin | null | undefined): number | null {
  const n = Number(c?.holder_count ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function pumpAgeHours(c: PumpCoin | null | undefined, now = Date.now()): number | null {
  const at = Number(c?.created_timestamp ?? 0);
  if (!Number.isFinite(at) || at <= 0) return null;
  const ms = at < 1e12 ? at * 1000 : at;
  const hours = (now - ms) / 3_600_000;
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
}

export async function coinsForMints(mints: string[]): Promise<Map<string, PumpCoin>> {
  const out = new Map<string, PumpCoin>();
  const pump = [...new Set(mints.filter((m) => m.toLowerCase().endsWith("pump")))];
  for (let i = 0; i < pump.length; i += 6) {
    const chunk = pump.slice(i, i + 6);
    const rows = await Promise.all(chunk.map((m) => coin(m)));
    for (const c of rows) {
      if (c?.mint) out.set(c.mint, c);
    }
  }
  return out;
}

export type PumpTradeRow = {
  signature?: string;
  is_buy?: boolean;
  user?: string;
  timestamp?: number;
  sol_amount?: number;
  token_amount?: number;
};

export async function newestCoins(limit = 50): Promise<PumpCoin[]> {
  const n = Math.min(Math.max(limit, 1), 50);
  const rows = await get<PumpCoin[]>(
    `/coins?offset=0&limit=${n}&sort=created_timestamp&order=DESC&includeNsfw=false`,
    8_000,
  );
  return Array.isArray(rows) ? rows.filter((c) => c?.mint) : [];
}

export async function firstTrades(mint: string, limit = 200): Promise<PumpTradeRow[]> {
  const n = Math.min(Math.max(limit, 1), 200);
  const rows = await get<PumpTradeRow[]>(
    `/trades/all/${encodeURIComponent(mint)}?limit=${n}&offset=0`,
    8_000,
  );
  return Array.isArray(rows) ? rows : [];
}
