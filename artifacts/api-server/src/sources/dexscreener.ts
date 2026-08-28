/**
 * DexScreener — public pair tape (free, no key). Same endpoints omo uses:
 *   GET /latest/dex/tokens/{mint,...}
 *
 * Discovery does NOT search Dex. We only read mints our wallets already bought.
 */
import { logger } from "../core/log";
import type { TokenResearch } from "../scoring/omo";

export type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairCreatedAt?: number;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h6?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  baseToken?: { address?: string; symbol?: string; name?: string };
  info?: {
    websites?: { url?: string }[];
    socials?: { type?: string; url?: string }[];
  };
};

const UA = { Accept: "application/json", "user-agent": "crypsor/omo-desk" };

async function json<T>(url: string, timeoutMs = 10_000): Promise<T | null> {
  try {
    const resp = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return null;
    return await resp.json() as T;
  } catch (err) {
    logger.debug({ err, url }, "dexscreener fetch failed");
    return null;
  }
}

export function socialsOf(pair: DexPair): string[] {
  return (pair.info?.socials ?? [])
    .map((x) => (x.type ?? "").toLowerCase())
    .filter(Boolean)
    .slice(0, 4);
}

export function hasSite(pair: DexPair): boolean {
  return (pair.info?.websites ?? []).length > 0;
}

export function ageHoursOf(pair: DexPair): number {
  const created = pair.pairCreatedAt ?? 0;
  return created ? Math.max(0, (Date.now() - created) / 3_600_000) : 0;
}

/** Best (deepest) Solana pair per mint. */
export async function pairsForMints(mints: string[]): Promise<Map<string, DexPair>> {
  const out = new Map<string, DexPair>();
  for (const p of await allPairsForMints(mints)) {
    if ((p.chainId || "").toLowerCase() !== "solana") continue;
    const mint = p.baseToken?.address;
    if (!mint) continue;
    const prev = out.get(mint);
    if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) out.set(mint, p);
  }
  return out;
}

export async function allPairsForMints(mints: string[]): Promise<DexPair[]> {
  const out: DexPair[] = [];
  for (let i = 0; i < mints.length; i += 25) {
    const batch = mints.slice(i, i + 25);
    const res = await json<{ pairs?: DexPair[] }>(
      `https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`,
    );
    out.push(...(res?.pairs ?? []));
  }
  return out;
}

/** Real second-pass research on one mint: every pool, deeper windows, socials. */
export async function researchToken(mint: string, symbol: string): Promise<TokenResearch | null> {
  const res = await json<{ pairs?: DexPair[] }>(
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
  );
  const pairs = (res?.pairs ?? []).filter((p) => (p.chainId || "").toLowerCase() === "solana");
  if (!pairs.length) return null;
  const totalLiq = pairs.reduce((sum, p) => sum + (p.liquidity?.usd ?? 0), 0);
  const top = pairs.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
  return {
    symbol: symbol.replace(/^\$/, ""),
    mint,
    pools: pairs.length,
    totalLiquidityUsd: totalLiq,
    topPoolShare: totalLiq > 0 ? (top.liquidity?.usd ?? 0) / totalLiq : 1,
    vol6h: pairs.reduce((sum, p) => sum + (p.volume?.h6 ?? 0), 0),
    buys6h: pairs.reduce((sum, p) => sum + (p.txns?.h6?.buys ?? 0), 0),
    sells6h: pairs.reduce((sum, p) => sum + (p.txns?.h6?.sells ?? 0), 0),
    chg6h: top.priceChange?.h6 ?? 0,
    socials: socialsOf(top),
    hasSite: hasSite(top),
  };
}
