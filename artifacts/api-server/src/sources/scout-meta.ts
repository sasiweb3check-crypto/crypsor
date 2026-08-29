/**
 * Token header for wallet scout — DexScreener, pump.fun, Helius DAS / parsed mint.
 */
import { logger } from "../core/log";
import { heliusKey } from "../core/settings";
import { tokenImageUrl } from "../scoring/image";
import { liqOf, mcOf, type DexPair } from "./pair-stats";
import { pairsForMints } from "./dexscreener";
import { coin as pumpCoin } from "./pumpfun";
import { pace } from "./pace";

export type ScoutToken = {
  mint: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  decimals: number | null;
  supply: number | null;
  priceUsd: number | null;
  mcUsd: number | null;
  liqUsd: number | null;
  createdAt: string | null;
  launchpad: string | null;
  pairAddress: string | null;
  bondingCurve: string | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  solUsd: number | null;
  notes: string[];
};

const WSOL = "So11111111111111111111111111111111111111112";

async function rpc<T>(body: unknown): Promise<T | null> {
  const key = await heliusKey();
  if (!key) return null;
  try {
    await pace("helius-holders", 80);
    const resp = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    return await resp.json() as T;
  } catch (err) {
    logger.debug({ err }, "scout rpc failed");
    return null;
  }
}

type ParsedMint = {
  result?: {
    value?: {
      data?: {
        parsed?: {
          info?: {
            decimals?: number;
            supply?: string;
            mintAuthority?: string | null;
            freezeAuthority?: string | null;
          };
        };
      };
    };
  };
};

type DasAsset = {
  result?: {
    content?: {
      metadata?: { name?: string; symbol?: string };
      links?: { image?: string };
      files?: Array<{ uri?: string }>;
    };
    token_info?: {
      decimals?: number;
      supply?: number | string;
      token_program?: string;
    };
    authorities?: Array<{ address?: string; scopes?: string[] }>;
  };
};

export async function solUsdSpot(): Promise<number | null> {
  try {
    await pace("dex", 350);
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${WSOL}`, {
      headers: { Accept: "application/json", "user-agent": "crypsor/wallet-scout" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const json = await resp.json() as { pairs?: DexPair[] };
    let best: DexPair | null = null;
    for (const p of json.pairs ?? []) {
      if ((p.chainId || "").toLowerCase() !== "solana") continue;
      if (!best || (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
    }
    const n = Number(best?.priceUsd);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function loadScoutToken(mint: string): Promise<ScoutToken> {
  const notes: string[] = [];
  const [pairs, pump, parsed, asset, solUsd] = await Promise.all([
    pairsForMints([mint]),
    pumpCoin(mint),
    rpc<ParsedMint>({
      jsonrpc: "2.0", id: "mint", method: "getAccountInfo",
      params: [mint, { encoding: "jsonParsed", commitment: "confirmed" }],
    }),
    rpc<DasAsset>({ jsonrpc: "2.0", id: "asset", method: "getAsset", params: { id: mint } }),
    solUsdSpot(),
  ]);

  const pair = pairs.get(mint) ?? null;
  const info = parsed?.result?.value?.data?.parsed?.info;
  const das = asset?.result;
  const decimals = info?.decimals ?? das?.token_info?.decimals ?? null;
  const rawSupply = info?.supply ?? das?.token_info?.supply;
  let supply: number | null = null;
  if (rawSupply != null && decimals != null) {
    const raw = Number(rawSupply);
    if (Number.isFinite(raw) && raw >= 0) supply = raw / (10 ** decimals);
  } else if (pump?.total_supply != null && Number(pump.total_supply) > 0) {
    supply = Number(pump.total_supply);
    if (decimals != null && supply > 1e12) supply = supply / (10 ** decimals);
  }

  const priceUsd = pair?.priceUsd != null ? Number(pair.priceUsd) : null;
  const mcUsd = mcOf(pair) ?? (priceUsd != null && supply != null ? priceUsd * supply : null);
  const createdPump = pump?.created_timestamp
    ? new Date(pump.created_timestamp < 1e12 ? pump.created_timestamp * 1000 : pump.created_timestamp).toISOString()
    : null;
  const createdPair = pair?.pairCreatedAt
    ? new Date(pair.pairCreatedAt < 1e12 ? pair.pairCreatedAt * 1000 : pair.pairCreatedAt).toISOString()
    : null;

  const mintAuth = info?.mintAuthority ?? null;
  const freezeAuth = info?.freezeAuthority ?? null;
  const bonding = (pump as { bonding_curve?: string } | null)?.bonding_curve ?? null;

  let launchpad: string | null = null;
  if (mint.toLowerCase().endsWith("pump") || pump) launchpad = "pump.fun";
  else if (pair?.dexId) launchpad = pair.dexId;

  if (!solUsd) notes.push("SOL/USD spot missing — pump USD legs use token amount × interpolated price when possible.");
  notes.push("MC at each fill is curve reserves (pump) or OHLCV close × supply (DEX). Supply is treated as fixed.");
  notes.push("Sold-all wallets only appear if they swapped with the pool or pump curve we crawled. Closed ATAs without a pool fill are missed.");

  return {
    mint,
    name: pair?.baseToken?.name ?? pump?.name ?? das?.content?.metadata?.name ?? null,
    symbol: pair?.baseToken?.symbol ?? pump?.symbol ?? das?.content?.metadata?.symbol ?? null,
    image: tokenImageUrl(
      das?.content?.links?.image ?? das?.content?.files?.[0]?.uri ?? pump?.image_uri ?? null,
      mint,
    ),
    decimals,
    supply,
    priceUsd: priceUsd != null && Number.isFinite(priceUsd) ? priceUsd : null,
    mcUsd: mcUsd != null && Number.isFinite(mcUsd) && mcUsd > 0 ? mcUsd : null,
    liqUsd: liqOf(pair),
    createdAt: createdPump ?? createdPair,
    launchpad,
    pairAddress: pair?.pairAddress ?? null,
    bondingCurve: bonding,
    mintAuthority: mintAuth,
    freezeAuthority: freezeAuth,
    solUsd,
    notes,
  };
}
