/**
 * DexScreener — pair MC / liq / image for mints we already bought.
 */
import { logger } from "../core/log";
import { pace } from "./pace";
import { httpsImage, dexTokenImage } from "../scoring/image";

export type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
  };
  priceChange?: { m5?: number; h1?: number };
  baseToken?: { address?: string; symbol?: string; name?: string };
  info?: { imageUrl?: string; header?: string };
};

const UA = { Accept: "application/json", "user-agent": "crypsor/wallet-desk" };

async function json<T>(url: string, timeoutMs = 10_000): Promise<T | null> {
  try {
    await pace("dex", 350);
    const resp = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return null;
    return await resp.json() as T;
  } catch (err) {
    logger.debug({ err, url }, "dexscreener fetch failed");
    return null;
  }
}

export function imageOf(pair: DexPair | null | undefined): string | null {
  return httpsImage(pair?.info?.imageUrl || pair?.info?.header)
    ?? dexTokenImage(pair?.baseToken?.address);
}

export function mcOf(pair: DexPair | null | undefined): number | null {
  const n = Number(pair?.marketCap ?? pair?.fdv ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function vol5mOf(pair: DexPair | null | undefined): number | null {
  const n = Number(pair?.volume?.m5 ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function buys5mOf(pair: DexPair | null | undefined): number | null {
  const n = Number(pair?.txns?.m5?.buys ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Best (deepest) Solana pair per mint. */
export async function pairsForMints(mints: string[]): Promise<Map<string, DexPair>> {
  const out = new Map<string, DexPair>();
  for (let i = 0; i < mints.length; i += 25) {
    const batch = mints.slice(i, i + 25);
    const res = await json<{ pairs?: DexPair[] }>(
      `https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`,
    );
    for (const p of res?.pairs ?? []) {
      if ((p.chainId || "").toLowerCase() !== "solana") continue;
      const mint = p.baseToken?.address;
      if (!mint) continue;
      const prev = out.get(mint);
      if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) out.set(mint, p);
    }
  }
  return out;
}
