import { Router } from "express";
import { db } from "@workspace/db";
import { tracked_tokens, token_buys, token_sells, walletdatasource, token_holders } from "@workspace/db";
import { eq, desc, asc, count, sql, and, or, ilike } from "drizzle-orm";
import { fetchLivePrice } from "../pipeline/price-service";
import { gmgnFetch, nextProxy, persistHolders, CHAIN_MAP, fetchAndPersistHolders } from "../lib/gmgn-client";
import { buildHolderIntel } from "../lib/holder-intel";

const router = Router();

// ── Token shape mapper ────────────────────────────────────────────────────────

function mapToken(t: typeof tracked_tokens.$inferSelect) {
  return {
    id:               t.id,
    address:          t.address,
    chain:            t.chain,
    name:             t.name,
    symbol:           t.symbol,
    logoUri:          t.imagePath ? `/api/assets${t.imagePath}` : t.logoUri,
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
    mcGrowthScore:          t.mcGrowthScore,
    volumeIntensityScore:   t.volumeIntensityScore,
    holderVelocityScore:    t.holderVelocityScore,
    kolSmartScore:          t.kolSmartScore,
    liquidityHealthScore:   t.liquidityHealthScore,
    intelligenceUpdatedAt:  t.intelligenceUpdatedAt?.toISOString() ?? null,
    consecutivePositiveChecks: t.consecutivePositiveChecks,
    peakMcUsd:              t.peakMcUsd,
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

router.get("/", async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  ?? "1"),  10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
    const status = String(req.query.status ?? "all");
    const sort   = String(req.query.sort   ?? "firstDetectedAt");
    const order  = String(req.query.order  ?? "desc") === "asc" ? "asc" : "desc";
    const offset = (page - 1) * limit;

    const q     = String(req.query.q     ?? "").trim();
    const chain = String(req.query.chain ?? "").trim();

    // Build WHERE conditions
    const VALID_STATUSES = ["new", "active", "watch", "archive", "revived"];
    const conditions = [];

    if (status === "migrated") {
      conditions.push(eq(tracked_tokens.migrated, true));
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
    res.status(500).json({ error: String(err) });
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

router.post("/:id/refresh", async (req, res) => {
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

    if (!token) return res.status(404).json({ error: "Token not found" });

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
      return res.status(502).json({
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
    res.status(500).json({ error: String(err) });
  }
});

// ── Mark / unmark a token as migrated ────────────────────────────────────────
//
//   PATCH /api/tokens/:id/migrate   { migrated: true | false }

router.patch("/:id/migrate", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const migrated = req.body?.migrated === true || req.body?.migrated === "true";

    const [updated] = await db
      .update(tracked_tokens)
      .set({ migrated })
      .where(eq(tracked_tokens.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: "Token not found" });

    res.json({ ok: true, id, migrated: updated.migrated });
  } catch (err) {
    res.status(500).json({ error: String(err) });
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

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const [token] = await db.select().from(tracked_tokens).where(eq(tracked_tokens.id, id)).limit(1);
    if (!token) return res.status(404).json({ error: "Token not found" });

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
    res.status(500).json({ error: String(err) });
  }
});

// ── GMGN Intel proxy ──────────────────────────────────────────────────────────
// gmgnFetch, nextProxy, CHAIN_MAP, and persistHolders are imported from
// ../lib/gmgn-client (shared with the background holders-refresh pipeline).

router.get("/:id/gmgn", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

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

    if (!token) return res.status(404).json({ error: "Token not found" });

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
    res.status(500).json({ error: String(err) });
  }
});

export default router;
