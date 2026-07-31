/**
 * Best Calls API — lightweight FOMO-style desk
 *
 * GET /api/calls/feed   — ranked call cards (wallet quality, MC-agnostic)
 * GET /api/calls/stats  — win rate · highest X · signals · avg X
 * GET /api/calls/token/:id — single card detail
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { apiFail, apiOk } from "../lib/api-envelope";
import { proCacheGet, proCacheSet, toIsoUtc } from "../lib/pro-cache";
import { extractSocials } from "../lib/socials";
import { computeCallQuality, type CallQualityLabel } from "../lib/call-quality";

const router = Router();

function resolveLogoUri(imagePath: unknown, logoUri: unknown): string | null {
  const external = logoUri != null ? String(logoUri).trim() : "";
  if (/^https?:\/\//i.test(external)) return external;
  const path = imagePath != null ? String(imagePath).trim() : "";
  if (path) {
    const rel = path.startsWith("/api/assets")
      ? path
      : `/api/assets${path.startsWith("/") ? path : `/${path}`}`;
    const base = (
      process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || ""
    ).replace(/\/$/, "");
    return base ? `${base}${rel}` : rel;
  }
  return external || null;
}

export type CallCard = {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  calledAt: string | null;
  calledMcUsd: number | null;
  currentMcUsd: number | null;
  athMcUsd: number | null;
  gainPct: number | null;
  nowMultiple: number;
  athMultiple: number;
  walletBuys: number;
  buyVolumeHintUsd: number | null;
  calledKol: number;
  calledSmart: number;
  liveKol: number;
  liveSmart: number;
  holderCount: number | null;
  avgWalletWinRate: number | null;
  holderQualityScore: number | null;
  proScore: number;
  qualityLabel: string;
  callScore: number;
  callLabel: CallQualityLabel;
  reasons: string[];
  hit2x: boolean;
  hit5x: boolean;
  hit10x: boolean;
  volume24hUsd: number | null;
  tokenAgeMin: number | null;
  ctoFlag: boolean | null;
  creatorClose: boolean | null;
  creatorAddress: string | null;
  creatorCreatedCount: number | null;
  socials: { twitter?: string; telegram?: string; website?: string };
};

async function loadCallCards(limit: number): Promise<{ cards: CallCard[]; universe: number }> {
  const cacheKey = `calls:feed:v4:${limit}`;
  const cached = await proCacheGet<{ cards: CallCard[]; universe: number }>(cacheKey);
  if (cached?.cards?.length) return cached;

  const universeRow = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM tracked_tokens
    WHERE COALESCE(status, '') NOT IN ('ignored', 'archive')
  `);
  const universe = Number((universeRow.rows[0] as { n?: number })?.n ?? 0);

  // Keep this query light — heavy LATERAL (regex notional + win_rate joins)
  // was timing out on cold DB and left the Best Calls cards empty.
  const rows = await db.execute(sql`
    SELECT
      pc.token_id,
      pc.called_at,
      pc.called_mc_usd,
      pc.called_kol_count,
      pc.called_smart_count,
      pc.ath_multiple,
      pc.pro_score,
      pc.quality_label,
      pc.hit_2x, pc.hit_5x, pc.hit_10x,
      pc.surfaced_at,
      t.address, t.chain, t.name, t.symbol, t.logo_uri, t.image_path,
      t.market_cap_usd, t.ath_market_cap_usd, t.volume_24h_usd,
      t.raw_metadata, t.holder_count,
      t.holder_kol_count AS live_kol,
      t.holder_smart_count AS live_smart,
      t.holder_quality_score,
      t.holder_velocity_score,
      t.sec_is_honeypot,
      t.sec_cto_flag,
      t.sec_creator_close,
      t.sec_creator_address,
      t.sec_creator_created_count,
      t.token_created_at,
      t.first_detected_at,
      COALESCE(buys.wallet_buys, 0)::int AS wallet_buys,
      NULL::float8 AS buy_notional,
      buys.avg_win_rate AS avg_win_rate
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT tb.wallet_id)::int AS wallet_buys,
        AVG(wp.win_rate) FILTER (WHERE wp.win_rate IS NOT NULL) AS avg_win_rate
      FROM token_buys tb
      LEFT JOIN walletdatasource w ON w.id = tb.wallet_id
      LEFT JOIN wallet_profiles wp ON wp.wallet_address = w.address
      WHERE tb.token_id = pc.token_id
    ) buys ON TRUE
    WHERE COALESCE(t.status, '') NOT IN ('ignored', 'archive')
      AND (
        pc.surfaced_at IS NOT NULL
        OR pc.quality_label IN ('very_good', 'good')
        OR COALESCE(buys.wallet_buys, 0) >= 2
      )
    ORDER BY pc.called_at DESC NULLS LAST
    LIMIT 200
  `);

  const cards: CallCard[] = (rows.rows as Array<Record<string, unknown>>).map(r => {
    const calledMc = r.called_mc_usd != null ? parseFloat(String(r.called_mc_usd)) : null;
    const currentMc = r.market_cap_usd != null ? parseFloat(String(r.market_cap_usd)) || null : null;
    const athMcRaw = r.ath_market_cap_usd != null ? parseFloat(String(r.ath_market_cap_usd)) : null;
    const athMultiple = Number(r.ath_multiple ?? 1) || 1;
    const athMc = athMcRaw && athMcRaw > 0
      ? athMcRaw
      : (calledMc && athMultiple > 1 ? calledMc * athMultiple : currentMc);
    const gainPct = calledMc && currentMc && calledMc > 0
      ? ((currentMc - calledMc) / calledMc) * 100
      : null;
    const nowMultiple = calledMc && currentMc && calledMc > 0
      ? Math.round((currentMc / calledMc) * 100) / 100
      : 1;
    const walletBuys = Number(r.wallet_buys ?? 0);
    const avgWr = r.avg_win_rate != null ? Number(r.avg_win_rate) : null;
    const ctoFlag = r.sec_cto_flag == null ? null : Boolean(r.sec_cto_flag);
    const creatorClose = r.sec_creator_close == null ? null : Boolean(r.sec_creator_close);
    const creatorCreatedCount = r.sec_creator_created_count != null
      ? Number(r.sec_creator_created_count)
      : null;

    const q = computeCallQuality({
      walletBuys,
      calledKol: Number(r.called_kol_count ?? 0),
      calledSmart: Number(r.called_smart_count ?? 0),
      liveKol: Number(r.live_kol ?? 0),
      liveSmart: Number(r.live_smart ?? 0),
      holderQualityScore: r.holder_quality_score != null ? Number(r.holder_quality_score) : null,
      holderVelocityScore: r.holder_velocity_score != null ? Number(r.holder_velocity_score) : null,
      avgWalletWinRate: avgWr != null && Number.isFinite(avgWr) ? avgWr : null,
      proScore: Number(r.pro_score ?? 0),
      qualityLabel: String(r.quality_label ?? ""),
      athMultiple,
      honeypot: r.sec_is_honeypot as boolean | null,
      ctoFlag,
      creatorClose,
      creatorCreatedCount,
    });

    const ageSrc = r.token_created_at ?? r.first_detected_at;
    const firstSeen = ageSrc ? new Date(String(ageSrc)).getTime() : null;
    const tokenAgeMin = firstSeen != null && Number.isFinite(firstSeen)
      ? Math.max(0, Math.round((Date.now() - firstSeen) / 60_000))
      : null;

    const buyNotional = r.buy_notional != null ? Number(r.buy_notional) : null;

    return {
      id: Number(r.token_id),
      address: String(r.address),
      chain: String(r.chain ?? "solana"),
      name: (r.name as string | null) ?? null,
      symbol: (r.symbol as string | null) ?? null,
      logoUri: resolveLogoUri(r.image_path, r.logo_uri),
      calledAt: toIsoUtc(r.called_at ?? r.surfaced_at),
      calledMcUsd: calledMc,
      currentMcUsd: currentMc,
      athMcUsd: athMc,
      gainPct,
      nowMultiple,
      athMultiple: Math.round(athMultiple * 100) / 100,
      walletBuys,
      buyVolumeHintUsd: buyNotional != null && buyNotional > 0
        ? Math.round(buyNotional)
        : null,
      calledKol: Number(r.called_kol_count ?? 0),
      calledSmart: Number(r.called_smart_count ?? 0),
      liveKol: Number(r.live_kol ?? 0),
      liveSmart: Number(r.live_smart ?? 0),
      holderCount: r.holder_count != null ? Number(r.holder_count) : null,
      avgWalletWinRate: avgWr != null && Number.isFinite(avgWr)
        ? Math.round(avgWr * 1000) / 1000
        : null,
      holderQualityScore: r.holder_quality_score != null ? Number(r.holder_quality_score) : null,
      proScore: Number(r.pro_score ?? 0),
      qualityLabel: String(r.quality_label ?? "—"),
      callScore: q.score,
      callLabel: q.label,
      reasons: q.reasons,
      hit2x: Boolean(r.hit_2x) || athMultiple >= 2,
      hit5x: Boolean(r.hit_5x) || athMultiple >= 5,
      hit10x: Boolean(r.hit_10x) || athMultiple >= 10,
      volume24hUsd: r.volume_24h_usd != null ? parseFloat(String(r.volume_24h_usd)) || null : null,
      tokenAgeMin,
      ctoFlag,
      creatorClose,
      creatorAddress: r.sec_creator_address != null ? String(r.sec_creator_address) : null,
      creatorCreatedCount,
      socials: extractSocials(r.raw_metadata),
    };
  });

  // Rank: elite/strong first, then score, then freshness
  const rank = (c: CallCard) => {
    const tier = c.callLabel === "elite" ? 0 : c.callLabel === "strong" ? 1 : c.callLabel === "watch" ? 2 : 3;
    return tier * 1000 - c.callScore;
  };
  cards.sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (b.calledAt ?? "").localeCompare(a.calledAt ?? "");
  });

  const sliced = cards.slice(0, limit);
  const payload = { cards: sliced, universe };
  await proCacheSet(cacheKey, payload, 8);
  return payload;
}

/** Ultra-light fallback when buy-join path times out — cards still load. */
async function loadCallCardsLite(limit: number): Promise<{ cards: CallCard[]; universe: number }> {
  const universeRow = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM tracked_tokens
    WHERE COALESCE(status, '') NOT IN ('ignored', 'archive')
  `);
  const universe = Number((universeRow.rows[0] as { n?: number })?.n ?? 0);
  const rows = await db.execute(sql`
    SELECT
      pc.token_id, pc.called_at, pc.called_mc_usd,
      pc.called_kol_count, pc.called_smart_count,
      pc.ath_multiple, pc.pro_score, pc.quality_label,
      pc.hit_2x, pc.hit_5x, pc.hit_10x, pc.surfaced_at,
      t.address, t.chain, t.name, t.symbol, t.logo_uri, t.image_path,
      t.market_cap_usd, t.ath_market_cap_usd, t.volume_24h_usd,
      t.raw_metadata, t.holder_count,
      t.holder_kol_count AS live_kol, t.holder_smart_count AS live_smart,
      t.holder_quality_score, t.holder_velocity_score, t.sec_is_honeypot,
      t.sec_cto_flag, t.sec_creator_close, t.sec_creator_address,
      t.sec_creator_created_count, t.token_created_at, t.first_detected_at,
      0::int AS wallet_buys, NULL::float8 AS buy_notional, NULL::float8 AS avg_win_rate
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    WHERE COALESCE(t.status, '') NOT IN ('ignored', 'archive')
      AND (pc.surfaced_at IS NOT NULL OR pc.quality_label IN ('very_good', 'good'))
    ORDER BY pc.called_at DESC NULLS LAST
    LIMIT ${Math.min(limit, 120)}
  `);

  // Reuse mapper by temporarily assigning rows shape — call through loadCallCards path
  // by inlining a thin wrap: map with walletBuys=0
  const cards: CallCard[] = (rows.rows as Array<Record<string, unknown>>).map(r => {
    const calledMc = r.called_mc_usd != null ? parseFloat(String(r.called_mc_usd)) : null;
    const currentMc = r.market_cap_usd != null ? parseFloat(String(r.market_cap_usd)) || null : null;
    const athMultiple = Number(r.ath_multiple ?? 1) || 1;
    const athMcRaw = r.ath_market_cap_usd != null ? parseFloat(String(r.ath_market_cap_usd)) : null;
    const athMc = athMcRaw && athMcRaw > 0
      ? athMcRaw
      : (calledMc && athMultiple > 1 ? calledMc * athMultiple : currentMc);
    const nowMultiple = calledMc && currentMc && calledMc > 0
      ? Math.round((currentMc / calledMc) * 100) / 100
      : 1;
    const ctoFlag = r.sec_cto_flag == null ? null : Boolean(r.sec_cto_flag);
    const creatorClose = r.sec_creator_close == null ? null : Boolean(r.sec_creator_close);
    const creatorCreatedCount = r.sec_creator_created_count != null
      ? Number(r.sec_creator_created_count) : null;
    const q = computeCallQuality({
      walletBuys: 0,
      calledKol: Number(r.called_kol_count ?? 0),
      calledSmart: Number(r.called_smart_count ?? 0),
      liveKol: Number(r.live_kol ?? 0),
      liveSmart: Number(r.live_smart ?? 0),
      holderQualityScore: r.holder_quality_score != null ? Number(r.holder_quality_score) : null,
      holderVelocityScore: r.holder_velocity_score != null ? Number(r.holder_velocity_score) : null,
      avgWalletWinRate: null,
      proScore: Number(r.pro_score ?? 0),
      qualityLabel: String(r.quality_label ?? ""),
      athMultiple,
      honeypot: r.sec_is_honeypot as boolean | null,
      ctoFlag,
      creatorClose,
      creatorCreatedCount,
    });
    const ageSrc = r.token_created_at ?? r.first_detected_at;
    const firstSeen = ageSrc ? new Date(String(ageSrc)).getTime() : null;
    return {
      id: Number(r.token_id),
      address: String(r.address),
      chain: String(r.chain ?? "solana"),
      name: (r.name as string | null) ?? null,
      symbol: (r.symbol as string | null) ?? null,
      logoUri: resolveLogoUri(r.image_path, r.logo_uri),
      calledAt: toIsoUtc(r.called_at ?? r.surfaced_at),
      calledMcUsd: calledMc,
      currentMcUsd: currentMc,
      athMcUsd: athMc,
      gainPct: calledMc && currentMc && calledMc > 0
        ? ((currentMc - calledMc) / calledMc) * 100 : null,
      nowMultiple,
      athMultiple: Math.round(athMultiple * 100) / 100,
      walletBuys: 0,
      buyVolumeHintUsd: null,
      calledKol: Number(r.called_kol_count ?? 0),
      calledSmart: Number(r.called_smart_count ?? 0),
      liveKol: Number(r.live_kol ?? 0),
      liveSmart: Number(r.live_smart ?? 0),
      holderCount: r.holder_count != null ? Number(r.holder_count) : null,
      avgWalletWinRate: null,
      holderQualityScore: r.holder_quality_score != null ? Number(r.holder_quality_score) : null,
      proScore: Number(r.pro_score ?? 0),
      qualityLabel: String(r.quality_label ?? "—"),
      callScore: q.score,
      callLabel: q.label,
      reasons: q.reasons,
      hit2x: Boolean(r.hit_2x) || athMultiple >= 2,
      hit5x: Boolean(r.hit_5x) || athMultiple >= 5,
      hit10x: Boolean(r.hit_10x) || athMultiple >= 10,
      volume24hUsd: r.volume_24h_usd != null ? parseFloat(String(r.volume_24h_usd)) || null : null,
      tokenAgeMin: firstSeen != null && Number.isFinite(firstSeen)
        ? Math.max(0, Math.round((Date.now() - firstSeen) / 60_000)) : null,
      ctoFlag,
      creatorClose,
      creatorAddress: r.sec_creator_address != null ? String(r.sec_creator_address) : null,
      creatorCreatedCount,
      socials: extractSocials(r.raw_metadata),
    };
  });
  cards.sort((a, b) => b.callScore - a.callScore);
  return { cards: cards.slice(0, limit), universe };
}

router.get("/calls/feed", async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "40"), 10) || 40, 1), 80);
    const mode = String(req.query.mode ?? "latest"); // latest | best | hot

    let pack: { cards: CallCard[]; universe: number };
    try {
      pack = await loadCallCards(Math.max(limit, 80));
    } catch (primaryErr) {
      console.error("calls feed primary failed — lite fallback", primaryErr);
      pack = await loadCallCardsLite(Math.max(limit, 80));
    }
    const { cards, universe } = pack;

    let out = cards;
    if (mode === "best") {
      out = cards
        .filter(c => c.callLabel === "elite" || c.callLabel === "strong")
        .slice(0, Math.min(limit, 8));
      if (out.length < 5) {
        out = cards.slice(0, Math.min(limit, 8));
      }
    } else if (mode === "hot") {
      out = [...cards]
        .sort((a, b) => (b.nowMultiple - a.nowMultiple) || (b.callScore - a.callScore))
        .slice(0, limit);
    } else {
      out = [...cards]
        .sort((a, b) => (b.calledAt ?? "").localeCompare(a.calledAt ?? ""))
        .slice(0, limit);
    }

    res.setHeader("Cache-Control", "private, max-age=4");
    res.json(apiOk({
      cards: out,
      total: out.length,
      universe,
      mode,
      note: "Ranked by wallet multi-buy · tagged holders · buyer win-rate — any market cap",
    }));
  } catch (err) {
    console.error("calls feed error", err);
    res.status(500).json(apiFail("Internal server error", "calls_feed"));
  }
});

router.get("/calls/stats", async (_req, res) => {
  try {
    const cacheKey = "calls:stats:v2";
    const cached = await proCacheGet<Record<string, unknown>>(cacheKey);
    if (cached) {
      res.json(apiOk(cached, { cache: "hit" }));
      return;
    }

    const result = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE surfaced_at IS NOT NULL OR quality_label IN ('very_good','good')
        )::int AS signals,
        COUNT(*) FILTER (
          WHERE (surfaced_at IS NOT NULL OR quality_label IN ('very_good','good'))
            AND COALESCE(ath_multiple, 1) >= 2
        )::int AS wins_2x,
        COUNT(*) FILTER (
          WHERE (surfaced_at IS NOT NULL OR quality_label IN ('very_good','good'))
            AND COALESCE(ath_multiple, 1) >= 5
        )::int AS wins_5x,
        COUNT(*) FILTER (
          WHERE (surfaced_at IS NOT NULL OR quality_label IN ('very_good','good'))
            AND COALESCE(ath_multiple, 1) >= 10
        )::int AS wins_10x,
        AVG(ath_multiple) FILTER (
          WHERE surfaced_at IS NOT NULL OR quality_label IN ('very_good','good')
        ) AS avg_ath,
        MAX(ath_multiple) FILTER (
          WHERE surfaced_at IS NOT NULL OR quality_label IN ('very_good','good')
        ) AS best_ath,
        (
          SELECT t.symbol FROM pro_calls pc2
          JOIN tracked_tokens t ON t.id = pc2.token_id
          WHERE pc2.ath_multiple IS NOT NULL
          ORDER BY pc2.ath_multiple DESC NULLS LAST
          LIMIT 1
        ) AS best_symbol
      FROM pro_calls
    `);
    const r = (result.rows[0] ?? {}) as Record<string, unknown>;
    const signals = Number(r.signals ?? 0);
    const wins = Number(r.wins_2x ?? 0);
    const data = {
      winRate: signals ? Math.round((wins / signals) * 1000) / 10 : 0,
      wins,
      signals,
      wins5x: Number(r.wins_5x ?? 0),
      wins10x: Number(r.wins_10x ?? 0),
      avgX: r.avg_ath != null ? Math.round(Number(r.avg_ath) * 100) / 100 : 0,
      bestX: r.best_ath != null ? Math.round(Number(r.best_ath) * 100) / 100 : 0,
      bestSymbol: r.best_symbol != null ? String(r.best_symbol) : null,
      universe: undefined as number | undefined,
    };

    const uni = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM tracked_tokens
      WHERE COALESCE(status, '') NOT IN ('ignored', 'archive')
    `);
    data.universe = Number((uni.rows[0] as { n?: number })?.n ?? 0);

    await proCacheSet(cacheKey, data, 12);
    res.json(apiOk(data, { cache: "miss" }));
  } catch (err) {
    console.error("calls stats error", err);
    res.status(500).json(apiFail("Internal server error", "calls_stats"));
  }
});

router.get("/calls/token/:tokenId", async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (!Number.isFinite(tokenId)) {
      res.status(400).json(apiFail("Invalid token id", "bad_id"));
      return;
    }
    const { cards } = await loadCallCards(320);
    const card = cards.find(c => c.id === tokenId) ?? null;
    res.json(apiOk({ card }));
  } catch (err) {
    console.error("calls token error", err);
    res.status(500).json(apiFail("Internal server error", "calls_token"));
  }
});

export default router;
