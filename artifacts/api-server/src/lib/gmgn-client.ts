/**
 * GMGN client — shared fetch + persist logic
 *
 * Uses curl --http2 with browser headers to bypass Cloudflare TLS fingerprinting.
 * Supports an optional proxy pool via GMGN_PROXIES env var (comma-separated).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "@workspace/db";
import { token_holders, wallet_profiles } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger as rootLogger } from "./logger";

const log = rootLogger.child({ module: "gmgn-client" });

export const execFileAsync = promisify(execFile);

// ── Chain name normalisation ──────────────────────────────────────────────────

export const CHAIN_MAP: Record<string, string> = {
  sol: "sol", solana: "sol",
  eth: "eth", ethereum: "eth",
  bsc: "bsc", base: "base",
  polygon: "polygon", matic: "polygon",
  arbitrum: "arb", arb: "arb",
};

// ── Browser-like headers ──────────────────────────────────────────────────────

const GMGN_HEADERS: Record<string, string> = {
  "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept":           "application/json, text/plain, */*",
  "Accept-Language":  "en-US,en;q=0.9",
  "Accept-Encoding":  "gzip, deflate, br",
  "Referer":          "https://gmgn.ai/",
  "Origin":           "https://gmgn.ai",
  "sec-ch-ua":        '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="8"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest":   "empty",
  "sec-fetch-mode":   "cors",
  "sec-fetch-site":   "same-origin",
  "Cache-Control":    "no-cache",
  "Pragma":           "no-cache",
};

// ── Proxy pool ────────────────────────────────────────────────────────────────
// Set GMGN_PROXIES to a comma-separated list of proxy URLs, e.g.:
//   GMGN_PROXIES="http://user:pass@host1:port,socks5://host2:port"
// Supports http, https, socks5 (whatever curl's --proxy accepts).
// If unset all requests go direct (backward-compatible).

const PROXY_POOL: string[] = (process.env.GMGN_PROXIES ?? "")
  .split(",")
  .map(p => p.trim())
  .filter(Boolean);

let proxyCursor = 0;

/** Round-robin pick from pool; returns undefined when no pool is configured. */
export function nextProxy(): string | undefined {
  if (PROXY_POOL.length === 0) return undefined;
  const proxy = PROXY_POOL[proxyCursor % PROXY_POOL.length];
  proxyCursor++;
  return proxy;
}

const CURL_BROWSER_ARGS = [
  "--http2", "--compressed", "--silent", "--tlsv1.3",
  "--max-time", "15",
  ...Object.entries(GMGN_HEADERS).flatMap(([k, v]) => ["-H", `${k}: ${v}`]),
  "-w", "\n__GMGN_HTTP_STATUS__%{http_code}",
];

// ── Fetch helpers ─────────────────────────────────────────────────────────────

export interface GmgnResult { ok: boolean; status: number; data: unknown }

/** Single attempt through a specific proxy (or direct if proxy is undefined). */
export async function gmgnFetchOnce(url: string, proxy?: string): Promise<GmgnResult> {
  const args = proxy
    ? [...CURL_BROWSER_ARGS, "--proxy", proxy, url]
    : [...CURL_BROWSER_ARGS, url];
  try {
    const { stdout } = await execFileAsync("curl", args, {
      timeout: 20_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const sepIdx = stdout.lastIndexOf("\n__GMGN_HTTP_STATUS__");
    const status = sepIdx !== -1 ? parseInt(stdout.slice(sepIdx + 21), 10) : 0;
    const body   = sepIdx !== -1 ? stdout.slice(0, sepIdx) : stdout;
    if (!body || body.trimStart().startsWith("<")) {
      return { ok: false, status, data: { error: "cloudflare_blocked", status } };
    }
    const json = JSON.parse(body);
    return { ok: status >= 200 && status < 300, status, data: json };
  } catch (e: unknown) {
    return { ok: false, status: 0, data: { error: String(e) } };
  }
}

/**
 * Fetch with proxy rotation.  Pass `stickyProxy` to pin all calls in a
 * single request to the same exit IP (avoids Cloudflare multi-IP signals).
 * Retries up to maxAttempts times rotating through the pool on block/error.
 * With no pool configured, retries up to 3 times on 429 with exponential
 * backoff (2 s → 4 s → 8 s) before giving up.
 */
export async function gmgnFetch(
  url: string,
  stickyProxy?: string,
): Promise<GmgnResult> {
  // With a proxy pool rotate proxies; without one, allow up to 3 attempts
  // only when we're being rate-limited (429), with exponential back-off.
  const maxAttempts = PROXY_POOL.length > 0 ? Math.min(3, PROXY_POOL.length) : 3;
  let last: GmgnResult | undefined;
  for (let i = 0; i < maxAttempts; i++) {
    const proxy = i === 0 ? stickyProxy : nextProxy();
    last = await gmgnFetchOnce(url, proxy);
    if (last.ok) return last;
    if (last.status === 429) {
      // Exponential back-off: 2 s, 4 s, 8 s
      const delay = Math.min(2_000 * Math.pow(2, i), 8_000);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    // Non-429 failure without a proxy pool — no point retrying
    if (PROXY_POOL.length === 0) break;
  }
  return last!;
}

// ── Holder persistence ────────────────────────────────────────────────────────

type RawHolder = {
  account_address?: string; address?: string;
  twitter_name?: string | null; twitter_username?: string | null;
  tags?: string[]; maker_token_tags?: string[];
  amount_percentage?: number | null; balance?: number | null;
  cost_usd?: number | null; realized_profit?: number | null;
  unrealized_profit?: number | null;
  buy_tx_count_cur?: number | null; buy_count?: number | null;
  sell_tx_count_cur?: number | null; sell_count?: number | null;
};

type HolderRow = {
  tokenId: number; walletAddress: string;
  twitterName: string | null; twitterUsername: string | null;
  labels: string[]; amountPercentage: number | null;
  balance: string | null; costUsd: string | null;
  realizedProfit: string | null; unrealizedProfit: string | null;
  buyCount: number; sellCount: number;
  snapshotMarketCapUsd: string | null;
  fetchedAt: Date;
};

/**
 * Upsert a raw GMGN holder list into token_holders.
 *
 * IMPORTANT — address fields from GMGN /vas/api/v1/token_holders:
 *   address         = the actual SOL wallet (owner of the token account) — use this
 *   account_address = the Associated Token Account (ATA) — NOT a wallet, never use as primary
 *
 * Label strategy: MERGE (union) labels on conflict so wallet labels accumulate
 * across snapshots. A wallet that had "smart_degen" in an earlier snapshot keeps
 * that label even if the next snapshot doesn't include that wallet.
 *
 * snapshotMarketCapUsd captures the token's market cap at the time of this snapshot.
 * Returns row count stored.
 */
export async function persistHolders(
  tokenId: number,
  holderList: unknown[],
  snapshotMarketCapUsd?: string | null,
  tokenLabel?: string,   // optional: "NAME (SYMBOL)" for log context
): Promise<number> {
  if (holderList.length === 0) return 0;

  let skippedNoWallet = 0;

  const rows: HolderRow[] = (holderList as RawHolder[])
    .map(h => {
      // `address` is the wallet owner; `account_address` is the ATA.
      // Fall back to account_address only when address is absent (older API variants).
      // Use only `address` (the wallet owner). `account_address` is the ATA —
      // storing it as a wallet address creates phantom duplicate entries when
      // the real wallet address later arrives in a subsequent snapshot.
      const walletAddress = h.address?.trim() ?? "";
      if (!walletAddress) {
        skippedNoWallet++;
        return null;
      }
      const rawLabels = [...(h.tags ?? []), ...(h.maker_token_tags ?? [])];
      const labels = [...new Set(rawLabels.filter(Boolean))];
      return {
        tokenId,
        walletAddress,
        twitterName:          h.twitter_name      ?? null,
        twitterUsername:      h.twitter_username  ?? null,
        labels,
        amountPercentage:     h.amount_percentage ?? null,
        balance:              h.balance      != null ? String(h.balance)           : null,
        costUsd:              h.cost_usd     != null ? String(h.cost_usd)          : null,
        realizedProfit:       h.realized_profit   != null ? String(h.realized_profit) : null,
        unrealizedProfit:     h.unrealized_profit != null ? String(h.unrealized_profit) : null,
        buyCount:             h.buy_tx_count_cur  ?? h.buy_count  ?? 0,
        sellCount:            h.sell_tx_count_cur ?? h.sell_count ?? 0,
        snapshotMarketCapUsd: snapshotMarketCapUsd ?? null,
        fetchedAt:            new Date(),
      } satisfies HolderRow;
    })
    .filter((x): x is HolderRow => x !== null);

  if (rows.length === 0) {
    log.warn({ tokenId, tokenLabel, rawCount: holderList.length, skippedNoWallet },
      "Holders snapshot: all records skipped (missing wallet address)");
    return 0;
  }

  // Deduplicate within the batch by (tokenId, walletAddress).
  // GMGN occasionally returns the same wallet twice in one response; PostgreSQL's
  // ON CONFLICT DO UPDATE rejects batches that try to update the same row twice.
  // Keep the last occurrence so labels from both entries are unioned below.
  const dedupMap = new Map<string, HolderRow>();
  for (const row of rows) {
    const key = `${row.tokenId}::${row.walletAddress}`;
    const existing = dedupMap.get(key);
    if (existing) {
      // Union labels from both occurrences
      existing.labels = [...new Set([...existing.labels, ...row.labels])];
    } else {
      dedupMap.set(key, row);
    }
  }
  const dedupedRows = Array.from(dedupMap.values());

  // Upsert: merge (union) labels so historical labels accumulate; refresh all
  // position/trade fields with the latest values from GMGN.
  await db.insert(token_holders).values(dedupedRows)
    .onConflictDoUpdate({
      target: [token_holders.tokenId, token_holders.walletAddress],
      set: {
        // Merge labels: union existing + incoming, deduplicated
        labels:               sql`ARRAY(SELECT DISTINCT unnest(token_holders.labels || excluded.labels))`,
        amountPercentage:     sql`excluded.amount_percentage`,
        balance:              sql`excluded.balance`,
        costUsd:              sql`excluded.cost_usd`,
        realizedProfit:       sql`excluded.realized_profit`,
        unrealizedProfit:     sql`excluded.unrealized_profit`,
        buyCount:             sql`excluded.buy_count`,
        sellCount:            sql`excluded.sell_count`,
        twitterName:          sql`excluded.twitter_name`,
        twitterUsername:      sql`excluded.twitter_username`,
        snapshotMarketCapUsd: sql`excluded.snapshot_market_cap_usd`,
        fetchedAt:            sql`excluded.fetched_at`,
      },
    });

  // ── Sync wallet identity to wallet_profiles (deduplicates across tokens) ──
  // Labels and twitter handles are merged so a wallet known as "smart_degen"
  // from one token retains that label regardless of which token you look it up from.
  // Use dedupedRows (not the original rows) so wallet_profiles also has no duplicates.
  const profileRows = dedupedRows.map(r => ({
    walletAddress:  r.walletAddress,
    labels:         r.labels,
    twitterName:    r.twitterName,
    twitterUsername: r.twitterUsername,
    lastSeenAt:     r.fetchedAt,
  }));
  if (profileRows.length > 0) {
    await db.insert(wallet_profiles).values(profileRows)
      .onConflictDoUpdate({
        target: wallet_profiles.walletAddress,
        set: {
          labels:          sql`ARRAY(SELECT DISTINCT unnest(wallet_profiles.labels || excluded.labels))`,
          twitterName:     sql`COALESCE(NULLIF(excluded.twitter_name, ''), wallet_profiles.twitter_name)`,
          twitterUsername: sql`COALESCE(NULLIF(excluded.twitter_username, ''), wallet_profiles.twitter_username)`,
          lastSeenAt:      sql`excluded.last_seen_at`,
        },
      });
  }

  const mcLabel = snapshotMarketCapUsd
    ? `$${(parseFloat(snapshotMarketCapUsd) / 1000).toFixed(1)}K`
    : "unknown";
  log.info(
    { tokenId, tokenLabel, upserted: rows.length, skippedNoWallet, mcAtSnapshot: mcLabel },
    "Holders snapshot upserted",
  );

  return rows.length;
}

// ── Token security fetch ──────────────────────────────────────────────────────

export interface GmgnSecurityData {
  isHoneypot:          boolean | null;
  ownerRenounced:      boolean | null;
  mintRenounced:       boolean | null;   // SOL: mint authority renounced
  freezeRenounced:     boolean | null;   // SOL: freeze authority renounced
  openSource:          boolean | null;
  top10HolderRate:     number | null;
  rugRatio:            number | null;
  sniperCount:         number | null;
  creatorAddress:      string | null;
  creatorClose:        boolean | null;
  creatorTokenStatus:  string | null;    // "creator_close" | "creator_hold"
  buyTax:              number | null;
  sellTax:             number | null;
  lpLocked:            boolean | null;
  lpLockPercent:       number | null;
  ctoFlag:             boolean | null;
  bluechipOwnerPct:    number | null;
  ratTraderAmtRate:    number | null;
  creatorCreatedCount: number | null;
}

// RugCheck report shape (partial — only the fields we use)
interface RugCheckReport {
  mint?:          string;
  creator?:       string;
  creatorBalance?: number;
  token?: {
    mintAuthority:   string | null;
    freezeAuthority: string | null;
  };
  tokenMeta?: {
    updateAuthority: string;
    mutable:         boolean;
  };
  topHolders?: Array<{ pct: number }>;
  risks?:          Array<{ name: string; level: string; score: number }>;
  score_normalised?: number;
  lpLockedPct?:    number;
}

const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";
// The "null authority" address on Solana — signals renounced mint/freeze/update
const NULL_AUTHORITY = "11111111111111111111111111111111";

/**
 * Fetch token security data.
 *
 * Primary source: RugCheck API (api.rugcheck.xyz) — returns on-chain
 * authority state, top-holder concentration, LP lock %, risk score, and
 * creator address.  No API key required; no Cloudflare, so native fetch works.
 *
 * Supplementary: GMGN /vas/api/v1/token_holder_stat — returns sniper_count
 * and other wallet-category counts that RugCheck doesn't provide.
 *
 * The old GMGN /api/v1/token_security endpoint was retired (returns 404).
 */
export async function fetchTokenSecurity(
  chain: string,
  address: string,
  proxy?: string,
): Promise<{ ok: boolean; security: GmgnSecurityData; raw: unknown }> {
  const c = CHAIN_MAP[chain.toLowerCase()] ?? "sol";

  // ── RugCheck (primary — Solana only; skip for EVM chains) ────────────────
  let rugReport: RugCheckReport | null = null;
  let rugOk = false;
  if (c === "sol") {
    try {
      const res = await fetch(`${RUGCHECK_BASE}/tokens/${address}/report`, {
        signal: AbortSignal.timeout(12_000),
        headers: { "Accept": "application/json" },
      });
      if (res.ok) {
        rugReport = await res.json() as RugCheckReport;
        rugOk = true;
      }
    } catch {
      // non-fatal — fall through with null rugReport
    }
  }

  // ── GMGN holder stat (supplementary — sniper_count etc.) ─────────────────
  const statRes = await gmgnFetch(
    `https://gmgn.ai/vas/api/v1/token_holder_stat/${c}/${address}`,
    proxy,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stat = (statRes.data as any)?.data ?? {};

  // ── Build security object ─────────────────────────────────────────────────
  const top10Rate = rugReport?.topHolders?.length
    ? rugReport.topHolders.slice(0, 10).reduce((s, h) => s + (h.pct ?? 0), 0) / 100
    : null;

  const rugScore  = rugReport?.score_normalised ?? null;
  // risks is an array; presence of a "Honeypot" risk indicates honeypot
  const honeypot  = rugReport?.risks
    ? rugReport.risks.some(r => r.name?.toLowerCase().includes("honeypot"))
    : null;

  const creatorAddress = rugReport?.creator ?? null;
  const creatorClose   = rugReport != null
    ? (rugReport.creatorBalance ?? 1) === 0
    : null;

  const security: GmgnSecurityData = {
    isHoneypot:          rugOk ? honeypot : null,
    ownerRenounced:      rugReport?.tokenMeta
                           ? rugReport.tokenMeta.updateAuthority === NULL_AUTHORITY
                           : null,
    mintRenounced:       rugReport?.token
                           ? rugReport.token.mintAuthority === null
                           : null,
    freezeRenounced:     rugReport?.token
                           ? rugReport.token.freezeAuthority === null
                           : null,
    openSource:          null,   // not available from RugCheck
    top10HolderRate:     top10Rate,
    rugRatio:            rugScore != null ? rugScore / 10 : null,
    sniperCount:         stat?.sniper_count ?? null,
    creatorAddress,
    creatorClose,
    creatorTokenStatus:  creatorClose === true  ? "creator_close"
                       : creatorClose === false ? "creator_hold"
                       : null,
    buyTax:              null,
    sellTax:             null,
    lpLocked:            rugReport != null ? (rugReport.lpLockedPct ?? 0) > 0 : null,
    lpLockPercent:       rugReport?.lpLockedPct ?? null,
    ctoFlag:             null,
    bluechipOwnerPct:    null,
    ratTraderAmtRate:    null,
    creatorCreatedCount: null,
  };

  return {
    ok: rugOk || statRes.ok,
    security,
    raw: { rugcheck: rugReport, holderStat: statRes.data },
  };
}

// ── Token pool fetch ──────────────────────────────────────────────────────────

export async function fetchTokenPool(
  chain: string,
  address: string,
  proxy?: string,
): Promise<GmgnResult> {
  const c = CHAIN_MAP[chain.toLowerCase()] ?? "sol";
  return gmgnFetch(`https://gmgn.ai/api/v1/token_pool/${c}/${address}`, proxy);
}

// ── Top traders fetch + persist ───────────────────────────────────────────────

type RawTrader = {
  address?: string;
  wallet_address?: string;
  twitter_name?: string | null;
  twitter_username?: string | null;
  tags?: string[];
  maker_token_tags?: string[];
  // P&L
  profit?: number | null;
  profit_usd?: number | null;
  realized_profit?: number | null;
  unrealized_profit?: number | null;
  // Volume
  buy_volume_cur?: number | null;
  sell_volume_cur?: number | null;
  // Trade counts
  buy_tx_count_cur?: number | null;
  sell_tx_count_cur?: number | null;
  // Avg price
  avg_buy?: number | null;
  avg_sell?: number | null;
  avg_buy_price?: number | null;
  avg_sell_price?: number | null;
  // Position
  amount_percentage?: number | null;
};

export async function fetchTopTraders(
  chain: string,
  address: string,
  proxy?: string,
  limit = 40,
): Promise<GmgnResult> {
  const c = CHAIN_MAP[chain.toLowerCase()] ?? "sol";
  const url = `https://gmgn.ai/defi/quotation/v1/tokens/top_traders/${c}/${address}?orderby=profit&direction=desc&limit=${limit}`;
  return gmgnFetch(url, proxy);
}

export async function persistTraders(
  tokenId: number,
  traderList: unknown[],
  tokenLabel?: string,
): Promise<number> {
  if (traderList.length === 0) return 0;

  // Lazy import to avoid circular dep at module load
  const { db } = await import("@workspace/db");
  const { token_traders, wallet_profiles } = await import("@workspace/db");
  const { sql: drizzleSql } = await import("drizzle-orm");

  const rows = (traderList as RawTrader[]).map(t => {
    const walletAddress = (t.address ?? t.wallet_address ?? "").trim();
    if (!walletAddress) return null;
    const rawLabels = [...(t.tags ?? []), ...(t.maker_token_tags ?? [])];
    const labels    = [...new Set(rawLabels.filter(Boolean))];
    const buyVol    = t.buy_volume_cur  ?? null;
    const sellVol   = t.sell_volume_cur ?? null;
    return {
      tokenId,
      walletAddress,
      twitterName:     t.twitter_name     ?? null,
      twitterUsername: t.twitter_username ?? null,
      labels,
      profit:            t.profit           ?? null,
      profitUsd:         t.profit_usd       ?? null,
      realizedProfit:    t.realized_profit  ?? null,
      unrealizedProfit:  t.unrealized_profit ?? null,
      buyVolumeUsd:      buyVol,
      sellVolumeUsd:     sellVol,
      netFlowUsd:        buyVol != null && sellVol != null ? buyVol - sellVol : null,
      buyCount:          t.buy_tx_count_cur  ?? 0,
      sellCount:         t.sell_tx_count_cur ?? 0,
      avgBuyPriceUsd:    t.avg_buy_price  ?? t.avg_buy  ?? null,
      avgSellPriceUsd:   t.avg_sell_price ?? t.avg_sell ?? null,
      holdingPct:        t.amount_percentage ?? null,
      fetchedAt:         new Date(),
    };
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  if (rows.length === 0) return 0;

  await db.insert(token_traders).values(rows).onConflictDoUpdate({
    target: [token_traders.tokenId, token_traders.walletAddress],
    set: {
      labels:           drizzleSql`ARRAY(SELECT DISTINCT unnest(token_traders.labels || excluded.labels))`,
      profit:           drizzleSql`excluded.profit`,
      profitUsd:        drizzleSql`excluded.profit_usd`,
      realizedProfit:   drizzleSql`excluded.realized_profit`,
      unrealizedProfit: drizzleSql`excluded.unrealized_profit`,
      buyVolumeUsd:     drizzleSql`excluded.buy_volume_usd`,
      sellVolumeUsd:    drizzleSql`excluded.sell_volume_usd`,
      netFlowUsd:       drizzleSql`excluded.net_flow_usd`,
      buyCount:         drizzleSql`excluded.buy_count`,
      sellCount:        drizzleSql`excluded.sell_count`,
      avgBuyPriceUsd:   drizzleSql`excluded.avg_buy_price_usd`,
      avgSellPriceUsd:  drizzleSql`excluded.avg_sell_price_usd`,
      holdingPct:       drizzleSql`excluded.holding_pct`,
      twitterName:      drizzleSql`COALESCE(NULLIF(excluded.twitter_name, ''), token_traders.twitter_name)`,
      twitterUsername:  drizzleSql`COALESCE(NULLIF(excluded.twitter_username, ''), token_traders.twitter_username)`,
      fetchedAt:        drizzleSql`excluded.fetched_at`,
    },
  });

  // Sync trader identities to wallet_profiles
  const profileRows = rows.map(r => ({
    walletAddress:  r.walletAddress,
    labels:         r.labels,
    twitterName:    r.twitterName,
    twitterUsername: r.twitterUsername,
    lastSeenAt:     r.fetchedAt,
  }));
  await db.insert(wallet_profiles).values(profileRows).onConflictDoUpdate({
    target: wallet_profiles.walletAddress,
    set: {
      labels:          drizzleSql`ARRAY(SELECT DISTINCT unnest(wallet_profiles.labels || excluded.labels))`,
      twitterName:     drizzleSql`COALESCE(NULLIF(excluded.twitter_name, ''), wallet_profiles.twitter_name)`,
      twitterUsername: drizzleSql`COALESCE(NULLIF(excluded.twitter_username, ''), wallet_profiles.twitter_username)`,
      lastSeenAt:      drizzleSql`excluded.last_seen_at`,
    },
  });

  log.info({ tokenId, tokenLabel, count: rows.length }, "Traders persisted");
  return rows.length;
}

// ── Wallet profile fetch ──────────────────────────────────────────────────────

export async function fetchWalletProfile(
  chain: string,
  walletAddress: string,
  proxy?: string,
): Promise<GmgnResult> {
  const c = CHAIN_MAP[chain.toLowerCase()] ?? "sol";
  return gmgnFetch(`https://gmgn.ai/api/v1/wallet_info/${c}/${walletAddress}`, proxy);
}

export async function fetchWalletHoldings(
  chain: string,
  walletAddress: string,
  proxy?: string,
  limit = 50,
): Promise<GmgnResult> {
  const c = CHAIN_MAP[chain.toLowerCase()] ?? "sol";
  return gmgnFetch(
    `https://gmgn.ai/api/v1/wallet_holdings/${c}/${walletAddress}?limit=${limit}&orderby=unrealized_profit&direction=desc`,
    proxy,
  );
}

// ── Paginated fetch + persist ─────────────────────────────────────────────────
// GMGN hard-caps each page at 20 holders regardless of the `limit` param.
// We walk pages with offset=0,20,40,… until an empty page or MAX_PAGES.
// All pages are persisted incrementally so labels from every page accumulate.

const GMGN_PAGE_SIZE = 20;
const GMGN_MAX_PAGES = 15; // up to 300 holders per token

/**
 * Fetch all holder pages for a token from GMGN and persist them.
 * Single source of truth — call this everywhere instead of rolling your own.
 * Returns total rows upserted across all pages.
 */
export async function fetchAndPersistHolders(token: {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  marketCapUsd?: string | null;
}): Promise<number> {
  const chain  = CHAIN_MAP[token.chain.toLowerCase()] ?? "sol";
  const label  = [token.name, token.symbol].filter(Boolean).join(" / ") || token.address.slice(0, 8);
  const proxy  = nextProxy();
  let totalUpserted = 0;

  for (let page = 0; page < GMGN_MAX_PAGES; page++) {
    const offset = page * GMGN_PAGE_SIZE;
    const url    = `https://gmgn.ai/vas/api/v1/token_holders/${chain}/${token.address}?limit=${GMGN_PAGE_SIZE}&offset=${offset}`;
    const res    = await gmgnFetch(url, proxy);
    const list: unknown[] = (res.data as { data?: { data?: { list?: unknown[] } } })?.data?.data?.list
                         ?? (res.data as { data?: { list?: unknown[] } })?.data?.list
                         ?? [];

    if (list.length === 0) break;

    totalUpserted += await persistHolders(token.id, list, token.marketCapUsd, label);

    if (list.length < GMGN_PAGE_SIZE) break; // last page, no need to request more
  }

  log.info({ tokenId: token.id, tokenLabel: label, totalUpserted }, "Holders full fetch complete");
  return totalUpserted;
}
