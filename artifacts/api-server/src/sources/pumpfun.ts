/**
 * pump.fun frontend API v3 — free, no JWT for the coin/sol-price reads.
 *
 * Reverse-engineered from BankkRoll/pumpfun-apis (frontend-api-v3.json):
 *   GET https://frontend-api-v3.pump.fun/coins/{mint}     coin + usd MC + curve
 *   GET https://frontend-api-v3.pump.fun/sol-price        SOL/USD
 *   GET https://frontend-api-v3.pump.fun/coins/currently-live
 *   GET https://frontend-api-v3.pump.fun/coins?sort=...
 *
 * Trades / candlesticks / top-holders 404 without a site JWT — we do not
 * fake those. Origin must be https://pump.fun (their docs / browser).
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
  creator?: string;
  created_timestamp?: number;   // ms
  usd_market_cap?: number;
  market_cap?: number;          // SOL
  market_cap_usd?: number;
  complete?: boolean;           // graduated
  virtual_sol_reserves?: number;
  virtual_token_reserves?: number;
  real_sol_reserves?: number;
  real_token_reserves?: number;
  reply_count?: number;
  nsfw?: boolean;
  twitter?: string | null;
  telegram?: string | null;
  website?: string | null;
  last_trade_timestamp?: number;
  ath_market_cap?: number;
  is_currently_live?: boolean;
  pump_swap_pool?: string | null;
};

export type PumpVitals = {
  mcUsd: number | null;
  liqUsd: number | null;
  graduated: boolean;
  lastTradeAt: number | null;
  athMc: number | null;
  coin: PumpCoin;
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

/** Hottest bonding-curve names by recent trades. */
export async function moverCoins(limit = 12): Promise<PumpCoin[]> {
  const coins = await get<PumpCoin[]>(
    `/coins?offset=0&limit=${limit}&sort=last_trade_timestamp&order=DESC&includeNsfw=false`,
  );
  return Array.isArray(coins) ? coins : [];
}

export async function coin(mint: string): Promise<PumpCoin | null> {
  return get<PumpCoin>(`/coins/${encodeURIComponent(mint)}`, 6_000);
}

let solPriceCache: { usd: number; at: number } | null = null;

export async function solPriceUsd(): Promise<number | null> {
  if (solPriceCache && Date.now() - solPriceCache.at < 60_000) return solPriceCache.usd;
  const row = await get<{ solPrice?: number; stale?: boolean }>("/sol-price", 5_000);
  const n = Number(row?.solPrice);
  if (!Number.isFinite(n) || n <= 0) return solPriceCache?.usd ?? null;
  solPriceCache = { usd: n, at: Date.now() };
  return n;
}

/**
 * Bonding-curve virtual liquidity.
 * Prefer 2 × SOL reserves × SOL/USD (matches the SOL side of the curve).
 * Fall back to the token-reserve identity when SOL price is unread.
 */
export function virtualLiqUsd(c: PumpCoin, solUsd?: number | null): number | null {
  if (solUsd && c.virtual_sol_reserves) {
    const liq = 2 * solUsd * c.virtual_sol_reserves / 1e9;
    if (Number.isFinite(liq) && liq > 0) return liq;
  }
  if (!c.usd_market_cap || !c.virtual_token_reserves) return null;
  const liq = 2 * c.usd_market_cap * c.virtual_token_reserves / 1e15;
  return Number.isFinite(liq) && liq > 0 ? liq : null;
}

export async function pumpVitals(mint: string): Promise<PumpVitals | null> {
  const [c, sol] = await Promise.all([coin(mint), solPriceUsd()]);
  if (!c) return null;
  return {
    mcUsd: c.usd_market_cap ?? c.market_cap_usd ?? null,
    liqUsd: virtualLiqUsd(c, sol),
    graduated: Boolean(c.complete),
    lastTradeAt: c.last_trade_timestamp ?? null,
    athMc: c.ath_market_cap ?? null,
    coin: c,
  };
}
