import { db } from "@workspace/db";
import { tracked_tokens, token_price_snapshots, pro_calls } from "@workspace/db";
import { desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { invalidateCallsCaches } from "../lib/pro-cache";
import { opsLog } from "../lib/ops-log";
import { eventBus } from "./event-bus";
import { healthMonitor } from "./health-monitor";

/** Live tokens — refreshed every cycle. */
const HOT_STATUSES = ["new", "active", "watch", "revived"] as const;
/** Cold tokens still need occasional pricing for revival / dump detection. */
const COLD_STATUSES = ["archive", "dumped"] as const;
const COLD_REFRESH_EVERY_N = 15; // ~every 15 hot cycles (~5 min at 20s)
/** Cap cold slice so archive thousands never hang a cycle. */
const COLD_BATCH = 80;
/** Cap hot set per cycle — stalest first so the budget rotates coverage. */
const HOT_BATCH = 250;
/** Desk-only refresher — free DexScreener/PumpFun for Waiting/Best rows. */
const DESK_REFRESH_MS = 8_000;
const FULL_REFRESH_MS = 25_000;
/** Never pull the entire historical pro_calls table into a price cycle. */
const DESK_TOKEN_LIMIT = 100;
const FULL_CYCLE_BUDGET_MS = 45_000;
const DESK_CYCLE_BUDGET_MS = 12_000;
/** Feed overlay must not stall Waiting/Latest if Dex is slow. */
const OVERLAY_BUDGET_MS = 2_500;
const PERSIST_CONCURRENCY = 20;
const PUMPFUN_CONCURRENCY = 8;
let priceRefreshCycle = 0;
let deskRefreshRunning = false;
let fullRefreshRunning = false;
let invalidateTimer: ReturnType<typeof setTimeout> | null = null;

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

type DexPair = {
  chainId: string;
  dexId?: string;
  baseToken: { address: string };
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  pairCreatedAt?: number;
  info?: { imageUrl?: string };
};

/** Prefer deepest pool; Raydium only as a tie-break (never over a richer pool). */
function preferDexPair(next: DexPair, prev: DexPair): boolean {
  const liqNext = next.liquidity?.usd ?? 0;
  const liqPrev = prev.liquidity?.usd ?? 0;
  if (liqNext !== liqPrev) return liqNext > liqPrev;
  if (next.dexId === "raydium" && prev.dexId !== "raydium") return true;
  if (prev.dexId === "raydium" && next.dexId !== "raydium") return false;
  // Prefer a pair that actually reports circulating MC
  const mcNext = next.marketCap != null ? 1 : 0;
  const mcPrev = prev.marketCap != null ? 1 : 0;
  return mcNext > mcPrev;
}

async function fetchBatch(
  chain: string,
  addresses: string[],
  opts?: { deadlineMs?: number; timeoutMs?: number },
): Promise<Map<string, FreshPrice>> {
  const map = new Map<string, FreshPrice>();
  if (!addresses.length) return map;
  const dexChain = DEXCHAIN[chain] ?? chain;
  const timeoutMs = opts?.timeoutMs ?? 12_000;

  for (let i = 0; i < addresses.length; i += 30) {
    if (opts?.deadlineMs != null && Date.now() > opts.deadlineMs) break;
    const slice = addresses.slice(i, i + 30);
    try {
      const resp = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${slice.join(",")}`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!resp.ok) continue;
      const json = await resp.json() as { pairs?: DexPair[] };

      const byAddr = new Map<string, DexPair>();
      for (const pair of json.pairs ?? []) {
        if (pair.chainId !== dexChain || !pair.priceUsd) continue;
        const addr = chain === "solana"
          ? pair.baseToken.address
          : pair.baseToken.address.toLowerCase();
        const existing = byAddr.get(addr);
        if (!existing || preferDexPair(pair, existing)) {
          byAddr.set(addr, pair);
        }
      }

      for (const [addr, pair] of byAddr) {
        // Never fall back to FDV for marketCap — FDV = price × total supply (1B for pump.fun).
        // PumpFun/CoinGecko fallbacks fill circulating MC when Dex omits it.
        const mc = pair.marketCap ?? null;
        map.set(addr, {
          price: pair.priceUsd!,
          logo: pair.info?.imageUrl ?? null,
          marketCapUsd: mc !== null ? String(mc) : null,
          fdvUsd: pair.fdv !== undefined ? String(pair.fdv) : null,
          liquidityUsd: pair.liquidity?.usd !== undefined ? String(pair.liquidity.usd) : null,
          volume24hUsd: pair.volume?.h24 !== undefined ? String(pair.volume.h24) : null,
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

export async function fetchPumpFun(
  address: string,
  opts?: { timeoutMs?: number },
): Promise<FreshPrice | null> {
  try {
    const resp = await fetch(
      `https://frontend-api-v3.pump.fun/coins/${address}`,
      {
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 10_000),
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

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        out[idx] = await fn(items[idx]!);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/** Recent + waiting desk tokens only — never the full historical pro_calls set. */
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
    .innerJoin(tracked_tokens, eq(pro_calls.tokenId, tracked_tokens.id))
    .where(
      or(
        isNull(pro_calls.callAlertSentAt),
        sql`${pro_calls.calledAt} > NOW() - INTERVAL '72 hours'`,
      ),
    )
    .orderBy(desc(pro_calls.calledAt))
    .limit(DESK_TOKEN_LIMIT);
}

async function persistFreshPrice(
  token: TrackedPriceRow,
  fresh: FreshPrice | Partial<FreshPrice>,
  opts: { emitPriceUpdated: boolean; writeSnapshot: boolean },
): Promise<DeskTick | null> {
  if (!fresh.price) return null;

  const curNum = parseFloat(fresh.price);
  if (!Number.isFinite(curNum) || curNum <= 0) return null;
  const athNum = token.athPriceUsd ? parseFloat(token.athPriceUsd) : 0;
  const athMcNum = token.athMarketCapUsd ? parseFloat(token.athMarketCapUsd) : 0;
  const curMcNum = fresh.marketCapUsd ? parseFloat(fresh.marketCapUsd) : 0;
  const safeAthNum = Number.isFinite(athNum) ? athNum : 0;
  const safeAthMcNum = Number.isFinite(athMcNum) ? athMcNum : 0;
  const safeCurMcNum = Number.isFinite(curMcNum) ? curMcNum : 0;

  const newAth = curNum > safeAthNum ? fresh.price : (token.athPriceUsd ?? fresh.price);
  const newAthMc = safeCurMcNum > safeAthMcNum
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
  opts: {
    emitPriceUpdated: boolean;
    writeSnapshot: boolean;
    useCoinGecko: boolean;
    deadlineMs: number;
  },
): Promise<DeskTick[]> {
  const ticks: DeskTick[] = [];
  if (!group.length) return ticks;
  if (Date.now() > opts.deadlineMs) return ticks;

  const addrs = group.map(t => (chain === "solana" ? t.address : t.address.toLowerCase()));
  const dexMap = await fetchBatch(chain, addrs, { deadlineMs: opts.deadlineMs });

  // PumpFun for Dex misses OR Dex hits with price but no circulating MC
  const needPump = chain === "solana"
    ? group.filter((t) => {
      const hit = dexMap.get(t.address);
      return !hit || !hit.marketCapUsd;
    })
    : [];

  const pfMap = new Map<string, FreshPrice>();
  if (needPump.length && Date.now() <= opts.deadlineMs) {
    const pfResults = await mapPool(
      needPump.slice(0, 40),
      PUMPFUN_CONCURRENCY,
      async (t) => {
        const r = await fetchPumpFun(t.address);
        return { address: t.address, r };
      },
    );
    for (const res of pfResults) {
      if (res.r) pfMap.set(res.address, res.r);
    }
  }

  let cgMap = new Map<string, Partial<FreshPrice>>();
  if (opts.useCoinGecko && chain !== "solana" && Date.now() <= opts.deadlineMs) {
    const missing = group
      .filter(t => !dexMap.has(t.address.toLowerCase()))
      .map(t => t.address.toLowerCase())
      .slice(0, 50);
    if (missing.length > 0) {
      cgMap = await fetchCoinGeckoChain(chain, missing);
    }
  }

  const pending: Array<{ token: TrackedPriceRow; fresh: FreshPrice | Partial<FreshPrice> }> = [];
  for (const token of group) {
    const key = chain === "solana" ? token.address : token.address.toLowerCase();
    const dex = dexMap.get(key);
    const pf = pfMap.get(key);
    const cg = cgMap.get(key);
    // Prefer source that has circulating MC; else first price hit
    let fresh: FreshPrice | Partial<FreshPrice> | undefined;
    if (dex?.marketCapUsd) fresh = dex;
    else if (pf?.marketCapUsd) fresh = pf;
    else if (cg?.marketCapUsd) fresh = cg;
    else fresh = dex ?? pf ?? cg;
    if (!fresh?.price) continue;
    pending.push({ token, fresh });
  }

  const persisted = await mapPool(pending, PERSIST_CONCURRENCY, async ({ token, fresh }) => {
    if (Date.now() > opts.deadlineMs) return null;
    return persistFreshPrice(token, fresh, opts);
  });
  for (const tick of persisted) {
    if (tick) ticks.push(tick);
  }
  return ticks;
}

function scheduleCacheInvalidate(): void {
  if (invalidateTimer) return;
  invalidateTimer = setTimeout(() => {
    invalidateTimer = null;
    void invalidateCallsCaches();
  }, 250);
}

function emitDeskPrices(ticks: DeskTick[]): void {
  if (!ticks.length) return;
  eventBus.emit("prices:desk", {
    ticks,
    at: new Date().toISOString(),
  });
  scheduleCacheInvalidate();
}

/**
 * Overlay live DexScreener/PumpFun MC onto the visible Calls page.
 * Hard time budget — on timeout, returns DB values (never stalls the desk).
 */
export async function overlayLiveMarketCaps<T extends {
  id: number;
  address: string;
  chain: string;
  calledMcUsd: number | null;
  currentMcUsd: number | null;
  athMcUsd: number | null;
  gainPct: number | null;
  nowMultiple: number;
  athMultiple: number;
}>(cards: T[]): Promise<T[]> {
  if (!cards.length) return cards;
  const deadlineMs = Date.now() + OVERLAY_BUDGET_MS;

  try {
    const byChain = new Map<string, T[]>();
    for (const c of cards) {
      const chain = c.chain || "solana";
      if (!byChain.has(chain)) byChain.set(chain, []);
      byChain.get(chain)!.push(c);
    }

    const liveById = new Map<number, FreshPrice>();
    for (const [chain, group] of byChain) {
      if (Date.now() > deadlineMs) break;
      const addrs = group.map(c => (chain === "solana" ? c.address : c.address.toLowerCase()));
      const dexMap = await fetchBatch(chain, addrs, {
        deadlineMs,
        timeoutMs: 2_000,
      });

      const needPump = chain === "solana"
        ? group.filter((c) => {
          const hit = dexMap.get(c.address);
          return !hit || !hit.marketCapUsd;
        }).slice(0, 12)
        : [];
      const pfRows = needPump.length && Date.now() <= deadlineMs
        ? await mapPool(needPump, 4, async (c) => {
          const r = await fetchPumpFun(c.address, { timeoutMs: 1_500 });
          return { id: c.id, address: c.address, r };
        })
        : [];
      const pfByAddr = new Map(
        pfRows.filter(p => p.r).map(p => [p.address, p.r!] as const),
      );

      for (const c of group) {
        const key = chain === "solana" ? c.address : c.address.toLowerCase();
        const dex = dexMap.get(key);
        const pf = pfByAddr.get(c.address);
        const fresh = (dex?.marketCapUsd ? dex : null)
          ?? (pf?.marketCapUsd ? pf : null)
          ?? dex
          ?? pf
          ?? null;
        if (fresh?.price) liveById.set(c.id, fresh);
      }
    }

    if (!liveById.size) return cards;

    // Persist in background — response uses live numbers immediately
    void (async () => {
      try {
        await mapPool([...liveById.entries()], 8, async ([tokenId, fresh]) => {
          if (!fresh.price) return;
          await db.update(tracked_tokens).set({
            currentPriceUsd: fresh.price,
            priceUpdatedAt: new Date(),
            ...(fresh.marketCapUsd ? { marketCapUsd: fresh.marketCapUsd } : {}),
            ...(fresh.liquidityUsd ? { liquidityUsd: fresh.liquidityUsd } : {}),
            ...(fresh.volume24hUsd ? { volume24hUsd: fresh.volume24hUsd } : {}),
          }).where(eq(tracked_tokens.id, tokenId));
        });
        scheduleCacheInvalidate();
      } catch { /* never break feed */ }
    })();

    return cards.map((c) => {
      const fresh = liveById.get(c.id);
      if (!fresh) return c;
      const parsedMc = fresh.marketCapUsd != null ? parseFloat(fresh.marketCapUsd) : NaN;
      const currentMcUsd = Number.isFinite(parsedMc) ? parsedMc : c.currentMcUsd;
      if (currentMcUsd == null || !Number.isFinite(currentMcUsd)) return c;
      const called = c.calledMcUsd;
      let gainPct = c.gainPct;
      let nowMultiple = c.nowMultiple;
      if (called != null && called > 0) {
        nowMultiple = Math.round((currentMcUsd / called) * 100) / 100;
        gainPct = ((currentMcUsd - called) / called) * 100;
      }
      return { ...c, currentMcUsd, gainPct, nowMultiple };
    });
  } catch {
    return cards;
  }
}

// ── Main refresh cycle ────────────────────────────────────────────────────────

export async function refreshAllPrices(): Promise<void> {
  if (fullRefreshRunning) return;
  fullRefreshRunning = true;
  const t0 = Date.now();
  const deadlineMs = t0 + FULL_CYCLE_BUDGET_MS;
  try {
    // Hot statuses only — desk loop owns Waiting/Best MC. Cold is a small
    // oldest-price batch so archive thousands cannot hang the cycle.
    priceRefreshCycle += 1;
    const wantCold = priceRefreshCycle % COLD_REFRESH_EVERY_N === 0;

    const hotTokens = await db
      .select({
        id: tracked_tokens.id,
        address: tracked_tokens.address,
        chain: tracked_tokens.chain,
        athPriceUsd: tracked_tokens.athPriceUsd,
        athMarketCapUsd: tracked_tokens.athMarketCapUsd,
      })
      .from(tracked_tokens)
      .where(inArray(tracked_tokens.status, [...HOT_STATUSES]))
      .orderBy(sql`${tracked_tokens.priceUpdatedAt} ASC NULLS FIRST`)
      .limit(HOT_BATCH);

    let tokens: TrackedPriceRow[] = hotTokens;
    if (wantCold) {
      const cold = await db
        .select({
          id: tracked_tokens.id,
          address: tracked_tokens.address,
          chain: tracked_tokens.chain,
          athPriceUsd: tracked_tokens.athPriceUsd,
          athMarketCapUsd: tracked_tokens.athMarketCapUsd,
        })
        .from(tracked_tokens)
        .where(inArray(tracked_tokens.status, [...COLD_STATUSES]))
        .orderBy(sql`${tracked_tokens.priceUpdatedAt} ASC NULLS FIRST`)
        .limit(COLD_BATCH);
      const byId = new Map<number, TrackedPriceRow>();
      for (const t of hotTokens) byId.set(t.id, t);
      for (const t of cold) byId.set(t.id, t);
      tokens = [...byId.values()];
    }

    if (!tokens.length) {
      healthMonitor.ok("price-service", Date.now() - t0);
      return;
    }

    const byChain = new Map<string, TrackedPriceRow[]>();
    for (const t of tokens) {
      if (!byChain.has(t.chain)) byChain.set(t.chain, []);
      byChain.get(t.chain)!.push(t);
    }

    let updated = 0;
    for (const [chain, group] of byChain) {
      if (Date.now() > deadlineMs) break;
      const ticks = await fetchAndApplyGroup(chain, group, {
        emitPriceUpdated: true,
        writeSnapshot: true,
        useCoinGecko: true,
        deadlineMs,
      });
      updated += ticks.length;
    }

    healthMonitor.ok("price-service", Date.now() - t0);
    if (updated > 0) {
      logger.info({ updated, ms: Date.now() - t0 }, "Price refresh complete");
      opsLog("price", "info", `Price refresh · ${updated} tokens`, { ms: Date.now() - t0 });
    }
  } catch (err) {
    healthMonitor.error("price-service", err);
    logger.warn({ err }, "Price refresh cycle failed");
    opsLog("price", "error", `Price refresh failed: ${String(err).slice(0, 140)}`);
  } finally {
    fullRefreshRunning = false;
  }
}

/**
 * Independent desk loop — never blocked by the full inventory refresh.
 * Free DexScreener + PumpFun for recent/waiting pro_calls only.
 */
export async function refreshDeskPrices(): Promise<void> {
  if (deskRefreshRunning) return;
  deskRefreshRunning = true;
  const t0 = Date.now();
  const deadlineMs = t0 + DESK_CYCLE_BUDGET_MS;
  try {
    const tokens = await loadDeskTokens();
    if (!tokens.length) {
      healthMonitor.ok("price-service", Date.now() - t0);
      return;
    }

    const byChain = new Map<string, TrackedPriceRow[]>();
    for (const t of tokens) {
      if (!byChain.has(t.chain)) byChain.set(t.chain, []);
      byChain.get(t.chain)!.push(t);
    }

    const deskTicks: DeskTick[] = [];
    for (const [chain, group] of byChain) {
      if (Date.now() > deadlineMs) break;
      const ticks = await fetchAndApplyGroup(chain, group, {
        emitPriceUpdated: false,
        writeSnapshot: false,
        useCoinGecko: false,
        deadlineMs,
      });
      deskTicks.push(...ticks);
    }

    emitDeskPrices(deskTicks);
    healthMonitor.ok("price-service", Date.now() - t0);
    if (deskTicks.length > 0) {
      logger.info({ updated: deskTicks.length, ms: Date.now() - t0 }, "Desk price refresh");
      opsLog("price", "info", `Desk price · ${deskTicks.length} tokens`, {
        ms: Date.now() - t0,
      });
    }
  } catch (err) {
    logger.warn({ err }, "Desk price refresh failed");
    opsLog("price", "warn", `Desk price failed: ${String(err).slice(0, 140)}`);
  } finally {
    deskRefreshRunning = false;
  }
}

/**
 * Start the price service.
 * - Desk (Waiting/Latest): DexScreener/PumpFun every 8s, independent of full cycle
 * - Full hot inventory: every 25s with a hard time budget (no hang)
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
  setTimeout(loopDesk, 2_000);
  setTimeout(loopFull, 10_000);
  logger.info(
    "Price service ready (desk 8s DexScreener/PumpFun; full 25s budgeted hot set)",
  );
}
