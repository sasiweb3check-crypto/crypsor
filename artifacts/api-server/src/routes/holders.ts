import { Router } from "express";
import { db } from "@workspace/db";
import { token_holders, tracked_tokens, token_holder_snapshots } from "@workspace/db";
import { count, countDistinct, eq, sql, and, or, ilike, desc } from "drizzle-orm";
import { fetchAndPersistHolders } from "../lib/gmgn-client";
import { logger } from "../lib/logger";

const router = Router();

// ── GET /api/holders ──────────────────────────────────────────────────────────
// Total holder stats across the whole DB (for dashboard stat card)

router.get("/", async (_req, res) => {
  try {
    const [totalRows]       = await db.select({ c: count() }).from(token_holders);
    const [distinctWallets] = await db.select({ c: countDistinct(token_holders.walletAddress) }).from(token_holders);

    res.json({
      totalHolders:    Number(totalRows?.c    ?? 0),
      distinctWallets: Number(distinctWallets?.c ?? 0),
    });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/holders/stats-by-token ───────────────────────────────────────────
// Per-token aggregates used to render wallet intel chips in token cards

router.get("/stats-by-token", async (_req, res) => {
  try {
    const raw = await db.execute(sql`
      SELECT
        token_id,
        COUNT(*)::text AS total_count,
        SUM(CASE WHEN labels && ARRAY['kol','renowned']::text[]            THEN 1 ELSE 0 END)::text AS kol_count,
        SUM(CASE WHEN labels && ARRAY['smart_money','smart_degen']::text[] THEN 1 ELSE 0 END)::text AS smart_count,
        SUM(CASE WHEN labels && ARRAY['bundler']::text[]                   THEN 1 ELSE 0 END)::text AS bundler_count,
        SUM(CASE WHEN labels && ARRAY['fresh_wallet']::text[]              THEN 1 ELSE 0 END)::text AS fresh_count,
        SUM(CASE WHEN labels && ARRAY['sniper','snipe_bot']::text[]        THEN 1 ELSE 0 END)::text AS sniper_count,
        SUM(CASE WHEN labels && ARRAY['bot_degen','rat_trader','fomo','sandwich_bot','dex_bot','paper_hands']::text[] THEN 1 ELSE 0 END)::text AS bot_degen_count,
        SUM(CASE WHEN labels && ARRAY['axiom','gmgn','padre','trojan','photon','bullx','pepeboost','maestro','bonkbot','banana_gun','bloom_trading','nova']::text[] THEN 1 ELSE 0 END)::text AS tracking_count,
        SUM(CASE WHEN labels && ARRAY['dev','dev_team','creator']::text[]  THEN 1 ELSE 0 END)::text AS dev_count,
        SUM(CASE WHEN labels && ARRAY['insider']::text[]                   THEN 1 ELSE 0 END)::text AS insider_count,
        SUM(CASE WHEN amount_percentage >= 2                               THEN 1 ELSE 0 END)::text AS two_pct_count,
        SUM(amount_percentage)::text                                                          AS total_supply_pct,
        SUM(CAST(NULLIF(cost_usd, '') AS NUMERIC))::text                                      AS total_invested_usd
      FROM token_holders
      GROUP BY token_id
    `);

    const resultRows = (
      (raw as unknown as { rows?: unknown[] }).rows ?? raw
    ) as Array<{
      token_id: string;
      total_count: string;
      kol_count: string;
      smart_count: string;
      bundler_count: string;
      fresh_count: string;
      sniper_count: string;
      bot_degen_count: string;
      tracking_count: string;
      dev_count: string;
      insider_count: string;
      two_pct_count: string;
      total_supply_pct: string | null;
      total_invested_usd: string | null;
    }>;

    const stats: Record<number, {
      totalCount: number; kolCount: number; smartCount: number;
      bundlerCount: number; freshCount: number; sniperCount: number;
      botDegenCount: number; trackingCount: number; devCount: number;
      insiderCount: number; twoPctCount: number;
      totalSupplyPct: number; totalInvestedUsd: number;
    }> = {};

    for (const r of Array.isArray(resultRows) ? resultRows : []) {
      stats[Number(r.token_id)] = {
        totalCount:       Number(r.total_count       ?? 0),
        kolCount:         Number(r.kol_count         ?? 0),
        smartCount:       Number(r.smart_count       ?? 0),
        bundlerCount:     Number(r.bundler_count     ?? 0),
        freshCount:       Number(r.fresh_count       ?? 0),
        sniperCount:      Number(r.sniper_count      ?? 0),
        botDegenCount:    Number(r.bot_degen_count   ?? 0),
        trackingCount:    Number(r.tracking_count    ?? 0),
        devCount:         Number(r.dev_count         ?? 0),
        insiderCount:     Number(r.insider_count     ?? 0),
        twoPctCount:      Number(r.two_pct_count     ?? 0),
        totalSupplyPct:   parseFloat(r.total_supply_pct   ?? "0") || 0,
        totalInvestedUsd: parseFloat(r.total_invested_usd ?? "0") || 0,
      };
    }

    res.json(stats);
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/holders/download ─────────────────────────────────────────────────
// CSV export of all stored holders with token context

router.get("/download", async (_req, res) => {
  try {
    const rows = await db
      .select({
        walletAddress:        token_holders.walletAddress,
        twitterName:          token_holders.twitterName,
        twitterUsername:      token_holders.twitterUsername,
        labels:               token_holders.labels,
        amountPercentage:     token_holders.amountPercentage,
        costUsd:              token_holders.costUsd,
        realizedProfit:       token_holders.realizedProfit,
        buyCount:             token_holders.buyCount,
        sellCount:            token_holders.sellCount,
        snapshotMarketCapUsd: token_holders.snapshotMarketCapUsd,
        fetchedAt:            token_holders.fetchedAt,
        tokenAddress:         tracked_tokens.address,
        tokenName:            tracked_tokens.name,
        tokenSymbol:          tracked_tokens.symbol,
        tokenChain:           tracked_tokens.chain,
      })
      .from(token_holders)
      .leftJoin(tracked_tokens, eq(token_holders.tokenId, tracked_tokens.id))
      .orderBy(token_holders.fetchedAt);

    const q = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;

    const headers = [
      "wallet_address","twitter_name","twitter_username","labels",
      "supply_pct","cost_usd","realized_profit","buy_count","sell_count",
      "snapshot_market_cap_usd","token_address","token_name","token_symbol","token_chain","fetched_at",
    ];

    const csv = [
      headers.join(","),
      ...rows.map(r => [
        q(r.walletAddress),
        q(r.twitterName   ?? ""),
        q(r.twitterUsername ?? ""),
        q((r.labels ?? []).join(";")),
        q(String(r.amountPercentage ?? "")),
        q(r.costUsd          ?? ""),
        q(r.realizedProfit   ?? ""),
        q(String(r.buyCount  ?? 0)),
        q(String(r.sellCount ?? 0)),
        q(r.snapshotMarketCapUsd ?? ""),
        q(r.tokenAddress ?? ""),
        q(r.tokenName    ?? ""),
        q(r.tokenSymbol  ?? ""),
        q(r.tokenChain   ?? ""),
        q(r.fetchedAt?.toISOString() ?? ""),
      ].join(",")),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="holders-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/holders/list ─────────────────────────────────────────────────────
// Paginated, label-filtered holder browser across all tokens

const LABEL_GROUPS: Record<string, string[]> = {
  kol:        ["kol", "renowned"],
  smart:      ["smart_money", "smart_degen"],
  sniper:     ["sniper", "snipe_bot"],
  bundler:    ["bundler"],
  fresh:      ["fresh_wallet"],
  bot_degen:  ["bot_degen", "rat_trader", "fomo", "sandwich_bot", "dex_bot", "paper_hands"],
  insider:    ["insider"],
  dev:        ["dev", "dev_team", "creator"],
  bluechip:   ["bluechip_owner"],
  whale:      ["whale"],
  tracking:   ["axiom", "gmgn", "padre", "trojan", "photon", "bullx", "pepeboost",
               "maestro", "bonkbot", "banana_gun", "bloom_trading", "nova"],
};

router.get("/list", async (req, res): Promise<void> => {
  try {
    const page    = Math.max(1, parseInt(String(req.query.page  ?? "1"),  10) || 1);
    const limit   = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
    const label   = String(req.query.label ?? "").trim().toLowerCase();
    const q       = String(req.query.q     ?? "").trim();
    const tokenId = req.query.tokenId ? parseInt(String(req.query.tokenId), 10) : null;
    const offset  = (page - 1) * limit;

    const conditions: ReturnType<typeof eq>[] = [];

    if (tokenId && !isNaN(tokenId)) {
      conditions.push(eq(token_holders.tokenId, tokenId) as unknown as ReturnType<typeof eq>);
    }

    if (label && LABEL_GROUPS[label]) {
      const tags = LABEL_GROUPS[label];
      conditions.push(
        sql`${token_holders.labels} && ARRAY[${sql.raw(tags.map(t => `'${t}'`).join(","))}]::text[]` as unknown as ReturnType<typeof eq>
      );
    }

    if (q) {
      conditions.push(
        or(
          ilike(token_holders.walletAddress, `%${q}%`),
          ilike(token_holders.twitterUsername, `%${q}%`),
          ilike(token_holders.twitterName, `%${q}%`),
        )! as unknown as ReturnType<typeof eq>
      );
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult, rows] = await Promise.all([
      db.select({ total: count() }).from(token_holders).where(where),
      db.select({
          id:               token_holders.id,
          tokenId:          token_holders.tokenId,
          walletAddress:    token_holders.walletAddress,
          twitterName:      token_holders.twitterName,
          twitterUsername:  token_holders.twitterUsername,
          labels:           token_holders.labels,
          amountPercentage: token_holders.amountPercentage,
          balance:          token_holders.balance,
          costUsd:          token_holders.costUsd,
          realizedProfit:   token_holders.realizedProfit,
          unrealizedProfit: token_holders.unrealizedProfit,
          buyCount:         token_holders.buyCount,
          sellCount:        token_holders.sellCount,
          fetchedAt:        token_holders.fetchedAt,
          snapshotMarketCapUsd: token_holders.snapshotMarketCapUsd,
          // token context
          tokenAddress:  tracked_tokens.address,
          tokenName:     tracked_tokens.name,
          tokenSymbol:   tracked_tokens.symbol,
          tokenChain:    tracked_tokens.chain,
          tokenStatus:   tracked_tokens.status,
          tokenLogoUri:  tracked_tokens.logoUri,
        })
        .from(token_holders)
        .leftJoin(tracked_tokens, eq(token_holders.tokenId, tracked_tokens.id))
        .where(where)
        .orderBy(token_holders.fetchedAt)
        .limit(limit)
        .offset(offset),
    ]);

    const total = Number(countResult[0]?.total ?? 0);

    // Attach token count per wallet — how many distinct tokens this wallet appears in.
    // Used by the frontend to show "in N tokens" badge without duplicating addresses.
    let tokenCountMap: Record<string, number> = {};
    if (rows.length > 0) {
      const uniqueAddrs = [...new Set(rows.map(r => r.walletAddress))];
      try {
        const tcRaw = await db.execute(sql`
          SELECT wallet_address, COUNT(DISTINCT token_id)::int AS token_count
          FROM token_holders
          WHERE wallet_address = ANY(${uniqueAddrs})
          GROUP BY wallet_address
        `);
        const tcRows = ((tcRaw as unknown as { rows?: { wallet_address: string; token_count: number }[] }).rows
          ?? tcRaw as unknown as { wallet_address: string; token_count: number }[]);
        for (const r of tcRows) {
          tokenCountMap[r.wallet_address] = Number(r.token_count);
        }
      } catch {
        // Non-fatal — tokenCount falls back to 1
      }
    }

    res.json({
      data:  rows.map(r => ({ ...r, tokenCount: tokenCountMap[r.walletAddress] ?? 1 })),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasLabel(labels: string[] | null, matches: string[]): boolean {
  return (labels ?? []).some(l => matches.includes(l));
}

const LABEL_MAP: Record<string, string[]> = {
  kol:        ["kol", "renowned"],
  smart:      ["smart_money", "smart_degen"],
  sniper:     ["sniper", "snipe_bot"],
  bundler:    ["bundler"],
  fresh:      ["fresh_wallet"],
  bot_degen:  ["bot_degen", "rat_trader", "fomo", "sandwich_bot", "dex_bot", "paper_hands"],
  insider:    ["insider"],
  dev:        ["dev", "dev_team", "creator"],
  bluechip:   ["bluechip_owner"],
  tracking:   ["axiom", "gmgn", "padre", "trojan", "photon", "bullx", "pepeboost",
               "maestro", "bonkbot", "banana_gun", "bloom_trading", "nova"],
};

// ── GET /api/holders/token/:tokenId ──────────────────────────────────────────
// Latest holder data for a specific token.
//
// Strategy (snapshot-first with flat-table fallback):
//   1. Prefer data from token_holder_snapshots (latest snapshot).
//      This surfaces the rich GMGN JSONB payload plus pre-computed summary stats.
//   2. Fall back to the flat token_holders table when no snapshot exists yet.
//   3. If both are empty, trigger an on-demand bootstrap fetch.
//
// Response shape is backward-compatible with the previous flat-table version.

router.get("/token/:tokenId", async (req, res): Promise<void> => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (isNaN(tokenId)) return void res.status(400).json({ error: "Invalid tokenId" });

    const labelKey = String(req.query.label ?? "").trim().toLowerCase();

    // ── 1. Try latest snapshot ────────────────────────────────────────────────
    const [latestSnap] = await db
      .select()
      .from(token_holder_snapshots)
      .where(eq(token_holder_snapshots.tokenId, tokenId))
      .orderBy(desc(token_holder_snapshots.snapshotAt))
      .limit(1);

    if (latestSnap && Array.isArray(latestSnap.holdersData) && latestSnap.holdersData.length > 0) {
      type SnapHolder = {
        address?: string; account_address?: string;
        twitter_name?: string | null; twitter_username?: string | null;
        tags?: string[]; maker_token_tags?: string[];
        amount_percentage?: number | null; balance?: number | null;
        cost_usd?: number | null; realized_profit?: number | null;
        unrealized_profit?: number | null;
        buy_tx_count_cur?: number | null; buy_count?: number | null;
        sell_tx_count_cur?: number | null; sell_count?: number | null;
      };

      // Normalize raw GMGN snake_case payload → camelCase shape with merged labels.
      // This is required because the frontend expects DbHolder shape (camelCase, labels[]).
      function normalizeSnapHolder(h: SnapHolder) {
        const rawLabels = [...(h.tags ?? []), ...(h.maker_token_tags ?? [])];
        const labels = [...new Set(rawLabels.filter(Boolean))];
        return {
          walletAddress:    (h.address?.trim() || h.account_address?.trim()) ?? "",
          twitterName:      h.twitter_name  ?? null,
          twitterUsername:  h.twitter_username ?? null,
          labels,
          amountPercentage: h.amount_percentage ?? null,
          balance:          h.balance != null ? String(h.balance) : null,
          costUsd:          h.cost_usd      != null ? String(h.cost_usd)           : null,
          realizedProfit:   h.realized_profit != null ? String(h.realized_profit)  : null,
          unrealizedProfit: h.unrealized_profit != null ? String(h.unrealized_profit) : null,
          buyCount:         h.buy_tx_count_cur  ?? h.buy_count  ?? 0,
          sellCount:        h.sell_tx_count_cur ?? h.sell_count ?? 0,
        };
      }

      const rawHolders  = latestSnap.holdersData as SnapHolder[];
      const allHolders  = rawHolders.map(normalizeSnapHolder);

      const BOT_DEGEN_TAGS = ["bot_degen","rat_trader","fomo","sandwich_bot","dex_bot","paper_hands"];
      const TRACKING_TAGS  = ["axiom","gmgn","padre","trojan","photon","bullx","pepeboost","maestro","bonkbot","banana_gun","bloom_trading","nova"];
      const stats = {
        smartCount:       allHolders.filter(h => hasLabel(h.labels, ["smart_money", "smart_degen"])).length,
        kolCount:         allHolders.filter(h => hasLabel(h.labels, ["kol", "renowned"])).length,
        sniperCount:      allHolders.filter(h => hasLabel(h.labels, ["sniper", "snipe_bot"])).length,
        bundlerCount:     allHolders.filter(h => hasLabel(h.labels, ["bundler"])).length,
        freshCount:       allHolders.filter(h => hasLabel(h.labels, ["fresh_wallet"])).length,
        botDegenCount:    allHolders.filter(h => hasLabel(h.labels, BOT_DEGEN_TAGS)).length,
        trackingCount:    allHolders.filter(h => hasLabel(h.labels, TRACKING_TAGS)).length,
        insiderCount:     allHolders.filter(h => hasLabel(h.labels, ["insider"])).length,
        devCount:         allHolders.filter(h => hasLabel(h.labels, ["dev","dev_team","creator"])).length,
        bluechipCount:    allHolders.filter(h => hasLabel(h.labels, ["bluechip_owner"])).length,
        twoPctCount:      allHolders.filter(h => (h.amountPercentage ?? 0) >= 2).length,
        totalSupplyPct:   allHolders.reduce((s, h) => s + (h.amountPercentage ?? 0), 0),
        totalInvestedUsd: allHolders.reduce((s, h) => s + (h.costUsd ? parseFloat(h.costUsd) || 0 : 0), 0),
        totalCount:       allHolders.length,
        // Snapshot-specific summary
        top10Pct:         Number(latestSnap.top10Pct ?? 0),
        smartMoneyCount:  latestSnap.smartMoneyCount ?? 0,
        devHoldPct:       Number(latestSnap.devHoldPct ?? 0),
        totalPnl:         Number(latestSnap.totalPnl ?? 0),
      };

      const labelMatches = labelKey ? (LABEL_MAP[labelKey] ?? [labelKey]) : null;
      const filtered = labelMatches
        ? allHolders.filter(h => hasLabel(h.labels, labelMatches))
        : allHolders;

      return void res.json({
        holders:        filtered,
        stats,
        lastSyncedAt:   latestSnap.snapshotAt.toISOString(),
        count:          allHolders.length,
        total:          filtered.length,
        page:           1,
        pages:          1,
        snapshotId:     latestSnap.id,
        snapshotType:   latestSnap.snapshotType,
        snapshotMcUsd:  latestSnap.snapshotMarketCapUsd,
        _source:        "snapshot",
      });
    }

    // ── 2. Fall back to flat token_holders table ──────────────────────────────
    let allHolders = await db.select().from(token_holders)
      .where(eq(token_holders.tokenId, tokenId));

    // ── 3. On-demand bootstrap if both are empty ──────────────────────────────
    if (allHolders.length === 0) {
      try {
        const [token] = await db
          .select({ id: tracked_tokens.id, address: tracked_tokens.address,
                    chain: tracked_tokens.chain, name: tracked_tokens.name,
                    symbol: tracked_tokens.symbol, marketCapUsd: tracked_tokens.marketCapUsd })
          .from(tracked_tokens)
          .where(eq(tracked_tokens.id, tokenId))
          .limit(1);

        if (token) {
          await fetchAndPersistHolders(token);
          allHolders = await db.select().from(token_holders)
            .where(eq(token_holders.tokenId, tokenId));
        }
      } catch (err) {
        logger.warn({ err, tokenId }, "holders/token: on-demand bootstrap fetch failed (non-fatal)");
      }
    }

    // Build stats from flat table
    const BOT_DEGEN_TAGS2 = ["bot_degen","rat_trader","fomo","sandwich_bot","dex_bot","paper_hands"];
    const TRACKING_TAGS2  = ["axiom","gmgn","padre","trojan","photon","bullx","pepeboost","maestro","bonkbot","banana_gun","bloom_trading","nova"];
    const stats = {
      smartCount:       allHolders.filter(h => hasLabel(h.labels, ["smart_money", "smart_degen"])).length,
      kolCount:         allHolders.filter(h => hasLabel(h.labels, ["kol", "renowned"])).length,
      sniperCount:      allHolders.filter(h => hasLabel(h.labels, ["sniper", "snipe_bot"])).length,
      bundlerCount:     allHolders.filter(h => hasLabel(h.labels, ["bundler"])).length,
      freshCount:       allHolders.filter(h => hasLabel(h.labels, ["fresh_wallet"])).length,
      botDegenCount:    allHolders.filter(h => hasLabel(h.labels, BOT_DEGEN_TAGS2)).length,
      trackingCount:    allHolders.filter(h => hasLabel(h.labels, TRACKING_TAGS2)).length,
      insiderCount:     allHolders.filter(h => hasLabel(h.labels, ["insider"])).length,
      devCount:         allHolders.filter(h => hasLabel(h.labels, ["dev","dev_team","creator"])).length,
      bluechipCount:    allHolders.filter(h => hasLabel(h.labels, ["bluechip_owner"])).length,
      twoPctCount:      allHolders.filter(h => (h.amountPercentage ?? 0) >= 2).length,
      totalSupplyPct:   allHolders.reduce((s, h) => s + (h.amountPercentage ?? 0), 0),
      totalInvestedUsd: allHolders.reduce((s, h) => s + (h.costUsd ? parseFloat(h.costUsd) || 0 : 0), 0),
      totalCount:       allHolders.length,
    };

    const lastSyncedAt = allHolders.length > 0
      ? allHolders.reduce((latest, h) =>
          h.fetchedAt > latest ? h.fetchedAt : latest,
          allHolders[0].fetchedAt,
        ).toISOString()
      : null;

    const labelMatches = labelKey ? (LABEL_MAP[labelKey] ?? [labelKey]) : null;
    const filtered = labelMatches
      ? allHolders.filter(h => hasLabel(h.labels, labelMatches))
      : allHolders;

    res.json({
      holders:     filtered,
      stats,
      lastSyncedAt,
      count:       allHolders.length,
      total:       filtered.length,
      page:        1,
      pages:       1,
      _source:     "flat_table",
    });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/holders/token/:tokenId/history ───────────────────────────────────
// Paginated list of holder snapshots for a specific token, newest first.
// Each entry includes summary stats and metadata but NOT the full holders_data
// (to keep response sizes reasonable — fetch individual snapshot for full data).

router.get("/token/:tokenId/history", async (req, res): Promise<void> => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (isNaN(tokenId)) return void res.status(400).json({ error: "Invalid tokenId" });

    const page  = Math.max(1, parseInt(String(req.query.page  ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
    const offset = (page - 1) * limit;

    const [countResult, snapshots] = await Promise.all([
      db.select({ total: count() })
        .from(token_holder_snapshots)
        .where(eq(token_holder_snapshots.tokenId, tokenId)),

      db.select({
        id:                   token_holder_snapshots.id,
        tokenId:              token_holder_snapshots.tokenId,
        snapshotAt:           token_holder_snapshots.snapshotAt,
        snapshotType:         token_holder_snapshots.snapshotType,
        holderCount:          token_holder_snapshots.holderCount,
        top10Pct:             token_holder_snapshots.top10Pct,
        smartMoneyCount:      token_holder_snapshots.smartMoneyCount,
        devHoldPct:           token_holder_snapshots.devHoldPct,
        totalPnl:             token_holder_snapshots.totalPnl,
        fetchedTopCount:      token_holder_snapshots.fetchedTopCount,
        snapshotMarketCapUsd: token_holder_snapshots.snapshotMarketCapUsd,
        // Intentionally exclude holdersData + rawGmgnPayload (too large for list)
      })
        .from(token_holder_snapshots)
        .where(eq(token_holder_snapshots.tokenId, tokenId))
        .orderBy(desc(token_holder_snapshots.snapshotAt))
        .limit(limit)
        .offset(offset),
    ]);

    const total = Number(countResult[0]?.total ?? 0);

    res.json({
      data:  snapshots,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    return void res.status(500).json({ error: String(err) });
  }
});

export default router;
