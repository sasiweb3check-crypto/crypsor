/**
 * Live GMGN KOL / smart verify for Pro Caller qualify.
 *
 * Uses curl HTTP2 + browser headers (gmgnFetch) — no API key required.
 * SSOT counts prefer token_wallet_tags_stat (GMGN skills); fall back to
 * token_holder_stat. Wallet lists come from tagged token_holders pages
 * (tag=renowned / tag=smart_degen). Untagged top-N is NOT used for counts.
 */

import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq } from "drizzle-orm";
import { gmgnFetch, nextProxy, CHAIN_MAP } from "./gmgn-client";
import { logger } from "./logger";

const log = logger.child({ module: "gmgn-pro-verify" });

export type VerifiedWallet = {
  address: string;
  twitterName: string | null;
  twitterUsername: string | null;
  labels: string[];
  amountPercentage: number | null;
  balance: string | null;
  holding: boolean;
  realizedProfit: number | null;
};

export type GmgnProVerifyResult = {
  ok: boolean;
  /** Authoritative KOL count for Pro freeze (renowned). */
  kolCount: number;
  /** Authoritative smart count for Pro freeze. */
  smartCount: number;
  holderStatKol: number;
  holderStatSmart: number;
  tagsKol: number;
  tagsSmart: number;
  holderCount: number | null;
  liquidityUsd: number | null;
  wallets: { kol: VerifiedWallet[]; smart: VerifiedWallet[] };
  source: "gmgn_live" | "failed";
  fetchedAt: Date;
};

type RawHolder = {
  address?: string;
  account_address?: string;
  twitter_name?: string | null;
  twitter_username?: string | null;
  tags?: string[];
  maker_token_tags?: string[];
  amount_percentage?: number | null;
  balance?: number | string | null;
  realized_profit?: number | null;
};

function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function mapHolders(list: unknown[]): VerifiedWallet[] {
  const out: VerifiedWallet[] = [];
  const seen = new Set<string>();
  for (const raw of list as RawHolder[]) {
    const address = (raw.address ?? "").trim();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const labels = [...new Set([...(raw.tags ?? []), ...(raw.maker_token_tags ?? [])].filter(Boolean))];
    const bal = num(raw.balance);
    const pct = raw.amount_percentage != null ? num(raw.amount_percentage) : null;
    out.push({
      address,
      twitterName: raw.twitter_name ?? null,
      twitterUsername: raw.twitter_username ?? null,
      labels,
      amountPercentage: pct,
      balance: raw.balance != null ? String(raw.balance) : null,
      holding: bal > 0 || (pct != null && pct > 0),
      realizedProfit: raw.realized_profit != null ? num(raw.realized_profit) : null,
    });
  }
  return out;
}

function unwrapList(data: unknown): unknown[] {
  const root = data as { data?: { data?: { list?: unknown[] }; list?: unknown[] } };
  return root?.data?.data?.list ?? root?.data?.list ?? [];
}

function unwrapData(data: unknown): Record<string, unknown> {
  const root = data as { data?: Record<string, unknown> };
  return (root?.data && typeof root.data === "object" ? root.data : {}) as Record<string, unknown>;
}

/**
 * Live-fetch GMGN KOL + smart for a token. Sticky proxy for the whole burst.
 */
export async function verifyTokenKolSmart(
  chain: string,
  address: string,
): Promise<GmgnProVerifyResult> {
  const c = CHAIN_MAP[chain.toLowerCase()] ?? "sol";
  const proxy = nextProxy();
  const fetchedAt = new Date();

  const empty: GmgnProVerifyResult = {
    ok: false,
    kolCount: 0,
    smartCount: 0,
    holderStatKol: 0,
    holderStatSmart: 0,
    tagsKol: 0,
    tagsSmart: 0,
    holderCount: null,
    liquidityUsd: null,
    wallets: { kol: [], smart: [] },
    source: "failed",
    fetchedAt,
  };

  try {
    const [statRes, tagsRes, infoRes, kolRes, smartRes] = await Promise.all([
      gmgnFetch(`https://gmgn.ai/vas/api/v1/token_holder_stat/${c}/${address}`, proxy),
      gmgnFetch(`https://gmgn.ai/api/v1/token_wallet_tags_stat/${c}/${address}`, proxy),
      gmgnFetch(`https://gmgn.ai/api/v1/token_info/${c}/${address}`, proxy),
      gmgnFetch(
        `https://gmgn.ai/vas/api/v1/token_holders/${c}/${address}?limit=20&offset=0&tag=renowned`,
        proxy,
      ),
      gmgnFetch(
        `https://gmgn.ai/vas/api/v1/token_holders/${c}/${address}?limit=20&offset=0&tag=smart_degen`,
        proxy,
      ),
    ]);

    const anyOk = statRes.ok || tagsRes.ok || kolRes.ok || smartRes.ok || infoRes.ok;
    if (!anyOk) {
      log.warn({ address, chain: c }, "GMGN pro-verify: all endpoints failed");
      return empty;
    }

    const stat = unwrapData(statRes.data);
    const tags = unwrapData(tagsRes.data);
    const info = unwrapData(infoRes.data);

    const holderStatKol = Math.round(num(stat.renowned_count));
    const holderStatSmart = Math.round(num(stat.smart_degen_count));
    const tagsKol = Math.round(num(tags.renowned_wallets));
    const tagsSmart = Math.round(num(tags.smart_wallets));

    // Skills SSOT: wallet_tags_stat; fall back to holder_stat when tags endpoint fails.
    const kolCount = tagsRes.ok ? tagsKol : holderStatKol;
    const smartCount = tagsRes.ok ? tagsSmart : holderStatSmart;

    const kolWallets = kolRes.ok ? mapHolders(unwrapList(kolRes.data)) : [];
    const smartWallets = smartRes.ok ? mapHolders(unwrapList(smartRes.data)) : [];

    const liquidityUsd = info.liquidity != null ? num(info.liquidity) : null;
    const holderCount = info.holder_count != null ? Math.round(num(info.holder_count)) : null;

    const result: GmgnProVerifyResult = {
      ok: true,
      kolCount: Math.max(kolCount, 0),
      smartCount: Math.max(smartCount, 0),
      holderStatKol,
      holderStatSmart,
      tagsKol,
      tagsSmart,
      holderCount,
      liquidityUsd: liquidityUsd != null && liquidityUsd > 0 ? liquidityUsd : null,
      wallets: { kol: kolWallets, smart: smartWallets },
      source: "gmgn_live",
      fetchedAt,
    };

    log.info(
      {
        address: address.slice(0, 8),
        kol: result.kolCount,
        smart: result.smartCount,
        holderStat: `${holderStatKol}/${holderStatSmart}`,
        tagsStat: `${tagsKol}/${tagsSmart}`,
        kolWallets: kolWallets.length,
        smartWallets: smartWallets.length,
        holdingKol: kolWallets.filter(w => w.holding).length,
        holdingSmart: smartWallets.filter(w => w.holding).length,
      },
      "GMGN pro-verify ok",
    );

    return result;
  } catch (err) {
    log.warn({ err, address }, "GMGN pro-verify exception");
    return empty;
  }
}

/** Persist verified counts onto tracked_tokens so intel/snapshots stay in sync. */
export async function applyVerifyToTrackedToken(
  tokenId: number,
  verify: GmgnProVerifyResult,
): Promise<void> {
  if (!verify.ok) return;
  await db
    .update(tracked_tokens)
    .set({
      holderKolCount: verify.kolCount,
      holderSmartCount: verify.smartCount,
      ...(verify.holderCount != null ? { holderCount: verify.holderCount } : {}),
      ...(verify.liquidityUsd != null ? { liquidityUsd: String(verify.liquidityUsd) } : {}),
      lastHoldersUpdatedAt: verify.fetchedAt,
    })
    .where(eq(tracked_tokens.id, tokenId));
}

export function walletsPayload(verify: GmgnProVerifyResult): Record<string, unknown> {
  return {
    source: verify.source,
    fetchedAt: verify.fetchedAt.toISOString(),
    holderStat: { kol: verify.holderStatKol, smart: verify.holderStatSmart },
    tagsStat: { kol: verify.tagsKol, smart: verify.tagsSmart },
    kol: verify.wallets.kol.slice(0, 40),
    smart: verify.wallets.smart.slice(0, 40),
  };
}
