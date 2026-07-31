/**
 * Pro Caller Routes
 *
 * GET /api/pro/stats         — aggregate performance (hit rates from called MC)
 * GET /api/pro/history       — pro-called tokens with quality scores + run status
 * GET /api/pro/token/:id     — single token's pro call record (milestones, entry point)
 *
 * Quality / ATH filters
 *   very_good | good | quality | recent | all
 *   x5        — 5 ≤ ATH < 10
 *   x10       — 10 ≤ ATH < 20
 *   x10plus   — ATH ≥ 20  ("10× more")
 *
 * Pro Score v2 labels: very_good ≥ 75 | good 55–74 | below < 55
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { extractSocials } from "../lib/socials";
import { deriveRunStatus } from "../lib/pro-scoring";
import { proCacheGet, proCacheSet, toIsoUtc } from "../lib/pro-cache";

const router = Router();

const FEED_CACHE_TTL_SEC = 8;
const STATS_CACHE_TTL_SEC = 10;

/** Prefer live https logo; else absolute /api/assets URL (SPA origin would 404 HTML). */
function resolveLogoUri(imagePath: unknown, logoUri: unknown): string | null {
  const external = logoUri != null ? String(logoUri).trim() : "";
  if (/^https?:\/\//i.test(external)) return external;
  const path = imagePath != null ? String(imagePath).trim() : "";
  if (path) {
    const rel = path.startsWith("/api/assets")
      ? path
      : `/api/assets${path.startsWith("/") ? path : `/${path}`}`;
    const base = (
      process.env.PUBLIC_API_URL
      || process.env.RENDER_EXTERNAL_URL
      || ""
    ).replace(/\/$/, "");
    return base ? `${base}${rel}` : rel;
  }
  return external || null;
}

type SlimToken = {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  status: string;
  calledAt: string | null;
  calledMcUsd: number | null;
  calledIntel: number | null;
  calledKol: number;
  calledSmart: number;
  calledKolSmartScore: number | null;
  calledHolderVelocity: number | null;
  currentMcUsd: number | null;
  gainSinceCall: number | null;
  athMultiple: number;
  runStatus: string;
  proScore: number;
  qualityLabel: string;
  survivalScore: number | null;
  entryTier: string | null;
  scoreVersion: string;
  currentKol: number;
  currentSmart: number;
  currentIntel: number | null;
  lastSnapshotAt: string | null;
  hit2x: boolean; hit5x: boolean; hit10x: boolean; hit100x: boolean;
  surfacedAt: string | null;
  surfacedMcUsd: number | null;
  scannerLabel: string;
  secMintRenounced: boolean | null;
  secFreezeRenounced: boolean | null;
  secIsHoneypot: boolean | null;
  socials: { twitter?: string; telegram?: string; website?: string };
  /** Frozen GMGN conviction at call (from verified_wallets). */
  conviction: {
    smartHoldRate: number | null;
    kolHoldRate: number | null;
    smartHolding: number;
    kolHolding: number;
    paperHands: number;
    diamondHands: number;
    supplyPctHeld: number;
  } | null;
  kolSmartSource: string | null;
};

function parseConviction(raw: unknown): SlimToken["conviction"] {
  if (!raw) return null;
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!o || typeof o !== "object") return null;
    const c = (o as { conviction?: { kol?: Record<string, number>; smart?: Record<string, number> } }).conviction;
    const holding = (o as { holding?: { kol?: number; smart?: number } }).holding;
    if (!c?.smart && !c?.kol && !holding) return null;
    return {
      smartHoldRate: c?.smart?.holdRate ?? null,
      kolHoldRate: c?.kol?.holdRate ?? null,
      smartHolding: holding?.smart ?? c?.smart?.holding ?? 0,
      kolHolding: holding?.kol ?? c?.kol?.holding ?? 0,
      paperHands: (c?.smart?.paperHands ?? 0) + (c?.kol?.paperHands ?? 0),
      diamondHands: (c?.smart?.diamondHands ?? 0) + (c?.kol?.diamondHands ?? 0),
      supplyPctHeld: (c?.smart?.supplyPctHeld ?? 0) + (c?.kol?.supplyPctHeld ?? 0),
    };
  } catch {
    return null;
  }
}

async function loadQualityFeed(limit: number): Promise<{ tokens: SlimToken[]; total: number }> {
  const cacheKey = `pro:feed:v4:${limit}`;
  const cached = await proCacheGet<{ tokens: SlimToken[]; total: number }>(cacheKey);

  // Cheap freshness check — stats/total can move while feed cache still holds old rows
  const head = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE quality_label IN ('very_good', 'good'))::int AS quality_total,
      MAX(called_at) FILTER (WHERE quality_label IN ('very_good', 'good')) AS latest_called
    FROM pro_calls
  `);
  const headRow = (head.rows[0] ?? {}) as Record<string, unknown>;
  const qualityTotal = Number(headRow.quality_total ?? 0);
  const latestCalled = toIsoUtc(headRow.latest_called);
  const cachedLatest = cached?.tokens?.[0]?.calledAt ?? null;
  const cacheFresh =
    cached?.tokens?.length &&
    cached.total === qualityTotal &&
    (!latestCalled || !cachedLatest || cachedLatest >= latestCalled);

  if (cacheFresh && cached) return cached;

  const callRows = await db.execute(sql`
    SELECT
      pc.token_id,
      pc.called_at,
      pc.called_mc_usd,
      pc.called_intel_score,
      pc.called_kol_count,
      pc.called_smart_count,
      pc.called_kol_smart_score,
      pc.called_holder_velocity,
      pc.ath_multiple,
      pc.last_snapshot_at AS snap_at,
      pc.pro_score,
      pc.quality_label,
      pc.survival_score,
      pc.entry_tier,
      pc.score_version,
      pc.hit_2x, pc.hit_5x, pc.hit_10x, pc.hit_100x,
      pc.surfaced_at,
      pc.surfaced_mc_usd,
      pc.scanner_label,
      pc.verified_wallets,
      pc.kol_smart_source,
      t.address, t.chain, t.name, t.symbol,
      t.logo_uri, t.image_path,
      t.status,
      t.market_cap_usd,
      t.intelligence_score AS live_intel,
      t.holder_kol_count   AS live_kol,
      t.holder_smart_count AS live_smart,
      t.sec_is_honeypot,
      t.sec_mint_renounced,
      t.sec_freeze_renounced
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    WHERE pc.quality_label IN ('very_good', 'good')
    ORDER BY pc.called_at DESC NULLS LAST
    LIMIT ${limit}
  `);

  const tokens: SlimToken[] = (callRows.rows as Array<Record<string, unknown>>).map(call => {
    const calledMc = call.called_mc_usd ? parseFloat(String(call.called_mc_usd)) : null;
    const currentMc = parseFloat(String(call.market_cap_usd ?? "0")) || null;
    const gainSinceCall = calledMc && currentMc
      ? ((currentMc - calledMc) / calledMc) * 100 : null;
    const athMultiple = Number(call.ath_multiple ?? 1) || 1;
    const runStatus = deriveRunStatus(currentMc, calledMc, athMultiple);
    const proScore = Number(call.pro_score ?? 0);
    const qualityLabel = String(call.quality_label ?? "below");

    return {
      id: Number(call.token_id),
      address: String(call.address),
      chain: String(call.chain),
      name: (call.name as string | null) ?? null,
      symbol: (call.symbol as string | null) ?? null,
      logoUri: resolveLogoUri(call.image_path, call.logo_uri),
      status: String(call.status ?? ""),
      calledAt: toIsoUtc(call.called_at),
      calledMcUsd: calledMc,
      calledIntel: call.called_intel_score != null ? Number(call.called_intel_score) : null,
      calledKol: Number(call.called_kol_count ?? 0),
      calledSmart: Number(call.called_smart_count ?? 0),
      calledKolSmartScore: call.called_kol_smart_score != null ? Number(call.called_kol_smart_score) : null,
      calledHolderVelocity: call.called_holder_velocity != null ? Number(call.called_holder_velocity) : null,
      currentMcUsd: currentMc,
      gainSinceCall,
      athMultiple,
      runStatus,
      proScore,
      qualityLabel,
      survivalScore: call.survival_score != null ? Number(call.survival_score) : null,
      entryTier: (call.entry_tier as string | null) ?? null,
      scoreVersion: String(call.score_version ?? "v2"),
      currentKol: Math.max(Number(call.live_kol ?? 0), Number(call.called_kol_count ?? 0)),
      currentSmart: Math.max(Number(call.live_smart ?? 0), Number(call.called_smart_count ?? 0)),
      currentIntel: call.live_intel != null ? Number(call.live_intel) : (call.called_intel_score != null ? Number(call.called_intel_score) : null),
      lastSnapshotAt: toIsoUtc(call.snap_at),
      hit2x: Boolean(call.hit_2x),
      hit5x: Boolean(call.hit_5x),
      hit10x: Boolean(call.hit_10x),
      hit100x: Boolean(call.hit_100x),
      surfacedAt: toIsoUtc(call.surfaced_at),
      surfacedMcUsd: call.surfaced_mc_usd ? parseFloat(String(call.surfaced_mc_usd)) : null,
      scannerLabel: String(call.scanner_label ?? "very_strong"),
      secMintRenounced: call.sec_mint_renounced as boolean | null,
      secFreezeRenounced: call.sec_freeze_renounced as boolean | null,
      secIsHoneypot: call.sec_is_honeypot as boolean | null,
      socials: {},
      conviction: parseConviction(call.verified_wallets),
      kolSmartSource: call.kol_smart_source != null ? String(call.kol_smart_source) : null,
    };
  });

  const payload = { tokens, total: qualityTotal };
  await proCacheSet(cacheKey, payload, FEED_CACHE_TTL_SEC);
  return payload;
}

function sortTokens(tokens: SlimToken[], sort: string, order: "asc" | "desc"): SlimToken[] {
  const dir = order === "asc" ? 1 : -1;
  const out = [...tokens];
  out.sort((a, b) => {
    const num = (x: number | null | undefined, fallback = -Infinity) =>
      x == null || !Number.isFinite(x) ? fallback : x;
    switch (sort) {
      case "ath":
        return (num(a.athMultiple) - num(b.athMultiple)) * dir;
      case "gain":
        return (num(a.gainSinceCall) - num(b.gainSinceCall)) * dir;
      case "intel":
        return (num(a.currentIntel) - num(b.currentIntel)) * dir;
      case "calledMc":
        return (num(a.calledMcUsd) - num(b.calledMcUsd)) * dir;
      case "calledAt":
      case "age": {
        const ta = a.calledAt ? new Date(a.calledAt).getTime() : 0;
        const tb = b.calledAt ? new Date(b.calledAt).getTime() : 0;
        return (ta - tb) * dir;
      }
      case "survival":
        return (num(a.survivalScore) - num(b.survivalScore)) * dir;
      case "proScore":
      default:
        return (num(a.proScore) - num(b.proScore)) * dir;
    }
  });
  return out;
}

function filterTokens(tokens: SlimToken[], quality: string): SlimToken[] {
  const now = Date.now();
  const within = (hours: number) => (t: SlimToken) => {
    if (!t.calledAt) return false;
    return now - new Date(t.calledAt).getTime() <= hours * 3_600_000;
  };
  switch (quality) {
    case "very_good":
      return tokens.filter(t => t.qualityLabel === "very_good");
    case "good":
      return tokens.filter(t => t.qualityLabel === "good");
    case "recent":
    case "24h":
      return tokens.filter(within(24));
    case "1h":
      return tokens.filter(within(1));
    case "6h":
      return tokens.filter(within(6));
    case "7d":
      return tokens.filter(within(24 * 7));
    case "x5":
      return tokens.filter(t => t.athMultiple >= 5 && t.athMultiple < 10);
    case "x10":
      return tokens.filter(t => t.athMultiple >= 10 && t.athMultiple < 20);
    case "x10plus":
      return tokens.filter(t => t.athMultiple >= 20);
    case "quality":
    case "feed":
    case "sections":
    default:
      return tokens;
  }
}

// ── GET /api/pro/stats ────────────────────────────────────────────────────────

router.get("/pro/stats", async (_req, res) => {
  try {
    const cacheKey = "pro:stats:v2";
    const cached = await proCacheGet<Record<string, unknown>>(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const result = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE quality_label IN ('very_good', 'good'))::int           AS total,
        COUNT(*)::int                                                                  AS total_all_time,
        COUNT(CASE WHEN ath_multiple >= 2   AND quality_label IN ('very_good','good') THEN 1 END)::int  AS win,
        COUNT(CASE WHEN ath_multiple >= 1.5 AND quality_label IN ('very_good','good') THEN 1 END)::int  AS x1,
        COUNT(CASE WHEN ath_multiple >= 2   AND quality_label IN ('very_good','good') THEN 1 END)::int  AS x2,
        COUNT(CASE WHEN ath_multiple >= 3   AND quality_label IN ('very_good','good') THEN 1 END)::int  AS x3,
        COUNT(CASE WHEN ath_multiple >= 5 AND ath_multiple < 10 AND quality_label IN ('very_good','good') THEN 1 END)::int AS x5,
        COUNT(CASE WHEN ath_multiple >= 10 AND ath_multiple < 20 AND quality_label IN ('very_good','good') THEN 1 END)::int AS x10,
        COUNT(CASE WHEN ath_multiple >= 20 AND quality_label IN ('very_good','good') THEN 1 END)::int AS x10_plus,
        COUNT(CASE WHEN ath_multiple >= 100 AND quality_label IN ('very_good','good') THEN 1 END)::int  AS x100,
        COUNT(CASE WHEN ath_multiple >= 200 AND quality_label IN ('very_good','good') THEN 1 END)::int  AS x200,
        ROUND(MAX(CASE WHEN quality_label IN ('very_good','good') THEN ath_multiple END)::numeric, 2)   AS best_ath,
        COUNT(CASE WHEN quality_label = 'very_good' THEN 1 END)::int                  AS very_good_count,
        COUNT(CASE WHEN quality_label = 'good'      THEN 1 END)::int                  AS good_count,
        COUNT(*) FILTER (
          WHERE quality_label IN ('very_good','good')
            AND called_at >= NOW() - INTERVAL '1 hour'
        )::int                                                                         AS recent_1h,
        COUNT(*) FILTER (
          WHERE quality_label IN ('very_good','good')
            AND called_at >= NOW() - INTERVAL '6 hours'
        )::int                                                                         AS recent_6h,
        COUNT(*) FILTER (
          WHERE quality_label IN ('very_good','good')
            AND called_at >= NOW() - INTERVAL '24 hours'
        )::int                                                                         AS recent_count,
        COUNT(*) FILTER (
          WHERE quality_label IN ('very_good','good')
            AND called_at >= NOW() - INTERVAL '7 days'
        )::int                                                                         AS recent_7d,
        ROUND(AVG(CASE WHEN quality_label IN ('very_good','good') THEN survival_score END)::numeric, 1) AS avg_survival,
        MAX(called_at) FILTER (WHERE quality_label IN ('very_good','good'))            AS latest_called_at
      FROM pro_calls
    `);

    const row   = (result.rows[0] ?? {}) as Record<string, unknown>;
    const total = Number(row.total ?? 0);
    const win   = Number(row.win   ?? 0);

    const body = {
      total,
      totalAllTime:   Number(row.total_all_time ?? 0),
      winRate:        total > 0 ? Math.round((win / total) * 100) : 0,
      x1Count:        Number(row.x1   ?? 0),
      x2Count:        Number(row.x2   ?? 0),
      x3Count:        Number(row.x3   ?? 0),
      x5Count:        Number(row.x5   ?? 0),
      x10Count:       Number(row.x10  ?? 0),
      x10PlusCount:   Number(row.x10_plus ?? 0),
      x100Count:      Number(row.x100 ?? 0),
      x200Count:      Number(row.x200 ?? 0),
      bestAth:        row.best_ath != null ? Number(row.best_ath) : null,
      veryGoodCount:  Number(row.very_good_count ?? 0),
      goodCount:      Number(row.good_count      ?? 0),
      qualityCount:   Number(row.very_good_count ?? 0) + Number(row.good_count ?? 0),
      recent1hCount:  Number(row.recent_1h ?? 0),
      recent6hCount:  Number(row.recent_6h ?? 0),
      recentCount:    Number(row.recent_count    ?? 0),
      recent7dCount:  Number(row.recent_7d ?? 0),
      avgSurvival:    row.avg_survival != null ? Number(row.avg_survival) : null,
      latestCalledAt: toIsoUtc(row.latest_called_at),
    };
    await proCacheSet(cacheKey, body, STATS_CACHE_TTL_SEC);
    res.json(body);
  } catch (err) {
    console.error("pro stats error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/pro/history ──────────────────────────────────────────────────────
// Fast path: one cached quality feed + in-memory filter/sort (tab changes are free).

router.get("/pro/history", async (req, res) => {
  try {
    const sort    = (req.query.sort    as string) ?? "proScore";
    const order   = (req.query.order   as string) === "asc" ? "asc" : "desc";
    const quality = (req.query.quality as string) ?? "quality";
    const limit   = Math.min(Math.max(parseInt(String(req.query.limit ?? "300"), 10) || 300, 1), 400);

    const feed = await loadQualityFeed(Math.max(limit, 300));
    const filtered = filterTokens(feed.tokens, quality);
    const sorted = sortTokens(filtered, sort, order).slice(0, limit);

    res.setHeader("Cache-Control", "private, max-age=5");
    res.json({
      total: filtered.length,
      totalAll: feed.total,
      tokens: sorted,
      latestCalledAt: feed.tokens[0]?.calledAt ?? null,
      cache: "feed",
    });
  } catch (err) {
    console.error("pro history error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/pro/token/:tokenId ───────────────────────────────────────────────

router.get("/pro/token/:tokenId", async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (isNaN(tokenId)) {
      res.status(400).json({ error: "Invalid token ID" });
      return;
    }

    const [callResult, snapResult] = await Promise.all([
      db.execute(sql`
        SELECT
          pc.id,
          pc.token_id,
          pc.called_at,
          pc.called_mc_usd,
          pc.called_intel_score,
          pc.called_kol_count,
          pc.called_smart_count,
          pc.called_holder_velocity,
          pc.called_mc_growth,
          pc.called_volume_intensity,
          pc.ath_multiple,
          pc.pro_score,
          pc.quality_label,
          pc.survival_score,
          pc.entry_tier,
          pc.score_version,
          pc.hit_2x,  pc.hit_2x_at,
          pc.hit_3x,  pc.hit_3x_at,
          pc.hit_5x,  pc.hit_5x_at,
          pc.hit_10x, pc.hit_10x_at,
          pc.hit_100x,pc.hit_100x_at,
          pc.last_snapshot_at,
          pc.kol_smart_source,
          pc.verified_at,
          pc.verified_wallets,
          pc.surfaced_at,
          pc.surfaced_mc_usd,
          pc.call_alert_sent_at,
          pc.milestone_alerts_sent,
          t.address, t.chain, t.name, t.symbol, t.logo_uri, t.image_path,
          t.market_cap_usd, t.liquidity_usd, t.holder_count,
          t.holder_kol_count, t.holder_smart_count, t.intelligence_score,
          t.holder_velocity_score, t.raw_metadata, t.status,
          t.sec_mint_renounced, t.sec_freeze_renounced, t.sec_is_honeypot
        FROM pro_calls pc
        JOIN tracked_tokens t ON t.id = pc.token_id
        WHERE pc.token_id = ${tokenId}
        LIMIT 1
      `),
      db.execute(sql`
        SELECT
          snapshot_at, mc_usd, kol_count, smart_count, intel_score, ath_multiple,
          survival_score, pro_score, quality_label, gain_pct, run_status,
          holder_velocity_score, age_hours, holder_count,
          mc_growth_score, volume_intensity_score, liquidity_usd,
          kol_delta, smart_delta
        FROM pro_snapshots
        WHERE token_id = ${tokenId}
        ORDER BY snapshot_at DESC
        LIMIT 120
      `),
    ]);

    if (!callResult.rows.length) {
      res.json({ proCall: null, postmortem: null, snapshots: [] });
      return;
    }

    const r = callResult.rows[0] as Record<string, unknown>;
    let verifiedWallets: unknown = null;
    if (r.verified_wallets) {
      try {
        verifiedWallets = typeof r.verified_wallets === "string"
          ? JSON.parse(String(r.verified_wallets))
          : r.verified_wallets;
      } catch {
        verifiedWallets = null;
      }
    }

    const calledMc = r.called_mc_usd ? parseFloat(String(r.called_mc_usd)) : null;
    const currentMc = r.market_cap_usd ? parseFloat(String(r.market_cap_usd)) : null;
    const socials = extractSocials(r.raw_metadata);
    const runStatus = deriveRunStatus(currentMc, calledMc, Number(r.ath_multiple ?? 1));

    const snapshots = (snapResult.rows as Array<Record<string, unknown>>).map(s => ({
      snapshotAt: String(s.snapshot_at),
      mcUsd: s.mc_usd != null ? parseFloat(String(s.mc_usd)) : null,
      kolCount: Number(s.kol_count ?? 0),
      smartCount: Number(s.smart_count ?? 0),
      intelScore: s.intel_score != null ? Number(s.intel_score) : null,
      athMultiple: s.ath_multiple != null ? Number(s.ath_multiple) : null,
      survivalScore: s.survival_score != null ? Number(s.survival_score) : null,
      proScore: s.pro_score != null ? Number(s.pro_score) : null,
      qualityLabel: s.quality_label ?? null,
      gainPct: s.gain_pct != null ? Number(s.gain_pct) : null,
      runStatus: s.run_status != null ? String(s.run_status) : null,
      holderVelocityScore: s.holder_velocity_score != null ? Number(s.holder_velocity_score) : null,
      ageHours: s.age_hours != null ? Number(s.age_hours) : null,
      holderCount: s.holder_count != null ? Number(s.holder_count) : null,
      mcGrowthScore: s.mc_growth_score != null ? Number(s.mc_growth_score) : null,
      volumeIntensityScore: s.volume_intensity_score != null ? Number(s.volume_intensity_score) : null,
      liquidityUsd: s.liquidity_usd != null ? parseFloat(String(s.liquidity_usd)) : null,
      kolDelta: Number(s.kol_delta ?? 0),
      smartDelta: Number(s.smart_delta ?? 0),
    })).reverse(); // chronological for charts

    const { buildProPostmortem } = await import("../lib/postmortem");
    const postmortem = buildProPostmortem({
      calledAt: r.called_at as string | Date,
      calledMcUsd: calledMc,
      calledIntel: r.called_intel_score != null ? Number(r.called_intel_score) : null,
      calledKol: Number(r.called_kol_count ?? 0),
      calledSmart: Number(r.called_smart_count ?? 0),
      calledHv: r.called_holder_velocity != null ? Number(r.called_holder_velocity) : null,
      calledMcGrowth: r.called_mc_growth != null ? Number(r.called_mc_growth) : null,
      calledVol: r.called_volume_intensity != null ? Number(r.called_volume_intensity) : null,
      athMultiple: r.ath_multiple != null ? Number(r.ath_multiple) : null,
      proScore: r.pro_score != null ? Number(r.pro_score) : null,
      survivalScore: r.survival_score != null ? Number(r.survival_score) : null,
      qualityLabel: r.quality_label != null ? String(r.quality_label) : null,
      entryTier: r.entry_tier != null ? String(r.entry_tier) : null,
      hit2x: Boolean(r.hit_2x),
      hit5x: Boolean(r.hit_5x),
      hit10x: Boolean(r.hit_10x),
      hit2xAt: r.hit_2x_at != null ? String(r.hit_2x_at) : null,
      hit5xAt: r.hit_5x_at != null ? String(r.hit_5x_at) : null,
      hit10xAt: r.hit_10x_at != null ? String(r.hit_10x_at) : null,
      currentMcUsd: currentMc,
      liveKol: Number(r.holder_kol_count ?? 0),
      liveSmart: Number(r.holder_smart_count ?? 0),
      liveIntel: r.intelligence_score != null ? Number(r.intelligence_score) : null,
      liveHv: r.holder_velocity_score != null ? Number(r.holder_velocity_score) : null,
      holderCount: r.holder_count != null ? Number(r.holder_count) : null,
      liquidityUsd: r.liquidity_usd ? parseFloat(String(r.liquidity_usd)) : null,
      runStatus,
      socials,
      kolSmartSource: r.kol_smart_source != null ? String(r.kol_smart_source) : null,
      snapshots: snapshots.slice(-48).map(s => ({
        snapshotAt: s.snapshotAt,
        mcUsd: s.mcUsd,
        gainPct: s.gainPct,
        athMultiple: s.athMultiple,
        kolCount: s.kolCount,
        smartCount: s.smartCount,
        kolDelta: s.kolDelta,
        smartDelta: s.smartDelta,
        holderVelocityScore: s.holderVelocityScore,
        survivalScore: s.survivalScore,
        runStatus: s.runStatus,
      })),
    });

    res.json({
      proCall: {
        id:               Number(r.id),
        calledAt:         r.called_at,
        calledMcUsd:      calledMc,
        calledIntelScore: r.called_intel_score != null ? Number(r.called_intel_score) : null,
        calledKolCount:   Number(r.called_kol_count ?? 0),
        calledSmartCount: Number(r.called_smart_count ?? 0),
        calledHolderVelocity: r.called_holder_velocity != null ? Number(r.called_holder_velocity) : null,
        athMultiple:      r.ath_multiple != null ? Number(r.ath_multiple) : null,
        proScore:         r.pro_score != null ? Number(r.pro_score) : null,
        qualityLabel:     r.quality_label ?? null,
        survivalScore:    r.survival_score != null ? Number(r.survival_score) : null,
        entryTier:        r.entry_tier ?? null,
        scoreVersion:     r.score_version ?? null,
        lastSnapshotAt:   r.last_snapshot_at ?? null,
        kolSmartSource:   r.kol_smart_source ?? null,
        verifiedAt:       r.verified_at ?? null,
        verifiedWallets,
        surfacedAt:       r.surfaced_at ?? null,
        surfacedMcUsd:    r.surfaced_mc_usd ? parseFloat(String(r.surfaced_mc_usd)) : null,
        callAlertSentAt:  r.call_alert_sent_at ?? null,
        milestoneAlertsSent: r.milestone_alerts_sent ?? "",
        hit2x:    Boolean(r.hit_2x),    hit2xAt:  r.hit_2x_at   ?? null,
        hit3x:    Boolean(r.hit_3x),    hit3xAt:  r.hit_3x_at   ?? null,
        hit5x:    Boolean(r.hit_5x),    hit5xAt:  r.hit_5x_at   ?? null,
        hit10x:   Boolean(r.hit_10x),   hit10xAt: r.hit_10x_at  ?? null,
        hit100x:  Boolean(r.hit_100x),  hit100xAt:r.hit_100x_at ?? null,
        currentMcUsd: currentMc,
        liveKol: Number(r.holder_kol_count ?? 0),
        liveSmart: Number(r.holder_smart_count ?? 0),
        liveIntel: r.intelligence_score != null ? Number(r.intelligence_score) : null,
        liveHv: r.holder_velocity_score != null ? Number(r.holder_velocity_score) : null,
        runStatus,
        socials,
        address: r.address,
        chain: r.chain,
        name: r.name,
        symbol: r.symbol,
      },
      postmortem,
      snapshots,
    });
  } catch (err) {
    console.error("pro token error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
