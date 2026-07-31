/**
 * Live GMGN KOL / smart verify for Pro Caller qualify.
 *
 * Prefer Official OpenAPI (GMGN_API_KEY → openapi.gmgn.ai) — bypasses website
 * Cloudflare. Falls back to gmgn.ai scrape (+ GMGN_PROXIES) when key missing/fails.
 *
 * OpenAPI path: token/info + token/security + 2× top_holders (KOL/smart).
 * Scrape path: token_wallet_tags_stat / holder_stat / holders / link / token_stat.
 */

import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq } from "drizzle-orm";
import { gmgnFetch, nextProxy, CHAIN_MAP } from "./gmgn-client";
import { fetchOpenApiTokenBundle, hasGmgnOpenApiKey } from "./gmgn-openapi";
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
  /** Extra OpenAPI quality signals */
  freshWalletRate: number | null;
  entrapmentPct: number | null;
  sniperWallets: number | null;
  bundlerWallets: number | null;
  whaleWallets: number | null;
  signalCount: number | null;
  priceChange1m: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  volume1h: number | null;
  volume24h: number | null;
  quoteSymbol: string | null;
  exchange: string | null;
};

export type SecuritySnap = {
  mintRenounced: boolean | null;
  freezeRenounced: boolean | null;
  isHoneypot: boolean | null;
  top10HolderRate: number | null;
  burnStatus: string | null;
  canSell: boolean | null;
  buyTax: number | null;
  sellTax: number | null;
  creatorClose: boolean | null;
  creatorAddress: string | null;
  ctoFlag: boolean | null;
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
  security: SecuritySnap | null;
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
    const buyTx = Math.round(num(raw.buy_tx_count_cur));
    const sellTx = Math.round(num(raw.sell_tx_count_cur));
    const holding = bal > 0 || (pct != null && pct > 0);
    const soldFully = !holding;
    // OpenAPI rarely emits paper_hands/diamond_hands tags — infer from sell ratio
    const taggedPaper = makerTags.includes("paper_hands") || labels.includes("paper_hands");
    const taggedDiamond = makerTags.includes("diamond_hands") || labels.includes("diamond_hands");
    const paperHands = taggedPaper
      || soldFully
      || (sellPct != null && sellPct >= 0.75);
    const diamondHands = !paperHands && (
      taggedDiamond
      || (holding && buyTx >= 1 && (sellPct == null || sellPct <= 0.12) && sellTx <= buyTx)
    );
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
      soldFully,
      sellAmountPercentage: sellPct,
      buyTxCount: buyTx,
      sellTxCount: sellTx,
      realizedProfit: raw.realized_profit != null ? num(raw.realized_profit) : null,
      unrealizedProfit: raw.unrealized_profit != null ? num(raw.unrealized_profit) : null,
      paperHands,
      diamondHands,
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
  const root = data as {
    data?: { data?: { list?: unknown[] }; list?: unknown[] } | unknown[];
    list?: unknown[];
  };
  if (Array.isArray(root?.data)) return root.data;
  if (Array.isArray(root?.list)) return root.list;
  const inner = root?.data as { data?: { list?: unknown[] }; list?: unknown[] } | undefined;
  return inner?.data?.list ?? inner?.list ?? [];
}

function unwrapData(data: unknown): Record<string, unknown> {
  const root = data as { data?: Record<string, unknown> };
  return (root?.data && typeof root.data === "object" ? root.data : {}) as Record<string, unknown>;
}

function buildSocials(link: Record<string, unknown>): GmgnProVerifyResult["socials"] {
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
  return socials;
}

function tokenStatFromParts(
  info: Record<string, unknown>,
  tags: Record<string, unknown>,
  stat: Record<string, unknown>,
): TokenStatSnap {
  const price = (info.price && typeof info.price === "object"
    ? info.price
    : {}) as Record<string, unknown>;
  const pool = (info.pool && typeof info.pool === "object"
    ? info.pool
    : {}) as Record<string, unknown>;
  const px = (k: string) => {
    const cur = num(price.price);
    const prev = num(price[k]);
    if (cur <= 0 || prev <= 0) return null;
    return (cur - prev) / prev;
  };
  return {
    top10HolderRate: stat.top_10_holder_rate != null ? num(stat.top_10_holder_rate) : null,
    bundlerPct: stat.top_bundler_trader_percentage != null
      ? num(stat.top_bundler_trader_percentage) : null,
    ratPct: stat.top_rat_trader_percentage != null
      ? num(stat.top_rat_trader_percentage) : null,
    botDegenRate: stat.bot_degen_rate != null ? num(stat.bot_degen_rate) : null,
    sniperHoldRate: stat.top70_sniper_hold_rate != null
      ? num(stat.top70_sniper_hold_rate) : null,
    creatorHoldRate: stat.creator_hold_rate != null ? num(stat.creator_hold_rate) : null,
    creatorCreatedCount: (info.creator_created_count ?? stat.creator_created_count) != null
      ? Math.round(num(info.creator_created_count ?? stat.creator_created_count)) : null,
    freshWalletRate: stat.fresh_wallet_rate != null ? num(stat.fresh_wallet_rate) : null,
    entrapmentPct: stat.top_entrapment_trader_percentage != null
      ? num(stat.top_entrapment_trader_percentage) : null,
    sniperWallets: tags.sniper_wallets != null ? Math.round(num(tags.sniper_wallets)) : null,
    bundlerWallets: tags.bundler_wallets != null ? Math.round(num(tags.bundler_wallets)) : null,
    whaleWallets: tags.whale_wallets != null ? Math.round(num(tags.whale_wallets)) : null,
    signalCount: stat.signal_count != null ? Math.round(num(stat.signal_count)) : null,
    priceChange1m: px("price_1m"),
    priceChange5m: px("price_5m"),
    priceChange1h: px("price_1h"),
    volume1h: price.volume_1h != null ? num(price.volume_1h) : null,
    volume24h: price.volume_24h != null ? num(price.volume_24h) : null,
    quoteSymbol: typeof pool.quote_symbol === "string" ? pool.quote_symbol : null,
    exchange: typeof pool.exchange === "string" ? pool.exchange : null,
  };
}

function tokenStatFromFlat(tstat: Record<string, unknown> | null): TokenStatSnap | null {
  if (!tstat) return null;
  return tokenStatFromParts({}, {}, tstat);
}

function securityFromOpenApi(
  sec: Record<string, unknown>,
  info: Record<string, unknown>,
): SecuritySnap | null {
  if (!sec || Object.keys(sec).length === 0) return null;
  const dev = (info.dev && typeof info.dev === "object" ? info.dev : {}) as Record<string, unknown>;
  const honeypotRaw = sec.is_honeypot ?? sec.honeypot;
  let isHoneypot: boolean | null = null;
  if (honeypotRaw === true || honeypotRaw === "yes" || honeypotRaw === 1) isHoneypot = true;
  else if (honeypotRaw === false || honeypotRaw === "no" || honeypotRaw === 0) isHoneypot = false;

  const creatorStatus = String(dev.creator_token_status ?? sec.creator_token_status ?? "");
  return {
    mintRenounced: typeof sec.renounced_mint === "boolean" ? sec.renounced_mint : null,
    freezeRenounced: typeof sec.renounced_freeze_account === "boolean"
      ? sec.renounced_freeze_account : null,
    isHoneypot,
    top10HolderRate: sec.top_10_holder_rate != null ? num(sec.top_10_holder_rate) : null,
    burnStatus: typeof sec.burn_status === "string" ? sec.burn_status : null,
    canSell: sec.can_not_sell === 1 || sec.can_not_sell === true
      ? false
      : (sec.can_sell === 1 || sec.can_sell === true ? true : null),
    buyTax: sec.buy_tax != null ? num(sec.buy_tax) : null,
    sellTax: sec.sell_tax != null ? num(sec.sell_tax) : null,
    creatorClose: creatorStatus.includes("close") ? true
      : creatorStatus.includes("hold") ? false : null,
    creatorAddress: typeof (dev.creator_address ?? sec.creator_address) === "string"
      ? String(dev.creator_address ?? sec.creator_address) : null,
    ctoFlag: dev.cto_flag === 1 || dev.cto_flag === true,
  };
}

function emptyVerify(fetchedAt: Date): GmgnProVerifyResult {
  return {
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
    security: null,
    holderCount: null,
    liquidityUsd: null,
    socials: {},
    wallets: { kol: [], smart: [] },
    source: "failed",
    fetchedAt,
  };
}

/** Official OpenAPI path — no gmgn.ai Cloudflare scrape. */
async function verifyViaOpenApi(
  chain: string,
  address: string,
  fetchedAt: Date,
): Promise<GmgnProVerifyResult | null> {
  if (!hasGmgnOpenApiKey()) return null;

  const bundle = await fetchOpenApiTokenBundle(chain, address, 40);
  const { info: infoRes, security: secRes, kolHolders: kolRes, smartHolders: smartRes } = bundle;

  if (!infoRes.ok && !kolRes.ok && !smartRes.ok) {
    log.warn(
      {
        address: address.slice(0, 8),
        infoErr: (infoRes.data as { error?: string })?.error,
        status: infoRes.status,
      },
      "GMGN OpenAPI pro-verify failed — will try scrape fallback",
    );
    return null;
  }

  const info = unwrapData(infoRes.data);
  const tags = (info.wallet_tags_stat && typeof info.wallet_tags_stat === "object"
    ? info.wallet_tags_stat
    : {}) as Record<string, unknown>;
  const stat = (info.stat && typeof info.stat === "object" ? info.stat : {}) as Record<string, unknown>;
  const link = (info.link && typeof info.link === "object" ? info.link : {}) as Record<string, unknown>;
  const sec = secRes.ok ? unwrapData(secRes.data) : {};

  const tagsKol = Math.round(num(tags.renowned_wallets));
  const tagsSmart = Math.round(num(tags.smart_wallets));
  const holderStatKol = tagsKol;
  const holderStatSmart = tagsSmart;

  const kolWallets = kolRes.ok ? mapHolders(unwrapList(kolRes.data)) : [];
  const smartWallets = smartRes.ok ? mapHolders(unwrapList(smartRes.data)) : [];
  const kolConviction = computeConviction(kolWallets);
  const smartConviction = computeConviction(smartWallets);

  const liquidityUsd = info.liquidity != null ? num(info.liquidity) : null;
  const holderCount = info.holder_count != null ? Math.round(num(info.holder_count)) : null;
  const tokenStat = tokenStatFromParts(info, tags, stat);
  const security = securityFromOpenApi(sec, info);

  const result: GmgnProVerifyResult = {
    ok: true,
    kolCount: Math.max(tagsKol, 0),
    smartCount: Math.max(tagsSmart, 0),
    holderStatKol,
    holderStatSmart,
    tagsKol,
    tagsSmart,
    holdingKol: kolConviction.holding,
    holdingSmart: smartConviction.holding,
    kolConviction,
    smartConviction,
    tokenStat,
    security,
    holderCount,
    liquidityUsd: liquidityUsd != null && liquidityUsd > 0 ? liquidityUsd : null,
    socials: buildSocials(link),
    wallets: { kol: kolWallets, smart: smartWallets },
    source: "gmgn_live",
    fetchedAt,
  };

  log.info(
    {
      address: address.slice(0, 8),
      via: "openapi",
      kol: result.kolCount,
      smart: result.smartCount,
      holdingKol: result.holdingKol,
      holdingSmart: result.holdingSmart,
      smartHoldRate: Math.round(smartConviction.holdRate * 100),
      top10: tokenStat.top10HolderRate,
      bundler: tokenStat.bundlerPct,
      mintOk: security?.mintRenounced,
    },
    "GMGN pro-verify ok",
  );
  return result;
}

/**
 * Live-fetch GMGN KOL + smart + token_stat for a token.
 * OpenAPI-first when GMGN_API_KEY is set; scrape + sticky proxy as fallback.
 */
export async function verifyTokenKolSmart(
  chain: string,
  address: string,
): Promise<GmgnProVerifyResult> {
  const c = CHAIN_MAP[chain.toLowerCase()] ?? "sol";
  const fetchedAt = new Date();
  const empty = emptyVerify(fetchedAt);

  try {
    const open = await verifyViaOpenApi(c, address, fetchedAt);
    if (open?.ok) return open;

    const proxy = nextProxy();
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
      tokenStat: tokenStatFromFlat(tstat),
      security: null,
      holderCount,
      liquidityUsd: liquidityUsd != null && liquidityUsd > 0 ? liquidityUsd : null,
      socials: buildSocials(link),
      wallets: { kol: kolWallets, smart: smartWallets },
      source: "gmgn_live",
      fetchedAt,
    };

    log.info(
      {
        address: address.slice(0, 8),
        via: "scrape",
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
      gmgnSecurity: verify.security,
      gmgnConviction: {
        kol: verify.kolConviction,
        smart: verify.smartConviction,
        fetchedAt: verify.fetchedAt.toISOString(),
      },
    };
  } else if (verify.tokenStat || verify.security || verify.smartConviction.total > 0) {
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
      gmgnSecurity: verify.security,
      gmgnConviction: {
        kol: verify.kolConviction,
        smart: verify.smartConviction,
        fetchedAt: verify.fetchedAt.toISOString(),
      },
    };
  }

  const sec = verify.security;
  const top10 = sec?.top10HolderRate ?? verify.tokenStat?.top10HolderRate ?? null;

  await db
    .update(tracked_tokens)
    .set({
      holderKolCount: verify.kolCount,
      holderSmartCount: verify.smartCount,
      ...(verify.holderCount != null ? { holderCount: verify.holderCount } : {}),
      ...(verify.liquidityUsd != null ? { liquidityUsd: String(verify.liquidityUsd) } : {}),
      ...(top10 != null ? { secTop10HolderRate: top10 } : {}),
      ...(sec?.mintRenounced != null ? { secMintRenounced: sec.mintRenounced } : {}),
      ...(sec?.freezeRenounced != null ? { secFreezeRenounced: sec.freezeRenounced } : {}),
      ...(sec?.isHoneypot != null ? { secIsHoneypot: sec.isHoneypot } : {}),
      ...(sec?.creatorClose != null ? { secCreatorClose: sec.creatorClose } : {}),
      ...(sec?.creatorAddress ? { secCreatorAddress: sec.creatorAddress } : {}),
      ...(sec?.ctoFlag != null ? { secCtoFlag: sec.ctoFlag } : {}),
      ...(sec?.buyTax != null ? { secBuyTax: sec.buyTax } : {}),
      ...(sec?.sellTax != null ? { secSellTax: sec.sellTax } : {}),
      ...(verify.tokenStat?.ratPct != null ? { secRatTraderAmtRate: verify.tokenStat.ratPct } : {}),
      ...(verify.tokenStat?.sniperWallets != null
        ? { secSniperCount: verify.tokenStat.sniperWallets } : {}),
      ...(verify.tokenStat?.creatorCreatedCount != null
        ? { secCreatorCreatedCount: verify.tokenStat.creatorCreatedCount } : {}),
      ...(sec || verify.tokenStat ? { secFetchedAt: verify.fetchedAt } : {}),
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
    security: verify.security,
    holding: { kol: verify.holdingKol, smart: verify.holdingSmart },
    kol: verify.wallets.kol.slice(0, 40),
    smart: verify.wallets.smart.slice(0, 40),
  };
}

/** Quality risk fields stored on verified_wallets.tokenStat for scoring. */
export function qualitySignalsFromPayload(raw: unknown): {
  bundlerPct: number | null;
  sniperHoldRate: number | null;
  freshWalletRate: number | null;
  botDegenRate: number | null;
  entrapmentPct: number | null;
  ratPct: number | null;
} {
  const empty = {
    bundlerPct: null as number | null,
    sniperHoldRate: null as number | null,
    freshWalletRate: null as number | null,
    botDegenRate: null as number | null,
    entrapmentPct: null as number | null,
    ratPct: null as number | null,
  };
  if (!raw || typeof raw !== "object") return empty;
  const ts = (raw as { tokenStat?: Record<string, unknown> }).tokenStat;
  if (!ts || typeof ts !== "object") return empty;
  const n = (k: string) => {
    const v = ts[k];
    if (v == null) return null;
    const x = typeof v === "number" ? v : parseFloat(String(v));
    return Number.isFinite(x) ? x : null;
  };
  return {
    bundlerPct: n("bundlerPct"),
    sniperHoldRate: n("sniperHoldRate"),
    freshWalletRate: n("freshWalletRate"),
    botDegenRate: n("botDegenRate"),
    entrapmentPct: n("entrapmentPct"),
    ratPct: n("ratPct"),
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
