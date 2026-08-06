/**
 * Dexscreener — market state for graduated tokens (free, no key).
 * Batch endpoint: /latest/dex/tokens/{mint1,mint2,...} (up to ~30 mints).
 */
import { logger } from "../core/log";

export type DexPair = {
  chainId?: string;
  dexId?: string;
  pairCreatedAt?: number;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number; h24?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
  };
  priceChange?: { m5?: number; h1?: number };
  baseToken?: { address?: string; symbol?: string; name?: string };
};

export async function pairsForMints(mints: string[]): Promise<Map<string, DexPair>> {
  const out = new Map<string, DexPair>();
  for (let i = 0; i < mints.length; i += 28) {
    const batch = mints.slice(i, i + 28);
    try {
      const resp = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
      );
      if (!resp.ok) continue;
      const json = await resp.json() as { pairs?: DexPair[] };
      for (const p of json.pairs ?? []) {
        if ((p.chainId || "").toLowerCase() !== "solana") continue;
        const mint = p.baseToken?.address;
        if (!mint) continue;
        const prev = out.get(mint);
        if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) {
          out.set(mint, p);
        }
      }
    } catch (err) {
      logger.debug({ err }, "dexscreener batch failed");
    }
  }
  return out;
}
