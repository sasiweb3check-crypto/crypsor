/**
 * GEM enrichment — live GMGN + pump.fun intel at snapshot level.
 *
 * Fills the data gaps the gem engine was scoring blind on:
 *   - holder_count + liquidity      (GMGN token_info; Dex often lags/misses)
 *   - smart / KOL counts            (GMGN token_holder_stat)
 *   - HOLD SHARES from top holders  (GMGN token_holders top-20 with tags):
 *       top10Pct        current top-10 share of supply (pools excluded)
 *       smartHoldPct    % of supply held by smart-money wallets — trusted lift
 *       kolHoldPct      % of supply held by KOL/renowned wallets — trusted lift
 *       sniperHoldPct   % held by snipers  — veto material
 *       bundlerHoldPct  % held by bundlers — veto material
 *
 * Uses gmgnFetch (OpenAPI-first when GMGN_API_KEY is set, browser-header curl
 * scrape fallback + proxy pool). Rate-limited: in-memory TTL per token +
 * a global bucket so a busy scan cycle can't hammer GMGN.
 *
 * Results are persisted onto tracked_tokens.holder_* so the whole app
 * (desk cards, stories, confidence) benefits, not just the score.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { gmgnFetch, nextProxy } from "./gmgn-client";

const log = logger.child({ module: "gem-enrich" });

export type GemIntel = {
  holderCount: number | null;
  liqUsd: number | null;
  smartCount: number | null;
  kolCount: number | null;
  sniperCount: number | null;
  bundlerCount: number | null;
  insiderCount: number | null;
  top10Pct: number | null;        // percent 0-100, pools excluded
  smartHoldPct: number | null;    // percent of supply
  kolHoldPct: number | null;
  sniperHoldPct: number | null;
  bundlerHoldPct: number | null;
  insiderHoldPct: number | null;
  fetchedAtMs: number;
};

// ── Rate limiting ────────────────────────────────────────────────────────────

const cache = new Map<number, GemIntel>();
const HOT_TTL_MS = 150_000;      // young/hot tokens: refresh every ~2.5 min
const COLD_TTL_MS = 8 * 60_000;  // older tokens: every ~8 min

// Global bucket: at most N enrichments per minute across all tokens
const BUCKET_MAX = 8;
let bucketTokens = BUCKET_MAX;
let bucketRefillAt = Date.now() + 60_000;

function takeBucketToken(): boolean {
  const now = Date.now();
  if (now >= bucketRefillAt) {
    bucketTokens = BUCKET_MAX;
    bucketRefillAt = now + 60_000;
  }
  if (bucketTokens <= 0) return false;
  bucketTokens -= 1;
  return true;
}

const inFlight = new Map<number, Promise<GemIntel | null>>();

// ── Parsing ──────────────────────────────────────────────────────────────────

const SMART_TAGS = new Set(["smart_degen", "smart_money"]);
const KOL_TAGS = new Set(["kol", "renowned"]);
const SNIPER_TAGS = new Set(["sniper"]);
const BUNDLER_TAGS = new Set(["bundler", "rat_trader"]);
const INSIDER_TAGS = new Set(["insider", "dev_team", "creator", "dev"]);

type RawHolder = {
  address?: string;
  addr_type?: number;       // 2 = pool / exchange account — exclude from supply math
  exchange?: string | null;
  amount_percentage?: number | null; // 0-1 share of supply
  tags?: string[];
  maker_token_tags?: string[];
  wallet_tag_v2?: string;
};

function holderLabels(h: RawHolder): string[] {
  return [...(h.tags ?? []), ...(h.maker_token_tags ?? [])].map((t) => String(t).toLowerCase());
}

function isPoolAccount(h: RawHolder): boolean {
  return h.addr_type === 2 || Boolean(h.exchange);
}

function computeHoldShares(list: RawHolder[]): {
  top10Pct: number | null;
  smartHoldPct: number;
  kolHoldPct: number;
  sniperHoldPct: number;
  bundlerHoldPct: number;
  insiderHoldPct: number;
} {
  const wallets = list.filter((h) => !isPoolAccount(h));
  const pct = (h: RawHolder) => {
    const p = Number(h.amount_percentage);
    return Number.isFinite(p) && p > 0 ? p * 100 : 0;
  };

  const top10 = wallets.slice(0, 10).reduce((acc, h) => acc + pct(h), 0);

  let smart = 0;
  let kol = 0;
  let sniper = 0;
  let bundler = 0;
  let insider = 0;
  for (const h of wallets) {
    const labels = holderLabels(h);
    const share = pct(h);
    if (!share) continue;
    if (labels.some((l) => SMART_TAGS.has(l))) smart += share;
    if (labels.some((l) => KOL_TAGS.has(l))) kol += share;
    if (labels.some((l) => SNIPER_TAGS.has(l))) sniper += share;
    if (labels.some((l) => BUNDLER_TAGS.has(l))) bundler += share;
    if (labels.some((l) => INSIDER_TAGS.has(l))) insider += share;
  }

  return {
    top10Pct: wallets.length >= 3 ? Math.min(100, top10) : null,
    smartHoldPct: Math.min(100, smart),
    kolHoldPct: Math.min(100, kol),
    sniperHoldPct: Math.min(100, sniper),
    bundlerHoldPct: Math.min(100, bundler),
    insiderHoldPct: Math.min(100, insider),
  };
}

const numOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchIntel(address: string, chain: string): Promise<GemIntel | null> {
  const c = chain === "solana" ? "sol" : chain;
  const proxy = nextProxy();

  const [infoRes, statRes, holdersRes] = await Promise.all([
    gmgnFetch(`https://gmgn.ai/api/v1/token_info/${c}/${address}`, proxy),
    gmgnFetch(`https://gmgn.ai/vas/api/v1/token_holder_stat/${c}/${address}`, proxy),
    gmgnFetch(
      `https://gmgn.ai/vas/api/v1/token_holders/${c}/${address}?limit=20&offset=0&orderby=amount_percentage&direction=desc`,
      proxy,
    ),
  ]);

  const info = ((infoRes.data as { data?: Record<string, unknown> })?.data ?? {}) as Record<string, unknown>;
  const stat = ((statRes.data as { data?: Record<string, unknown> })?.data ?? {}) as Record<string, unknown>;
  const holdersData = (holdersRes.data as { data?: { list?: RawHolder[] } })?.data;
  const list = Array.isArray(holdersData?.list) ? holdersData.list : [];

  if (!infoRes.ok && !statRes.ok && !list.length) return null;

  const shares = list.length
    ? computeHoldShares(list)
    : {
      top10Pct: null, smartHoldPct: 0, kolHoldPct: 0,
      sniperHoldPct: 0, bundlerHoldPct: 0, insiderHoldPct: 0,
    };

  // Fallback top10 from stat when top-holder list unavailable (rate 0-1)
  let top10 = shares.top10Pct;
  if (top10 == null) {
    const rate = numOrNull(stat.top10_holder_rate);
    if (rate != null && rate > 0) top10 = rate > 1 ? rate : rate * 100;
  }

  return {
    holderCount: numOrNull(info.holder_count),
    liqUsd: numOrNull(info.liquidity),
    smartCount: numOrNull(stat.smart_degen_count),
    kolCount: numOrNull(stat.renowned_count),
    sniperCount: numOrNull(stat.sniper_count),
    bundlerCount: numOrNull(stat.bundler_count),
    insiderCount: numOrNull(stat.insider_count),
    top10Pct: top10,
    smartHoldPct: list.length ? shares.smartHoldPct : null,
    kolHoldPct: list.length ? shares.kolHoldPct : null,
    sniperHoldPct: list.length ? shares.sniperHoldPct : null,
    bundlerHoldPct: list.length ? shares.bundlerHoldPct : null,
    insiderHoldPct: list.length ? shares.insiderHoldPct : null,
    fetchedAtMs: Date.now(),
  };
}

async function persistIntel(tokenId: number, intel: GemIntel): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE tracked_tokens SET
        holder_count = COALESCE(${intel.holderCount}, holder_count),
        holder_top10_pct = COALESCE(${intel.top10Pct}, holder_top10_pct),
        holder_smart_count = COALESCE(${intel.smartCount}, holder_smart_count),
        holder_kol_count = COALESCE(${intel.kolCount}, holder_kol_count),
        holder_sniper_count = COALESCE(${intel.sniperCount}, holder_sniper_count),
        holder_bundler_count = COALESCE(${intel.bundlerCount}, holder_bundler_count),
        liquidity_usd = CASE
          WHEN ${intel.liqUsd}::real > 0
            AND COALESCE(NULLIF(liquidity_usd, '')::real, 0) <= 0
          THEN ${intel.liqUsd}::text
          ELSE liquidity_usd
        END,
        last_holders_updated_at = NOW(),
        holder_momentum_updated_at = NOW()
      WHERE id = ${tokenId}
    `);
  } catch (err) {
    log.warn({ err, tokenId }, "gem intel persist failed");
  }
}

/**
 * Get live intel for a token — cached, rate-limited, never throws.
 * `hot` = young/active tokens get the short TTL.
 */
export async function getGemIntel(
  tokenId: number,
  address: string,
  chain: string,
  hot: boolean,
): Promise<GemIntel | null> {
  const cached = cache.get(tokenId);
  const ttl = hot ? HOT_TTL_MS : COLD_TTL_MS;
  if (cached && Date.now() - cached.fetchedAtMs < ttl) return cached;

  const pending = inFlight.get(tokenId);
  if (pending) return pending;

  if (!takeBucketToken()) return cached ?? null; // budget spent — use stale or nothing

  const job = (async () => {
    try {
      const intel = await fetchIntel(address, chain);
      if (intel) {
        cache.set(tokenId, intel);
        void persistIntel(tokenId, intel);
        // Keep the cache bounded
        if (cache.size > 500) {
          const oldest = [...cache.entries()]
            .sort((a, b) => a[1].fetchedAtMs - b[1].fetchedAtMs)
            .slice(0, 100);
          for (const [k] of oldest) cache.delete(k);
        }
      }
      return intel ?? cached ?? null;
    } catch (err) {
      log.debug({ err, tokenId }, "gem intel fetch failed");
      return cached ?? null;
    } finally {
      inFlight.delete(tokenId);
    }
  })();
  inFlight.set(tokenId, job);
  return job;
}
