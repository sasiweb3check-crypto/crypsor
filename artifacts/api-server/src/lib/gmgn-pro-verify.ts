/**
 * Live GMGN KOL / smart verify for Pro Caller qualify.
 *
 * Uses curl HTTP2 + browser headers (gmgnFetch) — no API key required.
 * SSOT counts prefer token_wallet_tags_stat; fall back to token_holder_stat.
 * Wallet lists from tagged token_holders (renowned / smart_degen) include
 * hold %, sold %, paper/diamond hands — used for conviction scoring + UI.
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
  makerTags: string[];
  amountPercentage: number | null;
  balance: string | null;
  usdValue: number | null;
  holding: boolean;
  soldFully: boolean;
  sellAmountPercentage: number | null;
  buyTxCount: number;
  sellTxCount: number;
  realizedProfit: number | null;
  unrealizedProfit: number | null;
  paperHands: boolean;
  diamondHands: boolean;
  startHoldingAt: number | null;
  endHoldingAt: number | null;
};

export type WalletConviction = {
  total: number;
  holding: number;
  sold: number;
  holdRate: number;
  soldRate: number;
  supplyPctHeld: number;
  usdHeld: number;
  paperHands: number;
  diamondHands: number;
  avgSellPctAmongHolders: number;
};

export type TokenStatSnap = {
  top10HolderRate: number | null;
  bundlerPct: number | null;
  ratPct: number | null;
  botDegenRate: number | null;
  sniperHoldRate: number | null;
  creatorHoldRate: number | null;
  creatorCreatedCount: number | null;
};

export type GmgnProVerifyResult = {
  ok: boolean;
  kolCount: number;
  smartCount: number;
  holderStatKol: number;
  holderStatSmart: number;
  tagsKol: number;
  tagsSmart: number;
  /** Currently-holding counts (prefer these for qualify). */
  holdingKol: number;
  holdingSmart: number;
  kolConviction: WalletConviction;
  smartConviction: WalletConviction;
  tokenStat: TokenStatSnap | null;
  holderCount: number | null;
  liquidityUsd: number | null;
  socials: { twitter?: string; telegram?: string; website?: string };
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
  usd_value?: number | null;
  sell_amount_percentage?: number | null;
  buy_tx_count_cur?: number | null;
  sell_tx_count_cur?: number | null;
  realized_profit?: number | null;
  unrealized_profit?: number | null;
  start_holding_at?: number | null;
  end_holding_at?: number | null;
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
    const makerTags = [...new Set((raw.maker_token_tags ?? []).filter(Boolean))];
    const bal = num(raw.balance);
    const pct = raw.amount_percentage != null ? num(raw.amount_percentage) : null;
    const sellPct = raw.sell_amount_percentage != null ? num(raw.sell_amount_percentage) : null;
    const holding = bal > 0 || (pct != null && pct > 0);
    out.push({
      address,
      twitterName: raw.twitter_name ?? null,
      twitterUsername: raw.twitter_username ?? null,
      labels,
      makerTags,
      amountPercentage: pct,
      balance: raw.balance != null ? String(raw.balance) : null,
      usdValue: raw.usd_value != null ? num(raw.usd_value) : null,
      holding,
      soldFully: !holding,
      sellAmountPercentage: sellPct,
      buyTxCount: Math.round(num(raw.buy_tx_count_cur)),
      sellTxCount: Math.round(num(raw.sell_tx_count_cur)),
      realizedProfit: raw.realized_profit != null ? num(raw.realized_profit) : null,
      unrealizedProfit: raw.unrealized_profit != null ? num(raw.unrealized_profit) : null,
      paperHands: makerTags.includes("paper_hands") || labels.includes("paper_hands"),
      diamondHands: makerTags.includes("diamond_hands") || labels.includes("diamond_hands"),
      startHoldingAt: raw.start_holding_at ?? null,
      endHoldingAt: raw.end_holding_at ?? null,
    });
  }
  return out;
}

export function computeConviction(wallets: VerifiedWallet[]): WalletConviction {
  const total = wallets.length;
  const holdingW = wallets.filter(w => w.holding);
  const sold = wallets.filter(w => w.soldFully);
  const holdRate = total > 0 ? holdingW.length / total : 0;
  const soldRate = total > 0 ? sold.length / total : 0;
  // amount_percentage is fraction of supply (0–1)
  const supplyPctHeld = holdingW.reduce((s, w) => s + (w.amountPercentage ?? 0), 0) * 100;
  const usdHeld = holdingW.reduce((s, w) => s + (w.usdValue ?? 0), 0);
  const paperHands = wallets.filter(w => w.paperHands).length;
  const diamondHands = wallets.filter(w => w.diamondHands).length;
  const avgSellPctAmongHolders = holdingW.length
    ? holdingW.reduce((s, w) => s + (w.sellAmountPercentage ?? 0), 0) / holdingW.length
    : 0;
  return {
    total,
    holding: holdingW.length,
    sold: sold.length,
    holdRate,
    soldRate,
    supplyPctHeld,
    usdHeld,
    paperHands,
    diamondHands,
    avgSellPctAmongHolders,
  };
}

function emptyConviction(): WalletConviction {
  return {
    total: 0, holding: 0, sold: 0, holdRate: 0, soldRate: 0,
    supplyPctHeld: 0, usdHeld: 0, paperHands: 0, diamondHands: 0,
    avgSellPctAmongHolders: 0,
  };
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
 * Live-fetch GMGN KOL + smart + token_stat for a token. Sticky proxy for the burst.
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
    holdingKol: 0,
    holdingSmart: 0,
    kolConviction: emptyConviction(),
    smartConviction: emptyConviction(),
    tokenStat: null,
    holderCount: null,
    liquidityUsd: null,
    socials: {},
    wallets: { kol: [], smart: [] },
    source: "failed",
    fetchedAt,
  };

  try {
    const [statRes, tagsRes, infoRes, kolRes, smartRes, linkRes, tokenStatRes] = await Promise.all([
      gmgnFetch(`https://gmgn.ai/vas/api/v1/token_holder_stat/${c}/${address}`, proxy),
      gmgnFetch(`https://gmgn.ai/api/v1/token_wallet_tags_stat/${c}/${address}`, proxy),
      gmgnFetch(`https://gmgn.ai/api/v1/token_info/${c}/${address}`, proxy),
      gmgnFetch(
        `https://gmgn.ai/vas/api/v1/token_holders/${c}/${address}?limit=40&offset=0&tag=renowned`,
        proxy,
      ),
      gmgnFetch(
        `https://gmgn.ai/vas/api/v1/token_holders/${c}/${address}?limit=40&offset=0&tag=smart_degen`,
        proxy,
      ),
      gmgnFetch(`https://gmgn.ai/api/v1/token_link/${c}/${address}`, proxy),
      gmgnFetch(`https://gmgn.ai/api/v1/token_stat/${c}/${address}`, proxy),
    ]);

    const anyOk = statRes.ok || tagsRes.ok || kolRes.ok || smartRes.ok || infoRes.ok;
    if (!anyOk) {
      log.warn({ address, chain: c }, "GMGN pro-verify: all endpoints failed");
      return empty;
    }

    const stat = unwrapData(statRes.data);
    const tags = unwrapData(tagsRes.data);
    const info = unwrapData(infoRes.data);
    const tstat = tokenStatRes.ok ? unwrapData(tokenStatRes.data) : null;

    const holderStatKol = Math.round(num(stat.renowned_count));
    const holderStatSmart = Math.round(num(stat.smart_degen_count));
    const tagsKol = Math.round(num(tags.renowned_wallets));
    const tagsSmart = Math.round(num(tags.smart_wallets));

    const kolCount = tagsRes.ok ? tagsKol : holderStatKol;
    const smartCount = tagsRes.ok ? tagsSmart : holderStatSmart;

    const kolWallets = kolRes.ok ? mapHolders(unwrapList(kolRes.data)) : [];
    const smartWallets = smartRes.ok ? mapHolders(unwrapList(smartRes.data)) : [];
    const kolConviction = computeConviction(kolWallets);
    const smartConviction = computeConviction(smartWallets);

    const liquidityUsd = info.liquidity != null ? num(info.liquidity) : null;
    const holderCount = info.holder_count != null ? Math.round(num(info.holder_count)) : null;

    const link = linkRes.ok ? unwrapData(linkRes.data) : {};
    const socials: GmgnProVerifyResult["socials"] = {};
    const tw = typeof link.twitter_username === "string" ? link.twitter_username.trim() : "";
    const tg = typeof link.telegram === "string" ? link.telegram.trim() : "";
    const web = typeof link.website === "string" ? link.website.trim() : "";
    if (tw) {
      socials.twitter = tw.startsWith("http")
        ? tw
        : tw.startsWith("i/communities/")
          ? `https://x.com/${tw}`
          : `https://x.com/${tw.replace(/^@/, "")}`;
    }
    if (tg) socials.telegram = tg.startsWith("http") ? tg : `https://t.me/${tg.replace(/^@/, "")}`;
    if (web && web.startsWith("http")) socials.website = web;

    const tokenStat: TokenStatSnap | null = tstat
      ? {
          top10HolderRate: tstat.top_10_holder_rate != null ? num(tstat.top_10_holder_rate) : null,
          bundlerPct: tstat.top_bundler_trader_percentage != null
            ? num(tstat.top_bundler_trader_percentage) : null,
          ratPct: tstat.top_rat_trader_percentage != null
            ? num(tstat.top_rat_trader_percentage) : null,
          botDegenRate: tstat.bot_degen_rate != null ? num(tstat.bot_degen_rate) : null,
          sniperHoldRate: tstat.top70_sniper_hold_rate != null
            ? num(tstat.top70_sniper_hold_rate) : null,
          creatorHoldRate: tstat.creator_hold_rate != null ? num(tstat.creator_hold_rate) : null,
          creatorCreatedCount: tstat.creator_created_count != null
            ? Math.round(num(tstat.creator_created_count)) : null,
        }
      : null;

    const result: GmgnProVerifyResult = {
      ok: true,
      kolCount: Math.max(kolCount, 0),
      smartCount: Math.max(smartCount, 0),
      holderStatKol,
      holderStatSmart,
      tagsKol,
      tagsSmart,
      holdingKol: kolConviction.holding,
      holdingSmart: smartConviction.holding,
      kolConviction,
      smartConviction,
      tokenStat,
      holderCount,
      liquidityUsd: liquidityUsd != null && liquidityUsd > 0 ? liquidityUsd : null,
      socials,
      wallets: { kol: kolWallets, smart: smartWallets },
      source: "gmgn_live",
      fetchedAt,
    };

    log.info(
      {
        address: address.slice(0, 8),
        kol: result.kolCount,
        smart: result.smartCount,
        holdingKol: result.holdingKol,
        holdingSmart: result.holdingSmart,
        smartHoldRate: Math.round(smartConviction.holdRate * 100),
        smartPaper: smartConviction.paperHands,
        smartDiamond: smartConviction.diamondHands,
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

  let rawPatch: Record<string, unknown> | undefined;
  if (verify.socials.twitter || verify.socials.telegram || verify.socials.website) {
    const existing = await db
      .select({ rawMetadata: tracked_tokens.rawMetadata })
      .from(tracked_tokens)
      .where(eq(tracked_tokens.id, tokenId))
      .limit(1);
    const prev = existing[0]?.rawMetadata;
    const base: Record<string, unknown> = Array.isArray(prev)
      ? { pairs: prev }
      : (prev && typeof prev === "object" ? { ...(prev as Record<string, unknown>) } : {});
    rawPatch = {
      ...base,
      link: { ...(typeof base.link === "object" && base.link ? base.link as object : {}), ...verify.socials },
      twitter: verify.socials.twitter ?? base.twitter,
      telegram: verify.socials.telegram ?? base.telegram,
      website: verify.socials.website ?? base.website,
      gmgnTokenStat: verify.tokenStat,
      gmgnConviction: {
        kol: verify.kolConviction,
        smart: verify.smartConviction,
        fetchedAt: verify.fetchedAt.toISOString(),
      },
    };
  } else if (verify.tokenStat || verify.smartConviction.total > 0) {
    const existing = await db
      .select({ rawMetadata: tracked_tokens.rawMetadata })
      .from(tracked_tokens)
      .where(eq(tracked_tokens.id, tokenId))
      .limit(1);
    const prev = existing[0]?.rawMetadata;
    const base: Record<string, unknown> = Array.isArray(prev)
      ? { pairs: prev }
      : (prev && typeof prev === "object" ? { ...(prev as Record<string, unknown>) } : {});
    rawPatch = {
      ...base,
      gmgnTokenStat: verify.tokenStat,
      gmgnConviction: {
        kol: verify.kolConviction,
        smart: verify.smartConviction,
        fetchedAt: verify.fetchedAt.toISOString(),
      },
    };
  }

  await db
    .update(tracked_tokens)
    .set({
      holderKolCount: verify.kolCount,
      holderSmartCount: verify.smartCount,
      ...(verify.holderCount != null ? { holderCount: verify.holderCount } : {}),
      ...(verify.liquidityUsd != null ? { liquidityUsd: String(verify.liquidityUsd) } : {}),
      ...(verify.tokenStat?.top10HolderRate != null
        ? { secTop10HolderRate: verify.tokenStat.top10HolderRate }
        : {}),
      ...(rawPatch ? { rawMetadata: rawPatch } : {}),
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
    conviction: {
      kol: verify.kolConviction,
      smart: verify.smartConviction,
    },
    tokenStat: verify.tokenStat,
    holding: { kol: verify.holdingKol, smart: verify.holdingSmart },
    kol: verify.wallets.kol.slice(0, 40),
    smart: verify.wallets.smart.slice(0, 40),
  };
}

/** Parse frozen verified_wallets JSON into conviction (for scoring / feed). */
export function convictionFromPayload(raw: unknown): {
  kol: WalletConviction;
  smart: WalletConviction;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.conviction && typeof o.conviction === "object") {
    const c = o.conviction as { kol?: WalletConviction; smart?: WalletConviction };
    if (c.kol && c.smart) return { kol: c.kol, smart: c.smart };
  }
  // Legacy: recompute from wallet lists
  const kol = Array.isArray(o.kol) ? mapHolders(o.kol) : [];
  const smart = Array.isArray(o.smart) ? mapHolders(o.smart) : [];
  if (!kol.length && !smart.length) return null;
  return { kol: computeConviction(kol), smart: computeConviction(smart) };
}
