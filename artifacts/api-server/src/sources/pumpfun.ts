/**
 * pump.fun frontend API (free, no key). Verified endpoints:
 *   /coins/currently-live  — actively-trading bonding tokens (the trenches feed)
 *   /coins?sort=created_timestamp — newest launches
 *   /coins/:mint           — single coin (usd_market_cap, complete, reserves)
 */
import { logger } from "../core/log";

const BASE = "https://frontend-api-v3.pump.fun";
const HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; Crypsor/2.0)",
};

export type PumpCoin = {
  mint: string;
  name?: string;
  symbol?: string;
  image_uri?: string;
  creator?: string;
  created_timestamp?: number;   // ms
  usd_market_cap?: number;
  market_cap?: number;          // SOL
  complete?: boolean;           // graduated
  virtual_sol_reserves?: number;
  virtual_token_reserves?: number;
  reply_count?: number;
  nsfw?: boolean;
  twitter?: string | null;
  telegram?: string | null;
  website?: string | null;
  last_trade_timestamp?: number;
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

/** Actively trading bonding-curve tokens — primary discovery feed. */
export async function currentlyLive(limit = 48): Promise<PumpCoin[]> {
  const coins = await get<PumpCoin[]>(
    `/coins/currently-live?offset=0&limit=${limit}&includeNsfw=false`,
  );
  return Array.isArray(coins) ? coins : [];
}

/** Newest launches — secondary discovery feed. */
export async function newestCoins(limit = 30): Promise<PumpCoin[]> {
  const coins = await get<PumpCoin[]>(
    `/coins?offset=0&limit=${limit}&sort=created_timestamp&order=DESC&includeNsfw=false`,
  );
  return Array.isArray(coins) ? coins : [];
}

export async function coin(mint: string): Promise<PumpCoin | null> {
  return get<PumpCoin>(`/coins/${mint}`, 6_000);
}

/**
 * Virtual liquidity for a bonding token:
 * 2 × mc × virtual_token_reserves / 1e15 (derived from curve reserves).
 */
export function virtualLiqUsd(c: PumpCoin): number | null {
  if (!c.usd_market_cap || !c.virtual_token_reserves) return null;
  const liq = 2 * c.usd_market_cap * c.virtual_token_reserves / 1e15;
  return Number.isFinite(liq) && liq > 0 ? liq : null;
}
