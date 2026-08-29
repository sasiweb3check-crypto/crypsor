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
