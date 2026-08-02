import { db } from "@workspace/db";
import { tracked_tokens, token_price_snapshots, pro_calls } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { invalidateCallsCaches } from "../lib/pro-cache";
import { eventBus } from "./event-bus";
import { healthMonitor } from "./health-monitor";

/** Live tokens — refreshed every cycle. */
const HOT_STATUSES = ["new", "active", "watch", "revived"] as const;
/** Cold tokens still need occasional pricing for revival / dump detection. */
const COLD_STATUSES = ["archive", "dumped"] as const;
const COLD_REFRESH_EVERY_N = 15; // ~every 15 hot cycles (~5 min at 20s)
/** Desk-only refresher — free DexScreener/PumpFun for Waiting/Best rows. */
const DESK_REFRESH_MS = 10_000;
const FULL_REFRESH_MS = 20_000;
let priceRefreshCycle = 0;
let deskRefreshRunning = false;
let fullRefreshRunning = false;

type TrackedPriceRow = {
  id: number;
  address: string;
  chain: string;
  athPriceUsd: string | null;
  athMarketCapUsd: string | null;
};

type DeskTick = {
  tokenId: number;
  tokenAddress: string;
  marketCapUsd: string | null;
  athMarketCapUsd: string | null;
};

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
      const byAddr = new Map<string, NonNullable<typeof json.pairs>[number]>();
      for (const pair of json.pairs ?? []) {
        if (pair.chainId !== dexChain || !pair.priceUsd) continue;
        const addr = chain === "solana" ? pair.baseToken.address : pair.baseToken.address.toLowerCase();
        const existing = byAddr.get(addr);
        if (!existing || pair.dexId === "raydium") {
          byAddr.set(addr, pair);
        }
      }

      for (const [addr, pair] of byAddr) {
        // Never fall back to FDV for marketCap — FDV = price × total supply (1B for pump.fun),
        // not circulating MC. Migrated pump.fun tokens have no real marketCap on DexScreener;
        // the PumpFun/CoinGecko fallback provides the correct circulating MC instead.
        const mc = pair.marketCap ?? null;
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

    // G1 fix: derive virtual liquidity from bonding curve reserves for pre-graduation tokens.
    // Formula: virtual_liq_usd = 2 × (vsr_lamports/1e9) × sol_price_usd
    //   where sol_price_usd = mc_usd / (vtr_raw/1e6) / 1e9
    //   simplifies to: 2 × mc × virtual_token_reserves / 1e15
    // Only computed for tokens still on the bonding curve (not yet on Raydium).
    let liquidityUsd: string | null = null;
    if (
      !coin.complete &&
      !coin.raydium_pool &&
      coin.virtual_sol_reserves != null &&
      coin.virtual_token_reserves != null &&
      coin.virtual_token_reserves > 0
    ) {
      const virtualLiq = 2 * mc * coin.virtual_token_reserves / 1e15;
      if (isFinite(virtualLiq) && virtualLiq > 0) {
        liquidityUsd = String(Math.round(virtualLiq));
      }
    }

    return {
      price,
      logo:          coin.image_uri ?? null,
      marketCapUsd:  String(mc),
      fdvUsd:        String(mc),
      liquidityUsd,
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

// ── Persist helpers ───────────────────────────────────────────────────────────

async function loadDeskTokens(): Promise<TrackedPriceRow[]> {
  return db
    .select({
      id: tracked_tokens.id,
      address: tracked_tokens.address,
      chain: tracked_tokens.chain,
      athPriceUsd: tracked_tokens.athPriceUsd,
      athMarketCapUsd: tracked_tokens.athMarketCapUsd,
    })
    .from(pro_calls)
    .innerJoin(tracked_tokens, eq(pro_calls.tokenId, tracked_tokens.id));
}

async function persistFreshPrice(
  token: TrackedPriceRow,
  fresh: FreshPrice | Partial<FreshPrice>,
  opts: { emitPriceUpdated: boolean; writeSnapshot: boolean },
): Promise<DeskTick | null> {
  if (!fresh.price) return null;

  const curNum = parseFloat(fresh.price);
  const athNum = token.athPriceUsd ? parseFloat(token.athPriceUsd) : 0;
  const athMcNum = token.athMarketCapUsd ? parseFloat(token.athMarketCapUsd) : 0;
  const curMcNum = fresh.marketCapUsd ? parseFloat(fresh.marketCapUsd) : 0;

  const newAth = curNum > athNum ? fresh.price : (token.athPriceUsd ?? fresh.price);
  const newAthMc = curMcNum > athMcNum
    ? (fresh.marketCapUsd ?? null)
    : (token.athMarketCapUsd ?? fresh.marketCapUsd ?? null);

  await db.update(tracked_tokens).set({
    currentPriceUsd: fresh.price,
    athPriceUsd: newAth,
    athMarketCapUsd: newAthMc,
    priceUpdatedAt: new Date(),
    ...((fresh as FreshPrice).logo ? { logoUri: (fresh as FreshPrice).logo! } : {}),
    ...(fresh.marketCapUsd ? { marketCapUsd: fresh.marketCapUsd } : {}),
    ...(fresh.fdvUsd ? { fdvUsd: fresh.fdvUsd } : {}),
    ...(fresh.liquidityUsd ? { liquidityUsd: fresh.liquidityUsd } : {}),
    ...(fresh.volume24hUsd ? { volume24hUsd: fresh.volume24hUsd } : {}),
    ...(fresh.tokenCreatedAt ? { tokenCreatedAt: fresh.tokenCreatedAt } : {}),
  }).where(eq(tracked_tokens.id, token.id));

  if (opts.emitPriceUpdated) {
    eventBus.emit("price:updated", {
      tokenId: token.id,
      tokenAddress: token.address,
      chain: token.chain,
      priceUsd: fresh.price,
      marketCapUsd: fresh.marketCapUsd ?? null,
      athPriceUsd: newAth,
    });
  }

  if (opts.writeSnapshot) {
    db.insert(token_price_snapshots).values({
      tokenId: token.id,
      priceUsd: fresh.price,
      marketCapUsd: fresh.marketCapUsd ?? null,
      liquidityUsd: fresh.liquidityUsd ?? null,
      volume24hUsd: fresh.volume24hUsd ?? null,
    }).catch(() => {});
  }

  // Keep in-memory ATH so later ticks in the same cycle see the bump
  token.athPriceUsd = newAth;
  token.athMarketCapUsd = newAthMc;

  return {
    tokenId: token.id,
    tokenAddress: token.address,
    marketCapUsd: fresh.marketCapUsd ?? null,
    athMarketCapUsd: newAthMc,
  };
}

async function fetchAndApplyGroup(
  chain: string,
  group: TrackedPriceRow[],
  opts: { emitPriceUpdated: boolean; writeSnapshot: boolean; useCoinGecko: boolean },
): Promise<DeskTick[]> {
  const ticks: DeskTick[] = [];
  if (!group.length) return ticks;

  const addrs = group.map(t => (chain === "solana" ? t.address : t.address.toLowerCase()));
  const dexMap = await fetchBatch(chain, addrs);

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

  let cgMap = new Map<string, Partial<FreshPrice>>();
  if (opts.useCoinGecko && chain !== "solana") {
    const missing = group
      .filter(t => !dexMap.has(t.address.toLowerCase()))
      .map(t => t.address.toLowerCase());
    if (missing.length > 0) {
      cgMap = await fetchCoinGeckoChain(chain, missing);
    }
  }

  for (const token of group) {
    const key = chain === "solana" ? token.address : token.address.toLowerCase();
    const fresh = dexMap.get(key) ?? pfMap.get(key) ?? cgMap.get(key);
    if (!fresh?.price) continue;
    const tick = await persistFreshPrice(token, fresh, opts);
    if (tick) ticks.push(tick);
  }
  return ticks;
}

function emitDeskPrices(ticks: DeskTick[]): void {
  if (!ticks.length) return;
  eventBus.emit("prices:desk", {
    ticks,
    at: new Date().toISOString(),
  });
  void invalidateCallsCaches();
}

// ── Main refresh cycle ────────────────────────────────────────────────────────

export async function refreshAllPrices(): Promise<void> {
  if (fullRefreshRunning) return;
  fullRefreshRunning = true;
  const t0 = Date.now();
  try {
    // Prefer hot tokens every cycle; include cold tokens only periodically so
    // thousands of archived rows don't thrash DexScreener + the DB every 20s.
    // Always union Calls-desk tokens (pro_calls) so Waiting/Best MC stay live
    // even when status has flipped to archive.
    priceRefreshCycle += 1;
    const wantCold = priceRefreshCycle % COLD_REFRESH_EVERY_N === 0;

    const [statusTokens, deskTokens] = await Promise.all([
      db
        .select({
          id: tracked_tokens.id,
          address: tracked_tokens.address,
          chain: tracked_tokens.chain,
          athPriceUsd: tracked_tokens.athPriceUsd,
          athMarketCapUsd: tracked_tokens.athMarketCapUsd,
        })
        .from(tracked_tokens)
        .where(
          wantCold
            ? inArray(tracked_tokens.status, [...HOT_STATUSES, ...COLD_STATUSES])
            : inArray(tracked_tokens.status, [...HOT_STATUSES]),
        ),
      loadDeskTokens(),
    ]);

    const byId = new Map<number, TrackedPriceRow>();
    for (const t of statusTokens) byId.set(t.id, t);
    for (const t of deskTokens) byId.set(t.id, t);
    const tokens = [...byId.values()];
    if (!tokens.length) return;

    const byChain = new Map<string, TrackedPriceRow[]>();
    for (const t of tokens) {
      if (!byChain.has(t.chain)) byChain.set(t.chain, []);
      byChain.get(t.chain)!.push(t);
    }

    const deskIds = new Set(deskTokens.map(t => t.id));
    const deskTicks: DeskTick[] = [];
    let updated = 0;

    for (const [chain, group] of byChain) {
      const ticks = await fetchAndApplyGroup(chain, group, {
        emitPriceUpdated: true,
        writeSnapshot: true,
        useCoinGecko: true,
      });
      updated += ticks.length;
      for (const tick of ticks) {
        if (deskIds.has(tick.tokenId)) deskTicks.push(tick);
      }
    }

    emitDeskPrices(deskTicks);
    healthMonitor.ok("price-service", Date.now() - t0);
    if (updated > 0) {
      logger.info({ updated, desk: deskTicks.length, ms: Date.now() - t0 }, "Price refresh complete");
    }
  } catch (err) {
    healthMonitor.error("price-service", err);
    logger.warn({ err }, "Price refresh cycle failed");
  } finally {
    fullRefreshRunning = false;
  }
}

/**
 * Faster free-price loop for Calls desk only (pro_calls × DexScreener/PumpFun).
 * Keeps Waiting/Best MC near-live without refreshing the whole inventory.
 */
export async function refreshDeskPrices(): Promise<void> {
  if (deskRefreshRunning || fullRefreshRunning) return;
  deskRefreshRunning = true;
  const t0 = Date.now();
  try {
    const tokens = await loadDeskTokens();
    if (!tokens.length) return;

    const byChain = new Map<string, TrackedPriceRow[]>();
    for (const t of tokens) {
      if (!byChain.has(t.chain)) byChain.set(t.chain, []);
      byChain.get(t.chain)!.push(t);
    }

    const deskTicks: DeskTick[] = [];
    for (const [chain, group] of byChain) {
      const ticks = await fetchAndApplyGroup(chain, group, {
        // Full cycle owns projection/snapshots — desk loop only patches MC for UI
        emitPriceUpdated: false,
        writeSnapshot: false,
        useCoinGecko: false,
      });
      deskTicks.push(...ticks);
    }

    emitDeskPrices(deskTicks);
    if (deskTicks.length > 0) {
      logger.info({ updated: deskTicks.length, ms: Date.now() - t0 }, "Desk price refresh");
    }
  } catch (err) {
    logger.warn({ err }, "Desk price refresh failed");
  } finally {
    deskRefreshRunning = false;
  }
}

/**
 * Start the price service.
 * - Full inventory: DexScreener + PumpFun + CoinGecko every 20s
 * - Calls desk: free DexScreener/PumpFun every 10s + SSE prices:desk
 */
export function startPriceService() {
  const loopFull = () => {
    refreshAllPrices()
      .catch(err => logger.warn({ err }, "Price refresh failed"))
      .finally(() => setTimeout(loopFull, FULL_REFRESH_MS));
  };
  const loopDesk = () => {
    refreshDeskPrices()
      .catch(err => logger.warn({ err }, "Desk price refresh failed"))
      .finally(() => setTimeout(loopDesk, DESK_REFRESH_MS));
  };
  setTimeout(loopFull, 8_000);
  setTimeout(loopDesk, 4_000);
  logger.info(
    "Price service ready (desk 10s DexScreener/PumpFun; full 20s + CoinGecko)",
  );
}
