import { Router } from "express";
import { db } from "@workspace/db";
import { tracked_tokens, token_buys, token_sells, walletdatasource, token_holders, token_traders, wallet_profiles, token_intel_log, token_price_snapshots as tps } from "@workspace/db";
import { eq, desc, asc, count, sql, and, or, ilike, isNotNull, gte, inArray } from "drizzle-orm";
import { fetchLivePrice } from "../pipeline/price-service";
import {
  gmgnFetch, nextProxy, persistHolders, CHAIN_MAP, fetchAndPersistHolders,
  fetchTokenSecurity, fetchTokenPool, fetchTopTraders, fetchWalletProfile,
  fetchWalletHoldings, persistTraders,
} from "../lib/gmgn-client";
import { buildHolderIntel } from "../lib/holder-intel";
import { publicApiOrigin } from "../lib/public-url";

const router = Router();

function resolveLogoUri(imagePath: string | null | undefined, logoUri: string | null | undefined): string | null {
  const external = (logoUri ?? "").trim();
  if (/^https?:\/\//i.test(external)) return external;
  const path = (imagePath ?? "").trim();
  if (path) {
    const rel = path.startsWith("/api/assets")
      ? path
      : `/api/assets${path.startsWith("/") ? path : `/${path}`}`;
    const base = publicApiOrigin();
    return base ? `${base}${rel}` : rel;
  }
  return external || null;
}

// ── Token shape mapper ────────────────────────────────────────────────────────

function mapToken(t: typeof tracked_tokens.$inferSelect) {
  return {
    id:               t.id,
    address:          t.address,
    chain:            t.chain,
    name:             t.name,
    symbol:           t.symbol,
    logoUri:          resolveLogoUri(t.imagePath, t.logoUri),
    detectedPriceUsd: t.detectedPriceUsd,
    currentPriceUsd:  t.currentPriceUsd,
    athPriceUsd:      t.athPriceUsd,
    marketCapUsd:     t.marketCapUsd,
    athMarketCapUsd:  t.athMarketCapUsd,
    fdvUsd:           t.fdvUsd,
    liquidityUsd:     t.liquidityUsd,
    volume24hUsd:     t.volume24hUsd,
    tokenCreatedAt:   t.tokenCreatedAt?.toISOString() ?? null,
    firstDetectedAt:  t.firstDetectedAt.toISOString(),
    lastBuyAt:        t.lastBuyAt?.toISOString() ?? null,
    lastSellAt:       t.lastSellAt?.toISOString() ?? null,
    priceUpdatedAt:   t.priceUpdatedAt?.toISOString() ?? null,
    status:           t.status,
    migrated:         t.migrated,
    momentum5m:       t.momentum5m,
    momentum15m:      t.momentum15m,
    momentum30m:      t.momentum30m,
    momentum1h:       t.momentum1h,
    momentum6h:       t.momentum6h,
    momentum24h:      t.momentum24h,
    activeWallets:    t.activeWallets,
    detectionGainPct: t.gainPct    ?? null,
    athGainPct:       t.athGainPct ?? null,
    buyPressure:      t.buyPressure,
    holderMomentumScore: t.holderMomentumScore,
    holderMomentumLabel: t.holderMomentumLabel,
    holderCount:       t.holderCount,
    holderKolCount:    t.holderKolCount,
    holderSmartCount:  t.holderSmartCount,
    holderTop10Pct:    t.holderTop10Pct,
    holderHoldingRate:   t.holderHoldingRate,
    holderBoughtRate:    t.holderBoughtRate,
    holderQualityScore:  t.holderQualityScore,
    holderBundlerCount:  t.holderBundlerCount,
    holderSniperCount:   t.holderSniperCount,
    holderMomentumUpdatedAt:  t.holderMomentumUpdatedAt?.toISOString() ?? null,
    // Holder Intelligence v2
    holderMomentumScoreV2:   t.holderMomentumScoreV2,
    holderClusterCount:      t.holderClusterCount,
    holderCabalDetected:     t.holderCabalDetected,
    holderLargestClusterPct: t.holderLargestClusterPct,
    metadataUpdatedAt:       t.metadataUpdatedAt?.toISOString() ?? null,
    lastStatusChangeAt:      t.lastStatusChangeAt?.toISOString() ?? null,
    imageStatus:      t.imageStatus,
    // Intelligence layer
    intelligenceScore:      t.intelligenceScore,
    qualityLabel:           t.qualityLabel,
    mcGrowthScore:          t.mcGrowthScore,
    volumeIntensityScore:   t.volumeIntensityScore,
    holderVelocityScore:    t.holderVelocityScore,
    kolSmartScore:          t.kolSmartScore,
    liquidityHealthScore:   t.liquidityHealthScore,
    intelligenceUpdatedAt:  t.intelligenceUpdatedAt?.toISOString() ?? null,
    consecutivePositiveChecks: t.consecutivePositiveChecks,
    peakMcUsd:              t.peakMcUsd,
    // Composite scoring (holder-velocity-dominant formula)
    compositeScore:         t.compositeScore ?? null,
    compositeFactors:       (t.compositeFactors as string[] | null) ?? [],
    compositeUpdatedAt:     t.compositeUpdatedAt?.toISOString() ?? null,
    // Security / CA analysis
    security: t.secFetchedAt ? {
      isHoneypot:          t.secIsHoneypot,
      ownerRenounced:      t.secOwnerRenounced,
      mintRenounced:       t.secMintRenounced,
      freezeRenounced:     t.secFreezeRenounced,
      openSource:          t.secOpenSource,
      top10HolderRate:     t.secTop10HolderRate,
      rugRatio:            t.secRugRatio,
      sniperCount:         t.secSniperCount,
      creatorAddress:      t.secCreatorAddress,
      creatorClose:        t.secCreatorClose,
      creatorTokenStatus:  t.secCreatorTokenStatus,
      buyTax:              t.secBuyTax,
      sellTax:             t.secSellTax,
      lpLocked:            t.secLpLocked,
      lpLockPercent:       t.secLpLockPercent,
      ctoFlag:             t.secCtoFlag,
      bluechipOwnerPct:    t.secBluechipOwnerPct,
      ratTraderAmtRate:    t.secRatTraderAmtRate,
      creatorCreatedCount: t.secCreatorCreatedCount,
      fetchedAt:           t.secFetchedAt?.toISOString() ?? null,
    } : null,
    lastHoldersUpdatedAt: t.lastHoldersUpdatedAt?.toISOString() ?? null,
    // Multi-type momentum object
    momentum: {
      composite_momentum:        t.compositeMomentum,
      price_momentum:            t.priceMomentum,
      volume_momentum:           t.volumeMomentum,
      buy_pressure_momentum:     t.buyPressureMomentum,
      holder_momentum:           t.holderMomentumComputed,
      liquidity_momentum:        t.liquidityMomentum ?? null,
      volatility_adjusted_momentum: t.volatilityAdjMomentum,
      early_momentum:            t.earlyMomentum,
      sustained_momentum:        t.sustainedMomentum,
      revival_potential:         t.revivalPotential,
      low_liquidity_flag:        t.lowLiquidityFlag,
    },
  };
}

// ── Sort clause builder ───────────────────────────────────────────────────────

function buildOrder(sort: string, dir: string) {
  const isAsc = dir === "asc";
  switch (sort) {
    case "name":
      return isAsc ? asc(tracked_tokens.name) : desc(tracked_tokens.name);
    case "detectionGainPct":
      return isAsc
        ? sql`gain_pct ASC NULLS LAST`
        : sql`gain_pct DESC NULLS LAST`;
    case "athGainPct":
      return isAsc
        ? sql`ath_gain_pct ASC NULLS LAST`
        : sql`ath_gain_pct DESC NULLS LAST`;
    case "momentum1h":
      return isAsc ? asc(tracked_tokens.momentum1h) : desc(tracked_tokens.momentum1h);
    case "holderMomentumScore":
      return isAsc ? asc(tracked_tokens.holderMomentumScore) : desc(tracked_tokens.holderMomentumScore);
    case "intelligenceScore":
      return isAsc ? asc(tracked_tokens.intelligenceScore) : desc(tracked_tokens.intelligenceScore);
    case "marketCapUsd":
      return isAsc
        ? sql`CAST(NULLIF(market_cap_usd,'') AS NUMERIC) ASC NULLS LAST`
        : sql`CAST(NULLIF(market_cap_usd,'') AS NUMERIC) DESC NULLS LAST`;
    default: // systemAge / firstDetectedAt
      return isAsc ? asc(tracked_tokens.firstDetectedAt) : desc(tracked_tokens.firstDetectedAt);
  }
}

// ── List tokens (paginated + server-side filter/sort) ─────────────────────────
//
//   GET /api/tokens?page=1&limit=50&status=all&sort=firstDetectedAt&order=desc
//
//   Response: { data: Token[], total: number, page: number, pages: number }

router.get("/", async (req, res): Promise<void> => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  ?? "1"),  10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
    const status = String(req.query.status ?? "all");
    const sort   = String(req.query.sort   ?? "firstDetectedAt");
    const order  = String(req.query.order  ?? "desc") === "asc" ? "asc" : "desc";
    const offset = (page - 1) * limit;

    const q     = String(req.query.q     ?? "").trim();
    const chain = String(req.query.chain ?? "").trim();

    // Quality-gate params
    const minIntelScore = parseFloat(String(req.query.minIntelScore ?? "0")) || 0;
    const minMc         = parseFloat(String(req.query.minMc         ?? "0")) || 0;

    // Build WHERE conditions
    const VALID_STATUSES = ["new", "active", "watch", "archive", "revived"];
    const conditions = [];

    if (status === "migrated") {
      conditions.push(eq(tracked_tokens.migrated, true));
    } else if (status === "smart") {
      // Intel-qualified view: new/active/watch only (excludes archive, revived, migrated)
      conditions.push(inArray(tracked_tokens.status, ["new", "active", "watch"]));
    } else if (VALID_STATUSES.includes(status)) {
      conditions.push(eq(tracked_tokens.status, status));
    }

    if (chain && chain !== "all") {
      conditions.push(eq(tracked_tokens.chain, chain));
    }

    if (q) {
      conditions.push(
        or(
          ilike(tracked_tokens.name,    `%${q}%`),
          ilike(tracked_tokens.symbol,  `%${q}%`),
          ilike(tracked_tokens.address, `%${q}%`),
        )!,
      );
    }

    // Intelligence score gate (e.g. minIntelScore=80)
    if (minIntelScore > 0) {
      conditions.push(gte(tracked_tokens.intelligenceScore, minIntelScore));
    }

    // Market cap floor — rejects dead/micro tokens below threshold (e.g. minMc=5000)
    if (minMc > 0) {
      conditions.push(
        sql`CAST(NULLIF(${tracked_tokens.marketCapUsd},'') AS NUMERIC) >= ${minMc}`,
      );
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Count + data in parallel
    const [countResult, rows] = await Promise.all([
      db.select({ total: count() }).from(tracked_tokens).where(where),
      db.select().from(tracked_tokens)
        .where(where)
        .orderBy(buildOrder(sort, order))
        .limit(limit)
        .offset(offset),
    ]);

    const total = Number(countResult[0]?.total ?? 0);

    res.json({
      data:  rows.map(mapToken),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── Force-refresh a single token: price + metadata + holders (partial updates) ─
//
// Accepts EITHER a numeric DB id OR a token mint/contract address (string).
// All three data sources are fetched in parallel with Promise.allSettled so a
// failure in one does not block the others — per-field staleness is updated only
// for the sources that succeeded.
//
//   POST /api/tokens/:id/refresh
//   POST /api/tokens/:mint/refresh
//
// Optional body: { holders: true }  — triggers a background holders snapshot

router.post("/:id/refresh", async (req, res): Promise<void> => {
  try {
    const idOrMint  = req.params.id;
    const numericId = parseInt(idOrMint, 10);

    // Resolve token — by numeric ID or by mint/contract address
    let token: typeof tracked_tokens.$inferSelect | undefined;
    if (!isNaN(numericId) && String(numericId) === idOrMint) {
      const [row] = await db.select().from(tracked_tokens).where(eq(tracked_tokens.id, numericId)).limit(1);
      token = row;
    } else {
      const [row] = await db.select().from(tracked_tokens).where(eq(tracked_tokens.address, idOrMint)).limit(1);
      token = row;
    }

    if (!token) return void res.status(404).json({ error: "Token not found" });

    const refreshHolders = req.body?.holders === true;
    const now = new Date();

    // ── Parallel fetch — each source fails independently ──────────────────────
    const [priceResult, holdersResult] = await Promise.allSettled([
      fetchLivePrice(token.chain, token.address),
      refreshHolders
        ? fetchAndPersistHolders({
            id: token.id, address: token.address, chain: token.chain,
            name: token.name, symbol: token.symbol, marketCapUsd: token.marketCapUsd,
          })
        : Promise.resolve(null),
    ]);

    // ── Build partial update from whichever sources succeeded ─────────────────
    type UpdateShape = Partial<typeof tracked_tokens.$inferInsert>;
    const patch: UpdateShape = {};
    const sourceFreshness: Record<string, string | null> = {
      price:    null,
      metadata: null,
      holders:  null,
    };

    if (priceResult.status === "fulfilled" && priceResult.value) {
      const fresh    = priceResult.value;
      const curNum   = parseFloat(fresh.price);
      const athNum   = token.athPriceUsd    ? parseFloat(token.athPriceUsd)    : 0;
      const athMcNum = token.athMarketCapUsd ? parseFloat(token.athMarketCapUsd) : 0;
      const curMcNum = fresh.marketCapUsd   ? parseFloat(fresh.marketCapUsd)   : 0;

      patch.currentPriceUsd = fresh.price;
      patch.athPriceUsd     = curNum   > athNum   ? fresh.price        : (token.athPriceUsd    ?? fresh.price);
      patch.athMarketCapUsd = curMcNum > athMcNum ? fresh.marketCapUsd : (token.athMarketCapUsd ?? fresh.marketCapUsd ?? null);
      patch.priceUpdatedAt  = now;
      patch.metadataUpdatedAt = now;

      if (fresh.logo)           patch.logoUri        = fresh.logo;
      if (fresh.marketCapUsd)   patch.marketCapUsd   = fresh.marketCapUsd;
      if (fresh.fdvUsd)         patch.fdvUsd         = fresh.fdvUsd;
      if (fresh.liquidityUsd)   patch.liquidityUsd   = fresh.liquidityUsd;
      if (fresh.volume24hUsd)   patch.volume24hUsd   = fresh.volume24hUsd;
      if (fresh.tokenCreatedAt) patch.tokenCreatedAt = fresh.tokenCreatedAt;

      sourceFreshness.price    = now.toISOString();
      sourceFreshness.metadata = now.toISOString();
    }

    if (holdersResult.status === "fulfilled" && holdersResult.value !== null) {
      patch.lastHoldersUpdatedAt = now;
      sourceFreshness.holders    = now.toISOString();
    }

    // At least one source must have succeeded
    if (!sourceFreshness.price && !sourceFreshness.holders) {
      const priceErr   = priceResult.status === "rejected" ? String(priceResult.reason) : "no data";
      const holdersErr = holdersResult.status === "rejected" ? String(holdersResult.reason) : null;
      return void res.status(502).json({
        error: "All refresh sources failed",
        details: { price: priceErr, holders: holdersErr },
      });
    }

    const [updated] = await db.update(tracked_tokens)
      .set(patch)
      .where(eq(tracked_tokens.id, token.id))
      .returning();

    res.json({
      ok:              true,
      tokenId:         token.id,
      address:         token.address,
      sourceFreshness,
      price:           (priceResult.status === "fulfilled" && priceResult.value?.price) || null,
      marketCapUsd:    (priceResult.status === "fulfilled" && priceResult.value?.marketCapUsd) || null,
      updated:         mapToken(updated),
    });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── Mark / unmark a token as migrated ────────────────────────────────────────
//
//   PATCH /api/tokens/:id/migrate   { migrated: true | false }

router.patch("/:id/migrate", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return void res.status(400).json({ error: "Invalid id" });

    const migrated = req.body?.migrated === true || req.body?.migrated === "true";

    const [updated] = await db
      .update(tracked_tokens)
      .set({ migrated })
      .where(eq(tracked_tokens.id, id))
      .returning();

    if (!updated) return void res.status(404).json({ error: "Token not found" });

    res.json({ ok: true, id, migrated: updated.migrated });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── Fire-and-forget holders refresh helper ────────────────────────────────────
// Triggers a paginated GMGN holders fetch when cached data is older than STALE_MS.
// Called on every token detail load so navigating always stays fresh.

const HOLDER_STALE_MS = 3 * 60 * 1_000; // 3 minutes

async function maybeRefreshHolders(token: {
  id: number; address: string; chain: string;
  name: string | null; symbol: string | null; marketCapUsd?: string | null;
}): Promise<void> {
  try {
    const [freshness] = await db
      .select({ latest: sql<Date | null>`MAX(fetched_at)` })
      .from(token_holders)
      .where(eq(token_holders.tokenId, token.id));

    const latestFetch = freshness?.latest ? new Date(freshness.latest) : null;
    if (latestFetch && Date.now() - latestFetch.getTime() < HOLDER_STALE_MS) return;

    await fetchAndPersistHolders(token);
  } catch {
    // Non-fatal — background refresh, ignore errors
  }
}

// ── Single token with buy/sell history ────────────────────────────────────────

router.get("/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return void res.status(400).json({ error: "Invalid id" });

    const [token] = await db.select().from(tracked_tokens).where(eq(tracked_tokens.id, id)).limit(1);
    if (!token) return void res.status(404).json({ error: "Token not found" });

    // Fire-and-forget holders refresh (non-blocking)
    maybeRefreshHolders(token).catch(() => {});

    const [buys, sells] = await Promise.all([
      db.select({
          id:       token_buys.id,
          walletId: token_buys.walletId,
          priceUsd: token_buys.priceUsd,
          amount:   token_buys.amount,
          txHash:   token_buys.txHash,
          boughtAt: token_buys.boughtAt,
          wallet: {
            address: walletdatasource.address,
            label:   walletdatasource.label,
          },
        })
        .from(token_buys)
        .leftJoin(walletdatasource, eq(token_buys.walletId, walletdatasource.id))
        .where(eq(token_buys.tokenId, id))
        .orderBy(desc(token_buys.boughtAt)),
      db.select({
          id:       token_sells.id,
          walletId: token_sells.walletId,
          priceUsd: token_sells.priceUsd,
          amount:   token_sells.amount,
          txHash:   token_sells.txHash,
          soldAt:   token_sells.soldAt,
          wallet: {
            address: walletdatasource.address,
            label:   walletdatasource.label,
          },
        })
        .from(token_sells)
        .leftJoin(walletdatasource, eq(token_sells.walletId, walletdatasource.id))
        .where(eq(token_sells.tokenId, id))
        .orderBy(desc(token_sells.soldAt)),
    ]);

    res.json({
      ...mapToken(token),
      buys: buys.map(b => ({
        id:       b.id,
        walletId: b.walletId,
        priceUsd: b.priceUsd,
        amount:   b.amount,
        txHash:   b.txHash,
        boughtAt: b.boughtAt.toISOString(),
        wallet:   b.wallet ?? null,
      })),
      sells: sells.map(s => ({
        id:       s.id,
        walletId: s.walletId,
        priceUsd: s.priceUsd,
        amount:   s.amount,
        txHash:   s.txHash,
        soldAt:   s.soldAt.toISOString(),
        wallet:   s.wallet ?? null,
      })),
    });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── GMGN Intel proxy ──────────────────────────────────────────────────────────
// gmgnFetch, nextProxy, CHAIN_MAP, and persistHolders are imported from
// ../lib/gmgn-client (shared with the background holders-refresh pipeline).

router.get("/:id/gmgn", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return void res.status(400).json({ error: "Invalid id" });

    const [token] = await db
      .select({
        address:      tracked_tokens.address,
        chain:        tracked_tokens.chain,
        name:         tracked_tokens.name,
        symbol:       tracked_tokens.symbol,
        marketCapUsd: tracked_tokens.marketCapUsd,
      })
      .from(tracked_tokens)
      .where(eq(tracked_tokens.id, id))
      .limit(1);

    if (!token) return void res.status(404).json({ error: "Token not found" });

    const chain = CHAIN_MAP[token.chain.toLowerCase()] ?? "sol";
    const addr  = token.address;

    // Pin all calls to the same exit IP so Cloudflare sees a consistent
    // fingerprint rather than different IPs per request.
    const stickyProxy = nextProxy();

    // Fetch token info, holder stat, and top buyers in parallel (single-page each).
    const [tokenInfoRes, holderStatRes, topBuyersRes] = await Promise.all([
      gmgnFetch(`https://gmgn.ai/api/v1/token_info/${chain}/${addr}`,            stickyProxy),
      gmgnFetch(`https://gmgn.ai/vas/api/v1/token_holder_stat/${chain}/${addr}`, stickyProxy),
      gmgnFetch(`https://gmgn.ai/defi/quotation/v1/tokens/top_buyers/${chain}/${addr}`, stickyProxy),
    ]);

    // Paginate the holder list — GMGN hard-caps every page at 20 regardless of
    // the limit param, so we walk offset=0,20,40,… up to LIVE_MAX_PAGES (100 holders).
    const LIVE_PAGE_SIZE = 20;
    const LIVE_MAX_PAGES = 5; // 5 × 20 = 100 holders max per live request
    const rawHolderList: unknown[] = [];
    let holdersOk = false;
    let holdersStatus = 0;
    let holdersPagesFetched = 0;

    for (let page = 0; page < LIVE_MAX_PAGES; page++) {
      const offset  = page * LIVE_PAGE_SIZE;
      const pageRes = await gmgnFetch(
        `https://gmgn.ai/vas/api/v1/token_holders/${chain}/${addr}?limit=${LIVE_PAGE_SIZE}&offset=${offset}`,
        stickyProxy,
      );
      holdersStatus = pageRes.status;
      if (!pageRes.ok) break;
      holdersOk = true;
      holdersPagesFetched++;
      const pageList: unknown[] =
        (pageRes.data as { data?: { list?: unknown[] } })?.data?.list ?? [];
      rawHolderList.push(...pageList);
      if (pageList.length < LIVE_PAGE_SIZE) break; // last page — stop early
    }

    // ── DB fallback when GMGN is blocked ─────────────────────────────────────
    let holdersDataOverride: unknown = null;
    let holderStatOverride:  unknown = null;

    if (!holdersOk || rawHolderList.length === 0) {
      try {
        const dbHolders = await db
          .select()
          .from(token_holders)
          .where(eq(token_holders.tokenId, id))
          .orderBy(token_holders.amountPercentage);

        if (dbHolders.length > 0) {
          const dbList = dbHolders.map(h => ({
            account_address:   h.walletAddress,
            twitter_name:      h.twitterName  ?? null,
            twitter_username:  h.twitterUsername ?? null,
            tags:              h.labels       ?? [],
            maker_token_tags:  [] as string[],
            amount_percentage: h.amountPercentage ?? null,
            balance:           h.balance   ? parseFloat(h.balance)           : null,
            cost_usd:          h.costUsd   ? parseFloat(h.costUsd)           : null,
            realized_profit:   h.realizedProfit ? parseFloat(h.realizedProfit) : null,
            buy_tx_count_cur:  h.buyCount  ?? 0,
            sell_tx_count_cur: h.sellCount ?? 0,
            _fromDb:           true,
          }));
          holdersDataOverride = { code: 0, _fromDb: true, data: { list: dbList } };

          if (!holderStatRes.ok) {
            const isLabel = (labels: string[] | null, matches: string[]) =>
              (labels ?? []).some(l => matches.includes(l));
            holderStatOverride = {
              code: 0, _fromDb: true,
              data: {
                smart_degen_count:    dbHolders.filter(h => isLabel(h.labels, ["smart_money","smart_degen"])).length,
                renowned_count:       dbHolders.filter(h => isLabel(h.labels, ["kol","renowned"])).length,
                sniper_count:         dbHolders.filter(h => isLabel(h.labels, ["sniper"])).length,
                bundler_count:        dbHolders.filter(h => isLabel(h.labels, ["bundler"])).length,
                fresh_wallet_count:   dbHolders.filter(h => isLabel(h.labels, ["fresh_wallet"])).length,
                dex_bot_count:        dbHolders.filter(h => isLabel(h.labels, ["dex_bot"])).length,
                insider_count:        dbHolders.filter(h => isLabel(h.labels, ["insider"])).length,
                dev_count:            dbHolders.filter(h => isLabel(h.labels, ["dev"])).length,
                bluechip_owner_count: dbHolders.filter(h => isLabel(h.labels, ["bluechip_owner"])).length,
              },
            };
          }
        }
      } catch (dbErr) {
        console.error("DB fallback fetch failed:", dbErr);
      }
    }

    const holderList = rawHolderList.length > 0
      ? rawHolderList
      : ((holdersDataOverride as { data?: { list?: unknown[] } })?.data?.list ?? []);
    const liveIntel = buildHolderIntel({
      tokenInfo: tokenInfoRes.data,
      holderStat: holderStatOverride ?? holderStatRes.data,
      topBuyers: topBuyersRes.data,
      fetchedTopCount: holderList.length,
      rawHolderList: holderList,
    });

    // ── Persist live holders to DB (only when we got real GMGN data, not DB fallback) ──
    if (rawHolderList.length > 0) {
      try {
        const tokenLabel = [token.name, token.symbol].filter(Boolean).join(" / ") || addr;
        // Use shared persistHolders so address handling is consistent:
        // account_address = actual wallet, address = ATA (never stored as wallet)
        await persistHolders(id, rawHolderList, token.marketCapUsd, tokenLabel);
      } catch (saveErr) {
        console.error("Failed to persist GMGN holders:", saveErr);
      }
    }

    res.json({
      address:    addr,
      chain,
      tokenInfo:  tokenInfoRes.data,
      holders:    holdersDataOverride ?? { code: 0, data: { list: rawHolderList } },
      holderStat: holderStatOverride  ?? holderStatRes.data,
      topBuyers:  topBuyersRes.data,
      holderIntel: liveIntel,
      _meta: {
        tokenInfoStatus:  tokenInfoRes.status,
        holdersStatus,
        holderStatStatus: holderStatRes.status,
        topBuyersStatus:  topBuyersRes.status,
        holderCount:      holderList.length,
        holdersPages:     holdersPagesFetched,
        holderStatsSource: holderStatRes.ok ? "gmgn-live" : holderStatOverride ? "database-fallback" : "unavailable",
        fetchedAt:         new Date().toISOString(),
      },
    });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/tokens/:id/security ─────────────────────────────────────────────
// Returns security data for a token: DB-cached first, live GMGN on ?refresh=1

router.get("/:id/security", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return void res.status(400).json({ error: "Invalid id" });

    const [token] = await db
      .select({
        address:      tracked_tokens.address,
        chain:        tracked_tokens.chain,
        name:         tracked_tokens.name,
        symbol:       tracked_tokens.symbol,
        marketCapUsd: tracked_tokens.marketCapUsd,
        // security columns
        secIsHoneypot:          tracked_tokens.secIsHoneypot,
        secOwnerRenounced:      tracked_tokens.secOwnerRenounced,
        secMintRenounced:       tracked_tokens.secMintRenounced,
        secFreezeRenounced:     tracked_tokens.secFreezeRenounced,
        secOpenSource:          tracked_tokens.secOpenSource,
        secTop10HolderRate:     tracked_tokens.secTop10HolderRate,
        secRugRatio:            tracked_tokens.secRugRatio,
        secSniperCount:         tracked_tokens.secSniperCount,
        secCreatorAddress:      tracked_tokens.secCreatorAddress,
        secCreatorClose:        tracked_tokens.secCreatorClose,
        secCreatorTokenStatus:  tracked_tokens.secCreatorTokenStatus,
        secBuyTax:              tracked_tokens.secBuyTax,
        secSellTax:             tracked_tokens.secSellTax,
        secLpLocked:            tracked_tokens.secLpLocked,
        secLpLockPercent:       tracked_tokens.secLpLockPercent,
        secCtoFlag:             tracked_tokens.secCtoFlag,
        secBluechipOwnerPct:    tracked_tokens.secBluechipOwnerPct,
        secRatTraderAmtRate:    tracked_tokens.secRatTraderAmtRate,
        secCreatorCreatedCount: tracked_tokens.secCreatorCreatedCount,
        secFetchedAt:           tracked_tokens.secFetchedAt,
      })
      .from(tracked_tokens)
      .where(eq(tracked_tokens.id, id))
      .limit(1);

    if (!token) return void res.status(404).json({ error: "Token not found" });

    const forceRefresh = req.query.refresh === "1";
    const stale = !token.secFetchedAt ||
      (Date.now() - new Date(token.secFetchedAt).getTime() > 30 * 60_000);

    // Return DB cache unless refresh forced or data is stale and we have nothing
    if (!forceRefresh && token.secFetchedAt && !stale) {
      return void res.json({
        source: "cache",
        security: {
          isHoneypot:          token.secIsHoneypot,
          ownerRenounced:      token.secOwnerRenounced,
          mintRenounced:       token.secMintRenounced,
          freezeRenounced:     token.secFreezeRenounced,
          openSource:          token.secOpenSource,
          top10HolderRate:     token.secTop10HolderRate,
          rugRatio:            token.secRugRatio,
          sniperCount:         token.secSniperCount,
          creatorAddress:      token.secCreatorAddress,
          creatorClose:        token.secCreatorClose,
          creatorTokenStatus:  token.secCreatorTokenStatus,
          buyTax:              token.secBuyTax,
          sellTax:             token.secSellTax,
          lpLocked:            token.secLpLocked,
          lpLockPercent:       token.secLpLockPercent,
          ctoFlag:             token.secCtoFlag,
          bluechipOwnerPct:    token.secBluechipOwnerPct,
          ratTraderAmtRate:    token.secRatTraderAmtRate,
          creatorCreatedCount: token.secCreatorCreatedCount,
        },
        secFetchedAt: token.secFetchedAt,
        // creator wallet profile if available
        creatorProfile: null,
      });
    }

    // Live fetch
    const chain = CHAIN_MAP[token.chain.toLowerCase()] ?? "sol";
    const proxy = nextProxy();
    const { ok, security, raw } = await fetchTokenSecurity(token.chain, token.address, proxy);

    // Persist to DB
    if (ok) {
      const s = security;
      await db.update(tracked_tokens).set({
        secIsHoneypot:          s.isHoneypot,
        secOwnerRenounced:      s.ownerRenounced,
        secMintRenounced:       s.mintRenounced,
        secFreezeRenounced:     s.freezeRenounced,
        secOpenSource:          s.openSource,
        secTop10HolderRate:     s.top10HolderRate,
        secRugRatio:            s.rugRatio,
        secSniperCount:         s.sniperCount != null ? Math.round(s.sniperCount) : null,
        secCreatorAddress:      s.creatorAddress || null,
        secCreatorClose:        s.creatorClose,
        secCreatorTokenStatus:  s.creatorTokenStatus,
        secBuyTax:              s.buyTax,
        secSellTax:             s.sellTax,
        secLpLocked:            s.lpLocked,
        secLpLockPercent:       s.lpLockPercent,
        secCtoFlag:             s.ctoFlag,
        secBluechipOwnerPct:    s.bluechipOwnerPct,
        secRatTraderAmtRate:    s.ratTraderAmtRate,
        secCreatorCreatedCount: s.creatorCreatedCount != null ? Math.round(s.creatorCreatedCount) : null,
        secFetchedAt:           new Date(),
      }).where(eq(tracked_tokens.id, id));
    }

    // Fetch creator profile if we have an address
    let creatorProfile = null;
    if (security.creatorAddress && security.creatorAddress.length > 8) {
      const cpProxy = nextProxy();
      const [cpRes] = await Promise.all([
        fetchWalletProfile(token.chain, security.creatorAddress, cpProxy),
      ]);
      if (cpRes.ok) creatorProfile = cpRes.data;
    }

    res.json({
      source: ok ? "live" : "partial",
      security,
      secFetchedAt: new Date().toISOString(),
      creatorProfile,
      _raw: raw,
    });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/tokens/:id/traders ──────────────────────────────────────────────
// Top traders for a token, ranked by profit. DB fallback when GMGN blocked.

router.get("/:id/traders", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return void res.status(400).json({ error: "Invalid id" });

    const forceRefresh = req.query.refresh === "1";
    const limit = Math.min(100, parseInt(String(req.query.limit ?? "40"), 10) || 40);

    const [token] = await db
      .select({ address: tracked_tokens.address, chain: tracked_tokens.chain,
                name: tracked_tokens.name, symbol: tracked_tokens.symbol,
                marketCapUsd: tracked_tokens.marketCapUsd })
      .from(tracked_tokens).where(eq(tracked_tokens.id, id)).limit(1);
    if (!token) return void res.status(404).json({ error: "Token not found" });

    // Check DB cache
    const dbTraders = await db.select().from(token_traders)
      .where(eq(token_traders.tokenId, id))
      .orderBy(desc(token_traders.profitUsd))
      .limit(limit);

    const newestFetch = dbTraders[0]?.fetchedAt;
    const cacheAge = newestFetch ? Date.now() - new Date(newestFetch).getTime() : Infinity;
    const stale = cacheAge > 10 * 60_000; // 10 min

    if (!forceRefresh && dbTraders.length > 0 && !stale) {
      return void res.json({
        source: "cache",
        traders: dbTraders,
        fetchedAt: newestFetch,
      });
    }

    // Live GMGN fetch
    const proxy = nextProxy();
    const tradersRes = await fetchTopTraders(token.chain, token.address, proxy, limit);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traderList: unknown[] = (tradersRes.data as any)?.data?.list
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ?? (tradersRes.data as any)?.data ?? [];

    if (tradersRes.ok && Array.isArray(traderList) && traderList.length > 0) {
      const label = [token.name, token.symbol].filter(Boolean).join(" / ") || token.address.slice(0, 8);
      await persistTraders(id, traderList, label);

      // Return freshly-persisted data from DB for consistent shape
      const fresh = await db.select().from(token_traders)
        .where(eq(token_traders.tokenId, id))
        .orderBy(desc(token_traders.profitUsd))
        .limit(limit);

      return void res.json({ source: "live", traders: fresh, fetchedAt: new Date().toISOString() });
    }

    // Fallback to whatever is in DB
    res.json({
      source: dbTraders.length > 0 ? "cache-fallback" : "empty",
      traders: dbTraders,
      fetchedAt: newestFetch ?? null,
      _gmgnStatus: tradersRes.status,
    });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/tokens/:id/history ──────────────────────────────────────────────
// Returns intel score log + price snapshots for postmortem / timeline view.

router.get("/:id/history", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return void res.status(400).json({ error: "Invalid id" });

    const [token] = await db
      .select({
        id:              tracked_tokens.id,
        marketCapUsd:    tracked_tokens.marketCapUsd,
        peakMcUsd:       tracked_tokens.peakMcUsd,
        athMarketCapUsd: tracked_tokens.athMarketCapUsd,
        firstDetectedAt: tracked_tokens.firstDetectedAt,
        status:          tracked_tokens.status,
        gainPct:         tracked_tokens.gainPct,
        athGainPct:      tracked_tokens.athGainPct,
      })
      .from(tracked_tokens).where(eq(tracked_tokens.id, id)).limit(1);
    if (!token) return void res.status(404).json({ error: "Token not found" });

    const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000);

    // Fetch intel log (last 100 entries) and price snapshots (last 48h) in parallel
    const [intelLog, snapshots] = await Promise.all([
      db.select({
        computedAt:           token_intel_log.computedAt,
        intelligenceScore:    token_intel_log.intelligenceScore,
        prevIntelligenceScore: token_intel_log.prevIntelligenceScore,
        mcGrowthScore:         token_intel_log.mcGrowthScore,
        volumeIntensityScore:  token_intel_log.volumeIntensityScore,
        holderVelocityScore:   token_intel_log.holderVelocityScore,
        kolSmartScore:         token_intel_log.kolSmartScore,
        liquidityHealthScore:  token_intel_log.liquidityHealthScore,
        marketCapUsd:          token_intel_log.marketCapUsd,
        holderCount:           token_intel_log.holderCount,
        statusBefore:          token_intel_log.statusBefore,
        statusAfter:           token_intel_log.statusAfter,
        statusChanged:         token_intel_log.statusChanged,
        trigger:               token_intel_log.trigger,
        ageMultiplier:         token_intel_log.ageMultiplier,
        tokenAgeHours:         token_intel_log.tokenAgeHours,
      })
        .from(token_intel_log)
        .where(eq(token_intel_log.tokenId, id))
        .orderBy(desc(token_intel_log.computedAt))
        .limit(100),

      db.select({
        snapshotAt:   tps.snapshotAt,
        marketCapUsd: tps.marketCapUsd,
        priceUsd:     tps.priceUsd,
        liquidityUsd: tps.liquidityUsd,
        volume24hUsd: tps.volume24hUsd,
      })
        .from(tps)
        .where(and(eq(tps.tokenId, id), gte(tps.snapshotAt, since48h)))
        .orderBy(asc(tps.snapshotAt)),
    ]);

    // Decimate snapshots to max 200 points for charting
    const MAX_POINTS = 200;
    const decimated = snapshots.length <= MAX_POINTS
      ? snapshots
      : snapshots.filter((_, i) => i % Math.ceil(snapshots.length / MAX_POINTS) === 0);

    // Rug analysis: find peak from snapshots, measure drawdown and speed
    const currentMc = token.marketCapUsd ? parseFloat(token.marketCapUsd) : 0;
    const peakMcNum = token.peakMcUsd ?? (token.athMarketCapUsd ? parseFloat(token.athMarketCapUsd) : 0) ?? 0;

    let rugAnalysis: {
      peakMcUsd: number | null;
      currentMcUsd: number | null;
      drawdownPct: number | null;
      peakToCurrentHours: number | null;
      rugSeverity: "rug" | "dump" | "decline" | "stable" | "recovering" | "correction" | "stabilizing";
      currentMultiple: number | null;
      athMultiple: number | null;
    } = {
      peakMcUsd: peakMcNum || null,
      currentMcUsd: currentMc || null,
      drawdownPct: null,
      peakToCurrentHours: null,
      rugSeverity: "stable",
      currentMultiple: null,
      athMultiple: null,
    };

    if (peakMcNum > 0 && currentMc > 0) {
      const drawdown = (peakMcNum - currentMc) / peakMcNum;
      const drawdownPct = Math.round(drawdown * 100 * 10) / 10;

      // How much is the token still up from detection entry?
      // gainPct is stored as percentage (e.g. 21100 = 211X). Convert to multiplier.
      const currentMultiple = token.gainPct != null ? (token.gainPct / 100) + 1 : null;
      const athMultiple     = token.athGainPct != null ? (token.athGainPct / 100) + 1 : null;

      // Estimate time from first detected to now
      const totalHours = (Date.now() - token.firstDetectedAt.getTime()) / 3_600_000;

      // Find time of peak in snapshots for better estimate
      let peakSnap: (typeof decimated)[number] | null = null;
      let peakVal = 0;
      for (const s of snapshots) {
        const mc = s.marketCapUsd ? parseFloat(s.marketCapUsd) : 0;
        if (mc > peakVal) { peakVal = mc; peakSnap = s; }
      }
      const hoursFromPeakToNow = peakSnap
        ? (Date.now() - new Date(peakSnap.snapshotAt).getTime()) / 3_600_000
        : null;

      // Severity logic: drawdown-from-peak is modulated by current-vs-entry multiple.
      // A token still 10X+ from entry correcting 60%+ is "stabilizing", not a dump.
      const severity = ((): typeof rugAnalysis.rugSeverity => {
        if (drawdown > 0.85) {
          // >85% off peak: rug if nearly zeroed vs entry, dump if still a big winner
          return (currentMultiple && currentMultiple >= 2) ? "dump" : "rug";
        }
        if (drawdown > 0.60) {
          // >60% off peak but significant winner from entry → post-pump stabilization
          return (currentMultiple && currentMultiple >= 10) ? "stabilizing" : "dump";
        }
        if (drawdown > 0.30) {
          // >30% off peak — healthy correction on a big winner vs genuine decline
          return (currentMultiple && currentMultiple >= 3) ? "correction" : "decline";
        }
        if (drawdown < -0.10) return "recovering"; // still making new highs
        return "stable";
      })();

      rugAnalysis = {
        peakMcUsd: peakMcNum,
        currentMcUsd: currentMc,
        drawdownPct,
        peakToCurrentHours: hoursFromPeakToNow ?? (drawdown > 0.1 ? totalHours : null),
        rugSeverity: severity,
        currentMultiple: currentMultiple ? Math.round(currentMultiple * 10) / 10 : null,
        athMultiple:     athMultiple     ? Math.round(athMultiple     * 10) / 10 : null,
      };
    }

    res.json({
      snapshots: decimated,
      intelLog: intelLog.reverse(), // chronological order for charts
      rugAnalysis,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/tokens/:id/pool ─────────────────────────────────────────────────
// Live pool/DEX info from GMGN (not cached in DB).

router.get("/:id/pool", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return void res.status(400).json({ error: "Invalid id" });

    const [token] = await db
      .select({ address: tracked_tokens.address, chain: tracked_tokens.chain })
      .from(tracked_tokens).where(eq(tracked_tokens.id, id)).limit(1);
    if (!token) return void res.status(404).json({ error: "Token not found" });

    const proxy = nextProxy();
    const poolRes = await fetchTokenPool(token.chain, token.address, proxy);

    res.json({
      ok:       poolRes.ok,
      status:   poolRes.status,
      pool:     poolRes.data,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/tokens/:id/dev ──────────────────────────────────────────────────
// Creator / dev wallet: profile, PnL, all holdings.

router.get("/:id/dev", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return void res.status(400).json({ error: "Invalid id" });

    const [token] = await db
      .select({
        address:           tracked_tokens.address,
        chain:             tracked_tokens.chain,
        secCreatorAddress: tracked_tokens.secCreatorAddress,
        secCreatorClose:   tracked_tokens.secCreatorClose,
        secCreatorTokenStatus: tracked_tokens.secCreatorTokenStatus,
      })
      .from(tracked_tokens).where(eq(tracked_tokens.id, id)).limit(1);
    if (!token) return void res.status(404).json({ error: "Token not found" });

    const creatorAddr = token.secCreatorAddress;

    // Try to get cached profile from wallet_profiles
    let cachedProfile = null;
    if (creatorAddr) {
      const [wp] = await db.select().from(wallet_profiles)
        .where(eq(wallet_profiles.walletAddress, creatorAddr)).limit(1);
      cachedProfile = wp ?? null;
    }

    // If no creator known yet, trigger security fetch
    if (!creatorAddr) {
      const proxy = nextProxy();
      const { security } = await fetchTokenSecurity(token.chain, token.address, proxy);
      if (security.creatorAddress) {
        await db.update(tracked_tokens).set({
          secCreatorAddress: security.creatorAddress,
          secCreatorClose:   security.creatorClose,
          secCreatorTokenStatus: security.creatorTokenStatus,
          secFetchedAt: new Date(),
        }).where(eq(tracked_tokens.id, id));
      }
      return void res.json({
        creatorAddress: security.creatorAddress,
        creatorClose:   security.creatorClose,
        creatorStatus:  security.creatorTokenStatus,
        profile:        null,
        holdings:       null,
        _note: "Profile fetch queued; refresh in 30s",
      });
    }

    // Live fetch: profile + holdings in parallel
    const proxy   = nextProxy();
    const [profileRes, holdingsRes] = await Promise.all([
      fetchWalletProfile(token.chain, creatorAddr, proxy),
      fetchWalletHoldings(token.chain, creatorAddr, proxy, 50),
    ]);

    res.json({
      creatorAddress: creatorAddr,
      creatorClose:   token.secCreatorClose,
      creatorStatus:  token.secCreatorTokenStatus,
      profile:        profileRes.ok ? profileRes.data : cachedProfile,
      holdings:       holdingsRes.ok ? holdingsRes.data : null,
      profileSource:  profileRes.ok ? "live" : (cachedProfile ? "cache" : "unavailable"),
      holdingsSource: holdingsRes.ok ? "live" : "unavailable",
      fetchedAt:      new Date().toISOString(),
    });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/wallets/:address/profile ────────────────────────────────────────
// Wallet profile: labels, PnL stats, token holdings from GMGN.
// Also accessible via /api/tokens/:id/dev for the creator wallet.

router.get("/wallet/:address/profile", async (req, res): Promise<void> => {
  try {
    const { address } = req.params;
    const chain = String(req.query.chain ?? "sol");
    const proxy = nextProxy();

    const [profileRes, holdingsRes] = await Promise.all([
      fetchWalletProfile(chain, address, proxy),
      fetchWalletHoldings(chain, address, proxy, 50),
    ]);

    // Also check our DB for aggregated label history
    const [dbProfile] = await db.select().from(wallet_profiles)
      .where(eq(wallet_profiles.walletAddress, address)).limit(1);

    res.json({
      walletAddress: address,
      chain,
      profile:  profileRes.ok ? profileRes.data : null,
      holdings: holdingsRes.ok ? holdingsRes.data : null,
      dbProfile: dbProfile ?? null,
      profileStatus:  profileRes.status,
      holdingsStatus: holdingsRes.status,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

export default router;
