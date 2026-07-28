import { db } from "@workspace/db";
import { tracked_tokens, token_price_snapshots } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus } from "./event-bus";
import { healthMonitor } from "./health-monitor";

// PostgreSQL timestamp range: 4713 BC – 294276 AD (as Unix ms)
const PG_TS_MAX_MS = new Date("294276-01-01T00:00:00Z").getTime();
const PG_TS_MIN_MS = new Date("4713-01-01T00:00:00Z").getTime() * -1; // ~approx

/**
 * Convert a Unix-second timestamp from DexScreener to a Date, clamping to
 * PostgreSQL's supported timestamp range.  DexScreener sometimes returns
 * millisecond timestamps or wildly out-of-range values that crash the DB.
 *
 * B6 fix: also reject timestamps more than 1 hour in the future — DexScreener
 * pairCreatedAt can reflect the Raydium pool creation time, which for some
 * migrated tokens is set to a future date and produces negative detection delays.
 */
function clampTimestamp(raw: number): Date | null {
  // DexScreener pairCreatedAt is in seconds; detect ms values (> year 3000 in seconds)
  const ms = raw > 32_503_680_000 ? raw : raw * 1_000;
  if (!isFinite(ms) || ms < PG_TS_MIN_MS || ms > PG_TS_MAX_MS) return null;
  // Reject timestamps more than 1 hour in the future (bad DexScreener data)
  if (ms > Date.now() + 60 * 60 * 1_000) return null;
  return new Date(ms);
}

const DEXCHAIN: Record<string, string> = {
  solana: "solana", eth: "ethereum", base: "base",
  bsc: "bsc", polygon: "polygon", arbitrum: "arbitrum", avalanche: "avalanche",
};

// CoinGecko platform id map
const CG_PLATFORM: Record<string, string> = {
  solana: "solana", eth: "ethereum", base: "base",
  bsc: "binance-smart-chain", polygon: "polygon-pos",
  arbitrum: "arbitrum-one", avalanche: "avalanche",
};

interface FreshPrice {
  price: string;
  logo: string | null;
  marketCapUsd: string | null;
  fdvUsd: string | null;
  liquidityUsd: string | null;
  volume24hUsd: string | null;
  tokenCreatedAt: Date | null;
}

// ── DexScreener ───────────────────────────────────────────────────────────────

async function fetchBatch(chain: string, addresses: string[]): Promise<Map<string, FreshPrice>> {
  const map = new Map<string, FreshPrice>();
  if (!addresses.length) return map;
  const dexChain = DEXCHAIN[chain] ?? chain;

  for (let i = 0; i < addresses.length; i += 30) {
    const slice = addresses.slice(i, i + 30);
    try {
      const resp = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${slice.join(",")}`,
        { signal: AbortSignal.timeout(12_000) },
      );
      if (!resp.ok) continue;
      const json = await resp.json() as {
        pairs?: Array<{
          chainId: string;
          dexId?: string;
          baseToken: { address: string };
          priceUsd?: string;
          fdv?: number; marketCap?: number;
          liquidity?: { usd?: number };
          volume?: { h24?: number };
          pairCreatedAt?: number;
          info?: { imageUrl?: string };
        }>;
      };

      // Group pairs by token address; prefer Raydium pairs for Solana tokens
      const byAddr = new Map<string, typeof json.pairs extends Array<infer T> ? T : never>();
      for (const pair of json.pairs ?? []) {
        if (pair.chainId !== dexChain || !pair.priceUsd) continue;
        const addr = chain === "solana" ? pair.baseToken.address : pair.baseToken.address.toLowerCase();
        const existing = byAddr.get(addr);
        if (!existing || pair.dexId === "raydium") {
          byAddr.set(addr, pair);
        }
      }

      for (const [addr, pair] of byAddr) {
        const mc = pair.marketCap ?? pair.fdv ?? null;
        map.set(addr, {
          price:        pair.priceUsd!,
          logo:         pair.info?.imageUrl ?? null,
          marketCapUsd: mc !== null ? String(mc) : null,
          fdvUsd:       pair.fdv !== undefined ? String(pair.fdv) : null,
          liquidityUsd: pair.liquidity?.usd !== undefined ? String(pair.liquidity.usd) : null,
          volume24hUsd: pair.volume?.h24   !== undefined ? String(pair.volume.h24)   : null,
          tokenCreatedAt: pair.pairCreatedAt ? clampTimestamp(pair.pairCreatedAt) : null,
        });
      }
    } catch { /* skip this batch */ }
  }
  return map;
}

/** Public helper: fetch one token's live data from DexScreener. */
export async function fetchLivePrice(chain: string, address: string): Promise<(FreshPrice & { price: string }) | null> {
  const result = await fetchBatch(chain, [address]);
  const key = chain === "solana" ? address : address.toLowerCase();
  const dex = result.get(key) ?? null;
  if (dex) return dex;

  if (chain === "solana") {
    const pf = await fetchPumpFun(address);
    if (pf) return pf;
  }

  return null;
}

// ── PumpFun ───────────────────────────────────────────────────────────────────

interface PumpFunCoin {
  mint?: string;
  name?: string;
  symbol?: string;
  image_uri?: string;
  usd_market_cap?: number;
  virtual_sol_reserves?: number;
  virtual_token_reserves?: number;
  complete?: boolean;
  raydium_pool?: string | null;
  created_timestamp?: number;
}

export async function fetchPumpFun(address: string): Promise<FreshPrice | null> {
  try {
    const resp = await fetch(
      `https://frontend-api-v3.pump.fun/coins/${address}`,
      {
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; Crypsor/1.0)",
        },
      },
    );
    if (!resp.ok) return null;
    const coin = await resp.json() as PumpFunCoin;
    if (!coin.usd_market_cap) return null;

    const mc    = coin.usd_market_cap;
    const price = (mc / 1_000_000_000).toFixed(12);

    return {
      price,
      logo:          coin.image_uri ?? null,
      marketCapUsd:  String(mc),
      fdvUsd:        String(mc),
      liquidityUsd:  null,
      volume24hUsd:  null,
      tokenCreatedAt: coin.created_timestamp ? clampTimestamp(coin.created_timestamp) : null,
    };
  } catch {
    return null;
  }
}

// ── CoinGecko ─────────────────────────────────────────────────────────────────

interface CgPriceEntry { usd?: number; usd_market_cap?: number; usd_24h_vol?: number }

async function fetchCoinGeckoChain(
  chain: string,
  addresses: string[],
): Promise<Map<string, Partial<FreshPrice>>> {
  const map = new Map<string, Partial<FreshPrice>>();
  const platform = CG_PLATFORM[chain];
  if (!platform || addresses.length === 0) return map;

  for (let i = 0; i < addresses.length; i += 50) {
    const slice = addresses.slice(i, i + 50);
    try {
      const url =
        `https://api.coingecko.com/api/v3/simple/token_price/${platform}` +
        `?contract_addresses=${slice.join(",")}&vs_currencies=usd` +
        `&include_market_cap=true&include_24hr_vol=true`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!resp.ok) continue;
      const json = await resp.json() as Record<string, CgPriceEntry>;

      for (const [rawAddr, data] of Object.entries(json)) {
        if (!data.usd) continue;
        const addr = chain === "solana" ? rawAddr : rawAddr.toLowerCase();
        map.set(addr, {
          price:        String(data.usd),
          marketCapUsd: data.usd_market_cap ? String(data.usd_market_cap) : null,
          volume24hUsd: data.usd_24h_vol    ? String(data.usd_24h_vol)    : null,
          logo:         null,
          fdvUsd:       null,
          liquidityUsd: null,
          tokenCreatedAt: null,
        });
      }
    } catch { /* skip */ }
  }
  return map;
}

// ── Main refresh cycle ────────────────────────────────────────────────────────

export async function refreshAllPrices(): Promise<void> {
  const t0 = Date.now();
  try {
    const tokens = await db
      .select({
        id:              tracked_tokens.id,
        address:         tracked_tokens.address,
        chain:           tracked_tokens.chain,
        athPriceUsd:     tracked_tokens.athPriceUsd,
        athMarketCapUsd: tracked_tokens.athMarketCapUsd,
      })
      .from(tracked_tokens);

    if (!tokens.length) return;

    const byChain = new Map<string, typeof tokens>();
    for (const t of tokens) {
      if (!byChain.has(t.chain)) byChain.set(t.chain, []);
      byChain.get(t.chain)!.push(t);
    }

    let updated = 0;
    for (const [chain, group] of byChain) {
      const addrs  = group.map(t => chain === "solana" ? t.address : t.address.toLowerCase());
      const dexMap = await fetchBatch(chain, addrs);

      // For Solana tokens missing from DexScreener, try PumpFun
      const missingFromDex = chain === "solana"
        ? group.filter(t => !dexMap.has(t.address))
        : [];

      const pfResults = await Promise.allSettled(
        missingFromDex.map(t => fetchPumpFun(t.address).then(r => ({ address: t.address, r }))),
      );
      const pfMap = new Map<string, FreshPrice>();
      for (const res of pfResults) {
        if (res.status === "fulfilled" && res.value.r) {
          pfMap.set(res.value.address, res.value.r);
        }
      }

      // CoinGecko as supplementary for EVM chains with missing DexScreener data
      let cgMap = new Map<string, Partial<FreshPrice>>();
      if (chain !== "solana") {
        const missing = group
          .filter(t => !dexMap.has(t.address.toLowerCase()))
          .map(t => t.address.toLowerCase());
        if (missing.length > 0) {
          cgMap = await fetchCoinGeckoChain(chain, missing);
        }
      }

      for (const token of group) {
        const key   = chain === "solana" ? token.address : token.address.toLowerCase();
        const fresh: FreshPrice | Partial<FreshPrice> | undefined =
          dexMap.get(key) ?? pfMap.get(key) ?? cgMap.get(key);
        if (!fresh?.price) continue;

        const curNum   = parseFloat(fresh.price);
        const athNum   = token.athPriceUsd     ? parseFloat(token.athPriceUsd)     : 0;
        const athMcNum = token.athMarketCapUsd  ? parseFloat(token.athMarketCapUsd) : 0;
        const curMcNum = fresh.marketCapUsd     ? parseFloat(fresh.marketCapUsd)    : 0;

        const newAth   = curNum   > athNum   ? fresh.price        : (token.athPriceUsd    ?? fresh.price);
        const newAthMc = curMcNum > athMcNum ? fresh.marketCapUsd : (token.athMarketCapUsd ?? fresh.marketCapUsd ?? null);

        await db.update(tracked_tokens).set({
          currentPriceUsd: fresh.price,
          athPriceUsd:     newAth,
          athMarketCapUsd: newAthMc,
          priceUpdatedAt:  new Date(),
          ...((fresh as FreshPrice).logo      ? { logoUri:        (fresh as FreshPrice).logo! }      : {}),
          ...(fresh.marketCapUsd  ? { marketCapUsd:   fresh.marketCapUsd }  : {}),
          ...(fresh.fdvUsd        ? { fdvUsd:         fresh.fdvUsd }        : {}),
          ...(fresh.liquidityUsd  ? { liquidityUsd:   fresh.liquidityUsd }  : {}),
          ...(fresh.volume24hUsd  ? { volume24hUsd:   fresh.volume24hUsd }  : {}),
          ...(fresh.tokenCreatedAt ? { tokenCreatedAt: fresh.tokenCreatedAt } : {}),
        }).where(eq(tracked_tokens.id, token.id));

        eventBus.emit("price:updated", {
          tokenId:      token.id,
          tokenAddress: token.address,
          chain:        token.chain,
          priceUsd:     fresh.price,
          marketCapUsd: fresh.marketCapUsd ?? null,
          athPriceUsd:  newAth,
        });

        // Write a price snapshot for the intelligence engine
        db.insert(token_price_snapshots).values({
          tokenId:      token.id,
          priceUsd:     fresh.price,
          marketCapUsd: fresh.marketCapUsd ?? null,
          liquidityUsd: fresh.liquidityUsd ?? null,
          volume24hUsd: fresh.volume24hUsd ?? null,
        }).catch(() => {}); // fire-and-forget

        updated++;
      }
    }

    healthMonitor.ok("price-service", Date.now() - t0);
    if (updated > 0) logger.info({ updated, ms: Date.now() - t0 }, "Price refresh complete");
  } catch (err) {
    healthMonitor.error("price-service", err);
    logger.warn({ err }, "Price refresh cycle failed");
  }
}

/**
 * Start the price service.
 * Periodic refresh runs every 20 s after the previous run completes (no overlap).
 * Initial delay is 8 s to allow other services to settle.
 */
export function startPriceService() {
  const loop = () => {
    refreshAllPrices()
      .catch(err => logger.warn({ err }, "Price refresh failed"))
      .finally(() => setTimeout(loop, 20_000));
  };
  setTimeout(loop, 8_000);
  logger.info("Price service ready (20 s cycle; DexScreener + PumpFun + CoinGecko)");
}
