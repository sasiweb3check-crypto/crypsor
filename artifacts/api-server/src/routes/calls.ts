/**
 * Desk API — pump-fullend strategy scoring (buy-sourced).
 *
 * GET /api/calls/feed   — pump filter/sort desk (default). ?legacy=1 for old Crypsor modes
 * GET /api/calls/waiting — LEGACY ENTRY hold queue (Ops)
 * GET /api/calls/stats  — win rate stats
 * GET /api/calls/token/:id — buy-sourced detail (+ pump grade)
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { apiFail, apiOk } from "../lib/api-envelope";
import { proCacheGet, proCacheSet, toIsoUtc } from "../lib/pro-cache";
import { extractSocials } from "../lib/socials";
import { computeCallQuality, type CallQualityLabel } from "../lib/call-quality";
import { convictionFieldsFromVerified } from "../lib/pro-confidence";
import { overlayLiveMarketCaps } from "../pipeline/price-service";
import {
  computeRunnerScore,
  MIN_ENTRY_OBSERVATION_SNAPS,
  type RunnerPhase,
} from "../lib/runner-score";
import {
  ensureTokenCreatorStats,
  type CreatorStatsPayload,
} from "../lib/pump-creator";
import {
  applyPumpDeskFilters,
  parsePumpScan,
  type PumpBuyLevel,
  type PumpFilterId,
  type PumpGrade,
  type PumpIntraLevel,
  type PumpSignalTag,
  type PumpSortId,
} from "../lib/pump-sdk-score";

const router = Router();

export type PumpDeskFields = {
  pumpScore: number | null;
  pumpGrade: PumpGrade | null;
  pumpBuySignal: PumpBuyLevel | null;
  pumpIntraSignal: PumpIntraLevel | null;
  pumpTags: PumpSignalTag[];
  pumpRecommendation: string | null;
  pumpMarketCap: number | null;
  pumpLiquidityUsd: number | null;
  pumpVolume24h: number | null;
  pumpPairCreatedAt: number | null;
  pumpPriceChange24h: number | null;
  pumpGainSinceDetection: number | null;
  pumpAthGain: number | null;
  pumpDetectedAt: number | null;
  pumpSocialSignal: number | null;
  pumpFreshness: number | null;
};

function pumpFieldsFromRow(r: Record<string, unknown>): PumpDeskFields {
  const scan = parsePumpScan(r.pump_scan);
  if (!scan) {
    return {
      pumpScore: null,
      pumpGrade: null,
      pumpBuySignal: null,
      pumpIntraSignal: null,
      pumpTags: [],
      pumpRecommendation: null,
      pumpMarketCap: null,
      pumpLiquidityUsd: null,
      pumpVolume24h: null,
      pumpPairCreatedAt: null,
      pumpPriceChange24h: null,
      pumpGainSinceDetection: null,
      pumpAthGain: null,
      pumpDetectedAt: null,
      pumpSocialSignal: null,
      pumpFreshness: null,
    };
  }
  return {
    pumpScore: scan.score,
    pumpGrade: scan.grade,
    pumpBuySignal: scan.buySignal,
    pumpIntraSignal: scan.intraSignal,
    pumpTags: scan.tags.slice(0, 6),
    pumpRecommendation: scan.recommendation,
    pumpMarketCap: scan.marketCap,
    pumpLiquidityUsd: scan.liquidityUsd,
    pumpVolume24h: scan.volume24h,
    pumpPairCreatedAt: scan.pairCreatedAt,
    pumpPriceChange24h: scan.priceChange24h,
    pumpGainSinceDetection: scan.gainSinceDetection,
    pumpAthGain: scan.athGain,
    pumpDetectedAt: scan.detectedAt,
    pumpSocialSignal: scan.socialSignal,
    pumpFreshness: scan.freshnessMultiplier,
  };
}

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
  /** Proxy for short-window volume intensity (0–100), NOT a percent. */
  volumeIntensityScore: number | null;
  /** 1h MC % (snapshot ~1h ago, or since-call for young tokens). */
  gain1hPct: number | null;
  /** Baseline MC used for gain1hPct recompute after live overlay. */
  mc1hUsd?: number | null;
  /** Buy-count momentum windows */
  momentum1h: number;
  momentum6h: number;
  tokenAgeMin: number | null;
  ctoFlag: boolean | null;
  creatorClose: boolean | null;
  creatorAddress: string | null;
  creatorCreatedCount: number | null;
  /** Pump.fun graduated (migrated off bonding curve). Present on detail; optional on feed. */
  graduated?: boolean;
  creatorUsername?: string | null;
  /** This mint's ATH MC from pump.fun when available. */
  pumpAthMcUsd?: number | null;
  /** Creator track record from pump.fun (token count, migrations, prior ATH, trust). */
  creatorStats?: CreatorStatsPayload | null;
  socials: { twitter?: string; telegram?: string; website?: string };
  /** ENTRY ping fired (Telegram or in-app) — what win-rate counts */
  entryServed: boolean;
  /**
   * Proper serve: very_good + ≥5 observation snaps + holder snapshot + tagged ≥1
   * Used to keep Best desk clear of raw `good` flood.
   */
  properServe: boolean;
  /** Pump-SDK strategy score (buy-sourced scanner). */
  pumpScore: number | null;
  pumpGrade: PumpGrade | null;
  pumpBuySignal: PumpBuyLevel | null;
  pumpIntraSignal: PumpIntraLevel | null;
  pumpTags: PumpSignalTag[];
  pumpRecommendation: string | null;
  pumpMarketCap?: number | null;
  pumpLiquidityUsd?: number | null;
  pumpVolume24h?: number | null;
  pumpPairCreatedAt?: number | null;
  pumpPriceChange24h?: number | null;
  pumpGainSinceDetection?: number | null;
  pumpAthGain?: number | null;
  pumpDetectedAt?: number | null;
  pumpSocialSignal?: number | null;
  pumpFreshness?: number | null;
};

/** Shared select extras for momentum + 1h MC gain (snapshot lateral). */
const MOMENTUM_SELECT = sql`
  COALESCE(t.momentum_1h, 0)::int AS momentum_1h,
  COALESCE(t.momentum_6h, 0)::int AS momentum_6h,
  t.volume_intensity_score,
  snap1h.mc_1h`;

/** Closest snapshot to ~1h ago (not a brittle 50m–2h window that misses young tokens). */
const SNAP1H_LATERAL = sql`
  LEFT JOIN LATERAL (
    SELECT market_cap_usd AS mc_1h
    FROM token_price_snapshots tps
    WHERE tps.token_id = t.id
      AND tps.market_cap_usd IS NOT NULL
      AND tps.snapshot_at <= NOW() - INTERVAL '25 minutes'
      AND tps.snapshot_at >= NOW() - INTERVAL '3 hours'
    ORDER BY ABS(EXTRACT(EPOCH FROM (tps.snapshot_at - (NOW() - INTERVAL '1 hour')))) ASC
    LIMIT 1
  ) snap1h ON TRUE`;

function pctChange(fromMc: number, toMc: number): number {
  return Math.round(((toMc - fromMc) / fromMc) * 1000) / 10;
}

/**
 * 1H MC % for filters/UI.
 * 1) Snapshot nearest ~1h ago when available
 * 2) For young calls (<90m) with no snap yet → since-call % (best recent proxy)
 */
function resolveGain1hPct(opts: {
  currentMc: number | null;
  mc1hRaw: unknown;
  calledMc: number | null;
  calledAt: string | null;
}): number | null {
  const { currentMc, mc1hRaw, calledMc, calledAt } = opts;
  if (currentMc == null || currentMc <= 0) return null;

  if (mc1hRaw != null) {
    const mc1h = parseFloat(String(mc1hRaw));
    if (Number.isFinite(mc1h) && mc1h > 0) return pctChange(mc1h, currentMc);
  }

  // Young desk rows often have no ≥25m snapshot yet — use entry MC as baseline
  if (calledMc != null && calledMc > 0 && calledAt) {
    const ageMin = (Date.now() - new Date(calledAt).getTime()) / 60_000;
    if (Number.isFinite(ageMin) && ageMin >= 0 && ageMin < 90) {
      return pctChange(calledMc, currentMc);
    }
  }
  return null;
}

function parseMc1h(mc1hRaw: unknown): number | null {
  if (mc1hRaw == null) return null;
  const n = parseFloat(String(mc1hRaw));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** After live MC overlay, refresh 1H % so filters/UI stay consistent. */
function refreshGain1hOnCards<T extends CallCard & { mc1hUsd?: number | null }>(cards: T[]): T[] {
  return cards.map((c) => {
    const gain1hPct = resolveGain1hPct({
      currentMc: c.currentMcUsd,
      mc1hRaw: c.mc1hUsd ?? null,
      calledMc: c.calledMcUsd,
      calledAt: c.calledAt,
    });
    return gain1hPct === c.gain1hPct ? c : { ...c, gain1hPct };
  });
}

async function loadCallCards(limit: number): Promise<{ cards: CallCard[]; universe: number }> {
  // v9: ENTRY-served + momentum/1h gain fields for table filters
  const cacheKey = `calls:feed:v11-pump:${limit}`;
  const cached = await proCacheGet<{ cards: CallCard[]; universe: number }>(cacheKey);
  if (cached?.cards?.length) return cached;

  const universeRow = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM tracked_tokens
    WHERE COALESCE(status, '') NOT IN ('ignored', 'archive')
  `);
  const universe = Number((universeRow.rows[0] as { n?: number })?.n ?? 0);

  // Light feed: ENTRY-served only (Telegram or in-app ENTRY ping).
  // Waiting queue is a separate endpoint — keep it out of win-rate / desk math.
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
      pc.call_alert_sent_at,
      pc.runner_alert_sent_at,
      COALESCE(pc.observation_snap_count, 0)::int AS observation_snap_count,
      t.address, t.chain, t.name, t.symbol, t.logo_uri, t.image_path,
      t.market_cap_usd, t.ath_market_cap_usd, t.volume_24h_usd,
      t.raw_metadata, t.holder_count,
      t.latest_holder_snapshot_id,
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
      t.pump_scan,
      ${MOMENTUM_SELECT},
      COALESCE(buys.wallet_buys, 0)::int AS wallet_buys,
      NULL::float8 AS buy_notional,
      cryp.crypsor_quality_n,
      cryp.crypsor_weight
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    ${SNAP1H_LATERAL}
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT tb.wallet_id)::int AS wallet_buys
      FROM token_buys tb
      WHERE tb.token_id = pc.token_id
    ) buys ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (
          WHERE e.our_label_at IN ('diamond', 'accumulator', 'solid')
        )::int AS crypsor_quality_n,
        COALESCE(SUM(i.weightage), 0)::float8 AS crypsor_weight
      FROM crypsor_wallet_token_events e
      JOIN crypsor_wallet_intel i ON i.wallet_address = e.wallet_address
      WHERE e.token_id = pc.token_id AND e.role = 'observed'
    ) cryp ON TRUE
    WHERE COALESCE(t.status, '') NOT IN ('ignored', 'archive')
      AND (
        pc.call_alert_sent_at IS NOT NULL
        OR pc.runner_alert_sent_at IS NOT NULL
      )
    ORDER BY pc.called_at DESC NULLS LAST
    LIMIT 400
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
    const ctoFlag = r.sec_cto_flag == null ? null : Boolean(r.sec_cto_flag);
    const creatorClose = r.sec_creator_close == null ? null : Boolean(r.sec_creator_close);
    const creatorCreatedCount = r.sec_creator_created_count != null
      ? Number(r.sec_creator_created_count)
      : null;

    const crypsorQualityN = r.crypsor_quality_n != null ? Number(r.crypsor_quality_n) : 0;
    const crypsorWeight = r.crypsor_weight != null ? Number(r.crypsor_weight) : 0;

    // Judging without winrate — WR is deferred to detail ?winrate=1
    const q = computeCallQuality({
      walletBuys,
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
      crypsorAvgWinRate: null,
      crypsorQualityHolders: crypsorQualityN,
      crypsorWeightage: crypsorWeight,
    });

    const ageSrc = r.token_created_at ?? r.first_detected_at;
    const firstSeen = ageSrc ? new Date(String(ageSrc)).getTime() : null;
    const tokenAgeMin = firstSeen != null && Number.isFinite(firstSeen)
      ? Math.max(0, Math.round((Date.now() - firstSeen) / 60_000))
      : null;

    const buyNotional = r.buy_notional != null ? Number(r.buy_notional) : null;
    const entryServed = Boolean(r.call_alert_sent_at || r.runner_alert_sent_at);
    const obsSnaps = Number(r.observation_snap_count ?? 0);
    const hasHolders = r.latest_holder_snapshot_id != null;
    const tagged = Number(r.called_smart_count ?? 0) + Number(r.called_kol_count ?? 0);
    const properServe = String(r.quality_label ?? "") === "very_good"
      && obsSnaps >= 5
      && hasHolders
      && tagged >= 1;

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
      avgWalletWinRate: null,
      holderQualityScore: r.holder_quality_score != null ? Number(r.holder_quality_score) : null,
      proScore: Number(r.pro_score ?? 0),
      qualityLabel: String(r.quality_label ?? "—"),
      callScore: q.score + (entryServed ? 8 : 0) + (properServe ? 4 : 0),
      callLabel: q.label,
      reasons: entryServed
        ? ["ENTRY served", ...q.reasons].slice(0, 4)
        : q.reasons,
      hit2x: Boolean(r.hit_2x) || athMultiple >= 2,
      hit5x: Boolean(r.hit_5x) || athMultiple >= 5,
      hit10x: Boolean(r.hit_10x) || athMultiple >= 10,
      volume24hUsd: r.volume_24h_usd != null ? parseFloat(String(r.volume_24h_usd)) || null : null,
      volumeIntensityScore: r.volume_intensity_score != null
        ? Number(r.volume_intensity_score) : null,
      mc1hUsd: parseMc1h(r.mc_1h),
      gain1hPct: resolveGain1hPct({
        currentMc,
        mc1hRaw: r.mc_1h,
        calledMc,
        calledAt: toIsoUtc(r.called_at ?? r.surfaced_at),
      }),
      momentum1h: Number(r.momentum_1h ?? 0) || 0,
      momentum6h: Number(r.momentum_6h ?? 0) || 0,
      tokenAgeMin,
      ctoFlag,
      creatorClose,
      creatorAddress: r.sec_creator_address != null ? String(r.sec_creator_address) : null,
      creatorCreatedCount,
      socials: extractSocials(r.raw_metadata),
      entryServed,
      properServe,
      ...pumpFieldsFromRow(r),
    };
  });

  // Rank: ENTRY-served first, then elite/strong, then score
  const rank = (c: CallCard) => {
    const served = c.entryServed ? 0 : c.properServe ? 1 : 2;
    const tier = c.callLabel === "elite" ? 0 : c.callLabel === "strong" ? 1 : c.callLabel === "watch" ? 2 : 3;
    return served * 10_000 + tier * 1000 - c.callScore;
  };
  cards.sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (b.calledAt ?? "").localeCompare(a.calledAt ?? "");
  });

  const sliced = cards.slice(0, limit);
  const payload = { cards: sliced, universe };
  // Short TTL — price service invalidates on desk ticks; keep warm briefly
  await proCacheSet(cacheKey, payload, 4);
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
      pc.call_alert_sent_at, pc.runner_alert_sent_at,
      COALESCE(pc.observation_snap_count, 0)::int AS observation_snap_count,
      t.address, t.chain, t.name, t.symbol, t.logo_uri, t.image_path,
      t.market_cap_usd, t.ath_market_cap_usd, t.volume_24h_usd,
      t.raw_metadata, t.holder_count, t.latest_holder_snapshot_id,
      t.holder_kol_count AS live_kol, t.holder_smart_count AS live_smart,
      t.holder_quality_score, t.holder_velocity_score, t.sec_is_honeypot,
      t.sec_cto_flag, t.sec_creator_close, t.sec_creator_address,
      t.sec_creator_created_count, t.token_created_at, t.first_detected_at,
      t.pump_scan,
      ${MOMENTUM_SELECT},
      0::int AS wallet_buys, NULL::float8 AS buy_notional, NULL::float8 AS avg_win_rate
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    ${SNAP1H_LATERAL}
    WHERE COALESCE(t.status, '') NOT IN ('ignored', 'archive')
      AND (
        pc.call_alert_sent_at IS NOT NULL
        OR pc.runner_alert_sent_at IS NOT NULL
      )
    ORDER BY pc.called_at DESC NULLS LAST
    LIMIT ${Math.min(limit, 200)}
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
    const entryServed = Boolean(r.call_alert_sent_at || r.runner_alert_sent_at);
    const obsSnaps = Number(r.observation_snap_count ?? 0);
    const tagged = Number(r.called_smart_count ?? 0) + Number(r.called_kol_count ?? 0);
    const properServe = String(r.quality_label ?? "") === "very_good"
      && obsSnaps >= 5
      && r.latest_holder_snapshot_id != null
      && tagged >= 1;
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
      callScore: q.score + (entryServed ? 8 : 0) + (properServe ? 4 : 0),
      callLabel: q.label,
      reasons: entryServed ? ["ENTRY served", ...q.reasons].slice(0, 4) : q.reasons,
      hit2x: Boolean(r.hit_2x) || athMultiple >= 2,
      hit5x: Boolean(r.hit_5x) || athMultiple >= 5,
      hit10x: Boolean(r.hit_10x) || athMultiple >= 10,
      volume24hUsd: r.volume_24h_usd != null ? parseFloat(String(r.volume_24h_usd)) || null : null,
      volumeIntensityScore: r.volume_intensity_score != null
        ? Number(r.volume_intensity_score) : null,
      mc1hUsd: parseMc1h(r.mc_1h),
      gain1hPct: resolveGain1hPct({
        currentMc,
        mc1hRaw: r.mc_1h,
        calledMc,
        calledAt: toIsoUtc(r.called_at ?? r.surfaced_at),
      }),
      momentum1h: Number(r.momentum_1h ?? 0) || 0,
      momentum6h: Number(r.momentum_6h ?? 0) || 0,
      tokenAgeMin: firstSeen != null && Number.isFinite(firstSeen)
        ? Math.max(0, Math.round((Date.now() - firstSeen) / 60_000)) : null,
      ctoFlag,
      creatorClose,
      creatorAddress: r.sec_creator_address != null ? String(r.sec_creator_address) : null,
      creatorCreatedCount,
      socials: extractSocials(r.raw_metadata),
      entryServed,
      properServe,
      ...pumpFieldsFromRow(r),
    };
  });
  cards.sort((a, b) => {
    const sa = a.entryServed ? 0 : a.properServe ? 1 : 2;
    const sb = b.entryServed ? 0 : b.properServe ? 1 : 2;
    if (sa !== sb) return sa - sb;
    return b.callScore - a.callScore;
  });
  return { cards: cards.slice(0, limit), universe };
}

/** Single-token card — avoids loadCallCards(200) on detail. */
async function loadPumpBuyTokenCard(tokenId: number): Promise<CallCard | null> {
  const rows = await db.execute(sql`
    SELECT
      t.id AS token_id,
      t.address, t.chain, t.name, t.symbol, t.logo_uri, t.image_path,
      t.market_cap_usd, t.ath_market_cap_usd, t.volume_24h_usd,
      t.raw_metadata, t.holder_count,
      t.token_created_at, t.first_detected_at, t.last_buy_at,
      COALESCE(t.migrated, false) AS migrated,
      t.creator_username, t.pump_ath_market_cap_usd, t.creator_stats,
      t.sec_creator_address, t.sec_creator_created_count,
      t.pump_scan,
      COALESCE(t.momentum_1h, 0)::int AS momentum_1h,
      COALESCE(t.momentum_6h, 0)::int AS momentum_6h,
      t.volume_intensity_score,
      COALESCE(buys.wallet_buys, 0)::int AS wallet_buys
    FROM tracked_tokens t
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT tb.wallet_id)::int AS wallet_buys
      FROM token_buys tb
      WHERE tb.token_id = t.id
    ) buys ON TRUE
    WHERE t.id = ${tokenId}
      AND EXISTS (SELECT 1 FROM token_buys tb WHERE tb.token_id = t.id)
    LIMIT 1
  `);
  const r = (rows.rows[0] ?? null) as Record<string, unknown> | null;
  if (!r) return null;

  const pump = pumpFieldsFromRow(r);
  const currentMc = r.market_cap_usd != null
    ? parseFloat(String(r.market_cap_usd)) || null
    : (pump.pumpMarketCap ?? null);
  const pumpAth = r.pump_ath_market_cap_usd != null
    ? Number(r.pump_ath_market_cap_usd)
    : null;
  const creatorStats = (r.creator_stats && typeof r.creator_stats === "object")
    ? (r.creator_stats as CreatorStatsPayload)
    : null;

  return {
    id: Number(r.token_id),
    address: String(r.address),
    chain: String(r.chain ?? "solana"),
    name: (r.name as string | null) ?? null,
    symbol: (r.symbol as string | null) ?? null,
    logoUri: resolveLogoUri(r.image_path, r.logo_uri),
    calledAt: toIsoUtc(r.last_buy_at ?? r.first_detected_at),
    calledMcUsd: null,
    currentMcUsd: currentMc,
    athMcUsd: r.ath_market_cap_usd != null ? parseFloat(String(r.ath_market_cap_usd)) || null : null,
    gainPct: pump.pumpGainSinceDetection,
    nowMultiple: 1,
    athMultiple: 1,
    walletBuys: Number(r.wallet_buys ?? 0),
    buyVolumeHintUsd: null,
    calledKol: 0,
    calledSmart: 0,
    liveKol: 0,
    liveSmart: 0,
    holderCount: r.holder_count != null ? Number(r.holder_count) : null,
    avgWalletWinRate: null,
    holderQualityScore: null,
    proScore: pump.pumpScore ?? 0,
    qualityLabel: pump.pumpRecommendation ?? "—",
    callScore: pump.pumpScore ?? 0,
    callLabel: "watch",
    reasons: [
      pump.pumpRecommendation,
      ...pump.pumpTags.slice(0, 3).map((t) => t.label),
    ].filter(Boolean) as string[],
    hit2x: (pump.pumpAthGain ?? 0) >= 100,
    hit5x: (pump.pumpAthGain ?? 0) >= 400,
    hit10x: (pump.pumpAthGain ?? 0) >= 900,
    volume24hUsd: pump.pumpVolume24h
      ?? (r.volume_24h_usd != null ? parseFloat(String(r.volume_24h_usd)) || null : null),
    volumeIntensityScore: r.volume_intensity_score != null
      ? Number(r.volume_intensity_score) : null,
    gain1hPct: null,
    momentum1h: Number(r.momentum_1h ?? 0) || 0,
    momentum6h: Number(r.momentum_6h ?? 0) || 0,
    tokenAgeMin: pump.pumpPairCreatedAt
      ? Math.max(0, Math.round((Date.now() - pump.pumpPairCreatedAt) / 60_000))
      : null,
    ctoFlag: null,
    creatorClose: null,
    creatorAddress: r.sec_creator_address != null ? String(r.sec_creator_address) : null,
    creatorCreatedCount: r.sec_creator_created_count != null
      ? Number(r.sec_creator_created_count) : null,
    graduated: Boolean(r.migrated),
    creatorUsername: r.creator_username != null ? String(r.creator_username) : null,
    pumpAthMcUsd: pumpAth != null && Number.isFinite(pumpAth) ? pumpAth : null,
    creatorStats,
    socials: extractSocials(r.raw_metadata),
    entryServed: true,
    properServe: pump.pumpGrade === "S" || pump.pumpGrade === "A",
    ...pump,
  };
}

/** LEGACY — requires pro_calls. Prefer loadPumpBuyTokenCard for the active desk. */
async function loadSingleCallCard(tokenId: number): Promise<CallCard | null> {
  const rows = await db.execute(sql`
    SELECT
      pc.token_id, pc.called_at, pc.called_mc_usd,
      pc.called_kol_count, pc.called_smart_count,
      pc.ath_multiple, pc.pro_score, pc.quality_label,
      pc.hit_2x, pc.hit_5x, pc.hit_10x, pc.surfaced_at,
      pc.call_alert_sent_at, pc.runner_alert_sent_at,
      COALESCE(pc.observation_snap_count, 0)::int AS observation_snap_count,
      t.address, t.chain, t.name, t.symbol, t.logo_uri, t.image_path,
      t.market_cap_usd, t.ath_market_cap_usd, t.volume_24h_usd,
      t.raw_metadata, t.holder_count, t.latest_holder_snapshot_id,
      t.holder_kol_count AS live_kol, t.holder_smart_count AS live_smart,
      t.holder_quality_score, t.holder_velocity_score, t.sec_is_honeypot,
      t.sec_cto_flag, t.sec_creator_close, t.sec_creator_address,
      t.sec_creator_created_count, t.token_created_at, t.first_detected_at,
      COALESCE(t.migrated, false) AS migrated,
      t.creator_username, t.pump_ath_market_cap_usd, t.creator_stats,
      t.pump_scan,
      ${MOMENTUM_SELECT},
      COALESCE(buys.wallet_buys, 0)::int AS wallet_buys,
      cryp.crypsor_quality_n,
      cryp.crypsor_weight
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    ${SNAP1H_LATERAL}
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT tb.wallet_id)::int AS wallet_buys
      FROM token_buys tb
      WHERE tb.token_id = pc.token_id
    ) buys ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (
          WHERE e.our_label_at IN ('diamond', 'accumulator', 'solid')
        )::int AS crypsor_quality_n,
        COALESCE(SUM(i.weightage), 0)::float8 AS crypsor_weight
      FROM crypsor_wallet_token_events e
      JOIN crypsor_wallet_intel i ON i.wallet_address = e.wallet_address
      WHERE e.token_id = pc.token_id AND e.role = 'observed'
    ) cryp ON TRUE
    WHERE pc.token_id = ${tokenId}
    LIMIT 1
  `);
  const r = (rows.rows[0] ?? null) as Record<string, unknown> | null;
  if (!r) return null;

  const calledMc = r.called_mc_usd != null ? parseFloat(String(r.called_mc_usd)) : null;
  const currentMc = r.market_cap_usd != null ? parseFloat(String(r.market_cap_usd)) || null : null;
  const athMultiple = Number(r.ath_multiple ?? 1) || 1;
  const athMcRaw = r.ath_market_cap_usd != null ? parseFloat(String(r.ath_market_cap_usd)) : null;
  const athMc = athMcRaw && athMcRaw > 0
    ? athMcRaw
    : (calledMc && athMultiple > 1 ? calledMc * athMultiple : currentMc);
  const walletBuys = Number(r.wallet_buys ?? 0);
  const ctoFlag = r.sec_cto_flag == null ? null : Boolean(r.sec_cto_flag);
  const creatorClose = r.sec_creator_close == null ? null : Boolean(r.sec_creator_close);
  const creatorCreatedCount = r.sec_creator_created_count != null
    ? Number(r.sec_creator_created_count) : null;
  const crypsorQualityN = r.crypsor_quality_n != null ? Number(r.crypsor_quality_n) : 0;
  const crypsorWeight = r.crypsor_weight != null ? Number(r.crypsor_weight) : 0;
  const q = computeCallQuality({
    walletBuys,
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
    crypsorAvgWinRate: null,
    crypsorQualityHolders: crypsorQualityN,
    crypsorWeightage: crypsorWeight,
  });
  const ageSrc = r.token_created_at ?? r.first_detected_at;
  const firstSeen = ageSrc ? new Date(String(ageSrc)).getTime() : null;
  const entryServed = Boolean(r.call_alert_sent_at || r.runner_alert_sent_at);
  const obsSnaps = Number(r.observation_snap_count ?? 0);
  const tagged = Number(r.called_smart_count ?? 0) + Number(r.called_kol_count ?? 0);
  const properServe = String(r.quality_label ?? "") === "very_good"
    && obsSnaps >= 5
    && r.latest_holder_snapshot_id != null
    && tagged >= 1;
  const nowMultiple = calledMc && currentMc && calledMc > 0
    ? Math.round((currentMc / calledMc) * 100) / 100
    : 1;

  const pumpAth = r.pump_ath_market_cap_usd != null
    ? Number(r.pump_ath_market_cap_usd)
    : null;
  const creatorStats = (r.creator_stats && typeof r.creator_stats === "object")
    ? (r.creator_stats as CreatorStatsPayload)
    : null;

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
    walletBuys,
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
    callScore: q.score + (entryServed ? 8 : 0) + (properServe ? 4 : 0),
    callLabel: q.label,
    reasons: entryServed ? ["ENTRY served", ...q.reasons].slice(0, 4) : q.reasons,
    hit2x: Boolean(r.hit_2x) || athMultiple >= 2,
    hit5x: Boolean(r.hit_5x) || athMultiple >= 5,
    hit10x: Boolean(r.hit_10x) || athMultiple >= 10,
    volume24hUsd: r.volume_24h_usd != null ? parseFloat(String(r.volume_24h_usd)) || null : null,
    volumeIntensityScore: r.volume_intensity_score != null
      ? Number(r.volume_intensity_score) : null,
    mc1hUsd: parseMc1h(r.mc_1h),
    gain1hPct: resolveGain1hPct({
      currentMc,
      mc1hRaw: r.mc_1h,
      calledMc,
      calledAt: toIsoUtc(r.called_at ?? r.surfaced_at),
    }),
    momentum1h: Number(r.momentum_1h ?? 0) || 0,
    momentum6h: Number(r.momentum_6h ?? 0) || 0,
    tokenAgeMin: firstSeen != null && Number.isFinite(firstSeen)
      ? Math.max(0, Math.round((Date.now() - firstSeen) / 60_000)) : null,
    ctoFlag,
    creatorClose,
    creatorAddress: r.sec_creator_address != null ? String(r.sec_creator_address) : null,
    creatorCreatedCount,
    graduated: Boolean(r.migrated),
    creatorUsername: r.creator_username != null ? String(r.creator_username) : null,
    pumpAthMcUsd: pumpAth != null && Number.isFinite(pumpAth) ? pumpAth : null,
    creatorStats,
    socials: extractSocials(r.raw_metadata),
    entryServed,
    properServe,
    ...pumpFieldsFromRow(r),
  };
}

/** On-demand buyer + Crypsor win-rate aggregates for one token. */
async function loadTokenWinrate(tokenId: number): Promise<{
  avgWalletWinRate: number | null;
  crypsorAvgWinRate: number | null;
}> {
  const rows = await db.execute(sql`
    SELECT
      (
        SELECT AVG(wp.win_rate) FILTER (WHERE wp.win_rate IS NOT NULL)
        FROM token_buys tb
        JOIN walletdatasource w ON w.id = tb.wallet_id
        LEFT JOIN wallet_profiles wp ON wp.wallet_address = w.address
        WHERE tb.token_id = ${tokenId}
      ) AS avg_win_rate,
      (
        SELECT AVG(i.win_rate) FILTER (WHERE i.win_rate IS NOT NULL)
        FROM crypsor_wallet_token_events e
        JOIN crypsor_wallet_intel i ON i.wallet_address = e.wallet_address
        WHERE e.token_id = ${tokenId} AND e.role = 'observed'
      ) AS crypsor_avg_wr
  `);
  const r = (rows.rows[0] ?? {}) as Record<string, unknown>;
  const avg = r.avg_win_rate != null ? Number(r.avg_win_rate) : null;
  const cwr = r.crypsor_avg_wr != null ? Number(r.crypsor_avg_wr) : null;
  return {
    avgWalletWinRate: avg != null && Number.isFinite(avg) ? Math.round(avg * 1000) / 1000 : null,
    crypsorAvgWinRate: cwr != null && Number.isFinite(cwr) ? Math.round(cwr * 1000) / 1000 : null,
  };
}

export type WaitingCallCard = CallCard & {
  runnerPhase: RunnerPhase;
  runnerScore: number;
  runnerLabel: string;
  alertEligible: boolean;
  blockers: string[];
  snapCount: number;
  snapsNeeded: number;
  observationReady: boolean;
  /** One-line why Telegram ENTRY is held. */
  holdReason: string;
};

async function loadWaitingCalls(limit: number): Promise<{
  cards: WaitingCallCard[];
  pendingFirstCalls: number;
}> {
  // v7: wallet_buys join + momentum/1h for table filters
  const cacheKey = `calls:waiting:v8-pump:${limit}`;
  const cached = await proCacheGet<{ cards: WaitingCallCard[]; pendingFirstCalls: number }>(cacheKey);
  if (cached?.cards) return cached;

  // Waiting = not yet ENTRY-served (no Telegram / in-app ENTRY ping).
  // Kept separate from Best/Hot so win-rate / ENTRY math never carries these.
  const rows = await db.execute(sql`
    SELECT
      pc.token_id, pc.called_at, pc.called_mc_usd,
      pc.called_kol_count, pc.called_smart_count, pc.called_intel_score,
      pc.called_holder_velocity,
      pc.ath_multiple, pc.pro_score, pc.quality_label,
      pc.hit_2x, pc.hit_5x, pc.hit_10x, pc.surfaced_at,
      pc.call_alert_sent_at, pc.runner_alert_sent_at,
      pc.runner_score, pc.runner_phase, pc.verified_wallets,
      GREATEST(
        COALESCE(pc.observation_snap_count, 0),
        (SELECT COUNT(*)::int FROM pro_snapshots ps WHERE ps.pro_call_id = pc.id)
      )::int AS snap_count,
      t.address, t.chain, t.name, t.symbol, t.logo_uri, t.image_path,
      t.market_cap_usd, t.ath_market_cap_usd, t.volume_24h_usd,
      t.raw_metadata, t.holder_count, t.latest_holder_snapshot_id,
      t.holder_kol_count AS live_kol, t.holder_smart_count AS live_smart,
      t.holder_quality_score, t.holder_velocity_score,
      t.sec_is_honeypot, t.sec_mint_renounced, t.sec_freeze_renounced,
      t.sec_cto_flag, t.sec_creator_close, t.sec_creator_address,
      t.sec_creator_created_count, t.token_created_at, t.first_detected_at,
      t.pump_scan,
      COALESCE(buys.wallet_buys, 0)::int AS wallet_buys,
      ${MOMENTUM_SELECT}
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    ${SNAP1H_LATERAL}
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT tb.wallet_id)::int AS wallet_buys
      FROM token_buys tb
      WHERE tb.token_id = pc.token_id
    ) buys ON TRUE
    WHERE COALESCE(t.status, '') NOT IN ('ignored', 'archive')
      AND pc.call_alert_sent_at IS NULL
      AND pc.runner_alert_sent_at IS NULL
      AND pc.quality_label IN ('good', 'very_good')
    ORDER BY pc.called_at DESC NULLS LAST
    LIMIT ${Math.min(Math.max(limit, 1), 200)}
  `);

  const cards: WaitingCallCard[] = (rows.rows as Array<Record<string, unknown>>).map(r => {
    const calledMc = r.called_mc_usd != null ? parseFloat(String(r.called_mc_usd)) : null;
    const currentMc = r.market_cap_usd != null ? parseFloat(String(r.market_cap_usd)) || null : null;
    const athMultiple = Number(r.ath_multiple ?? 1) || 1;
    const athMcRaw = r.ath_market_cap_usd != null ? parseFloat(String(r.ath_market_cap_usd)) : null;
    const athMc = athMcRaw && athMcRaw > 0
      ? athMcRaw
      : (calledMc && athMultiple > 1 ? calledMc * athMultiple : currentMc);
    const gainPct = calledMc && currentMc && calledMc > 0
      ? ((currentMc - calledMc) / calledMc) * 100
      : null;
    const nowMultiple = calledMc && currentMc && calledMc > 0
      ? Math.round((currentMc / calledMc) * 100) / 100
      : 1;
    const velocity = calledMc && currentMc && calledMc > 0 ? currentMc / calledMc : 1;
    const ageMin = r.called_at
      ? (Date.now() - new Date(String(r.called_at)).getTime()) / 60_000
      : 9999;
    const snapCount = Number(r.snap_count ?? 0) || 0;
    const vw = convictionFieldsFromVerified(r.verified_wallets);
    const prevPhase = r.runner_phase != null ? String(r.runner_phase) as RunnerPhase : null;
    const prevScore = r.runner_score != null ? Number(r.runner_score) : null;
    const runner = computeRunnerScore({
      calledIntelScore: r.called_intel_score != null ? Number(r.called_intel_score) : null,
      calledSmartCount: Number(r.called_smart_count ?? 0),
      calledKolCount: Number(r.called_kol_count ?? 0),
      calledMcUsd: calledMc,
      currentMcUsd: currentMc,
      athMultiple,
      gainPct: gainPct ?? 0,
      ageMinutes: ageMin,
      velocity,
      snapDeltaPct: null,
      liveSmart: Number(r.live_smart ?? 0),
      liveKol: Number(r.live_kol ?? 0),
      secIsHoneypot: r.sec_is_honeypot as boolean | null,
      secMintRenounced: r.sec_mint_renounced as boolean | null,
      secFreezeRenounced: r.sec_freeze_renounced as boolean | null,
      holderVelocityScore: r.holder_velocity_score != null ? Number(r.holder_velocity_score) : null,
      volumeIntensityScore: r.volume_intensity_score != null ? Number(r.volume_intensity_score) : null,
      smartHoldRate: vw.smartHoldRate,
      prevPhase,
      prevScore,
      snapCount,
    });

    const ageSrc = r.token_created_at ?? r.first_detected_at;
    const firstSeen = ageSrc ? new Date(String(ageSrc)).getTime() : null;
    const tokenAgeMin = firstSeen != null && Number.isFinite(firstSeen)
      ? Math.max(0, Math.round((Date.now() - firstSeen) / 60_000))
      : null;

    const walletBuys = Number(r.wallet_buys ?? 0);
    const q = computeCallQuality({
      walletBuys,
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
      ctoFlag: r.sec_cto_flag == null ? null : Boolean(r.sec_cto_flag),
      creatorClose: r.sec_creator_close == null ? null : Boolean(r.sec_creator_close),
      creatorCreatedCount: r.sec_creator_created_count != null
        ? Number(r.sec_creator_created_count)
        : null,
    });

    const snapsNeeded = Math.max(0, MIN_ENTRY_OBSERVATION_SNAPS - snapCount);
    const isCto = r.sec_cto_flag === true || r.sec_cto_flag === 1 || r.sec_cto_flag === "1";
    const holdReason = runner.alertEligible && runner.phase === "entry"
      ? "Ready — next alert cycle should ping"
      : isCto && !(runner.alertEligible && runner.phase === "entry")
        ? (runner.blockers[0]
          ? `CTO valued · hold: ${runner.blockers[0]}`
          : "CTO valued — waiting on ENTRY gates")
        : runner.blockers[0]
          ?? (!runner.signals.observationReady
            ? `Observing ${snapCount}/${MIN_ENTRY_OBSERVATION_SNAPS} snaps`
            : runner.phase === "heating"
              ? "Heating — waiting for ENTRY velocity"
              : runner.phase === "radar"
                ? "Radar — building structure"
                : `Held · ${runner.label}`);

    const base: CallCard = {
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
      buyVolumeHintUsd: null,
      calledKol: Number(r.called_kol_count ?? 0),
      calledSmart: Number(r.called_smart_count ?? 0),
      liveKol: Number(r.live_kol ?? 0),
      liveSmart: Number(r.live_smart ?? 0),
      holderCount: r.holder_count != null ? Number(r.holder_count) : null,
      avgWalletWinRate: null,
      holderQualityScore: r.holder_quality_score != null ? Number(r.holder_quality_score) : null,
      proScore: Number(r.pro_score ?? 0),
      qualityLabel: String(r.quality_label ?? "very_good"),
      callScore: q.score,
      callLabel: q.label,
      reasons: q.reasons,
      hit2x: Boolean(r.hit_2x) || athMultiple >= 2,
      hit5x: Boolean(r.hit_5x) || athMultiple >= 5,
      hit10x: Boolean(r.hit_10x) || athMultiple >= 10,
      volume24hUsd: r.volume_24h_usd != null ? parseFloat(String(r.volume_24h_usd)) || null : null,
      volumeIntensityScore: r.volume_intensity_score != null
        ? Number(r.volume_intensity_score) : null,
      mc1hUsd: parseMc1h(r.mc_1h),
      gain1hPct: resolveGain1hPct({
        currentMc,
        mc1hRaw: r.mc_1h,
        calledMc,
        calledAt: toIsoUtc(r.called_at ?? r.surfaced_at),
      }),
      momentum1h: Number(r.momentum_1h ?? 0) || 0,
      momentum6h: Number(r.momentum_6h ?? 0) || 0,
      tokenAgeMin,
      ctoFlag: r.sec_cto_flag == null ? null : Boolean(r.sec_cto_flag),
      creatorClose: r.sec_creator_close == null ? null : Boolean(r.sec_creator_close),
      creatorAddress: r.sec_creator_address != null ? String(r.sec_creator_address) : null,
      creatorCreatedCount: r.sec_creator_created_count != null
        ? Number(r.sec_creator_created_count)
        : null,
      socials: extractSocials(r.raw_metadata),
      entryServed: false,
      properServe: snapCount >= 5
        && r.latest_holder_snapshot_id != null
        && (Number(r.called_smart_count ?? 0) + Number(r.called_kol_count ?? 0)) >= 1,
      ...pumpFieldsFromRow(r),
    };

    return {
      ...base,
      runnerPhase: runner.phase,
      runnerScore: runner.score,
      runnerLabel: runner.label,
      alertEligible: runner.alertEligible,
      blockers: runner.blockers,
      snapCount,
      snapsNeeded,
      observationReady: runner.signals.observationReady,
      holdReason,
      reasons: [
        holdReason,
        ...runner.reasons.slice(0, 2),
      ].slice(0, 4),
    };
  });

  // Strict latest-called order (SQL already DESC; re-assert for safety)
  cards.sort((a, b) => (b.calledAt ?? "").localeCompare(a.calledAt ?? ""));

  const payload = { cards, pendingFirstCalls: cards.length };
  // Short TTL — desk price refresher invalidates on each tick
  await proCacheSet(cacheKey, payload, 3);
  return payload;
}

type FeedFilters = {
  label?: string;       // callLabel: elite|strong|watch|noise
  quality?: string;     // qualityLabel: very_good|good|below
  minScore?: number;    // callScore
  minVol1h?: number;    // volumeIntensityScore 0–100 (NOT a percent)
  minGain1h?: number;   // gain1hPct % (snapshot ~1h / since-call if young)
  minMom1h?: number;
  minMom6h?: number;
  /** Pump-SDK grade filter: S|A|B|C|D or top (S+A) */
  pumpGrade?: string;
  /** Pump signal preset: buy|watch|intra|micro|dev */
  pumpSignal?: string;
  minPumpScore?: number;
};

function parseFeedFilters(q: Record<string, unknown>): FeedFilters {
  const num = (k: string) => {
    const v = parseFloat(String(q[k] ?? ""));
    return Number.isFinite(v) ? v : undefined;
  };
  const label = String(q.label ?? "").trim().toLowerCase();
  const quality = String(q.quality ?? "").trim().toLowerCase();
  const pumpGrade = String(q.pumpGrade ?? "").trim().toUpperCase();
  const pumpSignal = String(q.pumpSignal ?? "").trim().toLowerCase();
  return {
    label: label && label !== "all" ? label : undefined,
    quality: quality && quality !== "all" ? quality : undefined,
    minScore: num("minScore"),
    minVol1h: num("minVol1h"),
    minGain1h: num("minGain1h"),
    minMom1h: num("minMom1h"),
    minMom6h: num("minMom6h"),
    pumpGrade: pumpGrade && pumpGrade !== "ALL" ? pumpGrade : undefined,
    pumpSignal: pumpSignal && pumpSignal !== "all" ? pumpSignal : undefined,
    minPumpScore: num("minPumpScore"),
  };
}

function applyFeedFilters<T extends CallCard>(cards: T[], f: FeedFilters): T[] {
  return cards.filter(c => {
    if (f.label && c.callLabel !== f.label) return false;
    if (f.quality && c.qualityLabel !== f.quality) return false;
    if (f.minScore != null && c.callScore < f.minScore) return false;
    if (f.minVol1h != null && (c.volumeIntensityScore ?? 0) < f.minVol1h) return false;
    if (f.minGain1h != null && (c.gain1hPct ?? -Infinity) < f.minGain1h) return false;
    if (f.minMom1h != null && c.momentum1h < f.minMom1h) return false;
    if (f.minMom6h != null && c.momentum6h < f.minMom6h) return false;
    if (f.minPumpScore != null && (c.pumpScore ?? -Infinity) < f.minPumpScore) return false;
    if (f.pumpGrade) {
      if (f.pumpGrade === "TOP") {
        if (c.pumpGrade !== "S" && c.pumpGrade !== "A") return false;
      } else if (c.pumpGrade !== f.pumpGrade) {
        return false;
      }
    }
    if (f.pumpSignal) {
      switch (f.pumpSignal) {
        case "buy":
          if (c.pumpBuySignal !== "STRONG_BUY") return false;
          break;
        case "watch":
          if (c.pumpBuySignal !== "WATCH") return false;
          break;
        case "intra":
          if (c.pumpIntraSignal !== "INTRA_NOW" && c.pumpIntraSignal !== "INTRA_SOON") return false;
          break;
        case "micro":
          if (!c.pumpTags.some((t) => t.label === "Micro Cap")) return false;
          break;
        case "dev":
          if (!c.pumpTags.some((t) => t.label === "Dev Narrative" || t.label === "Larry Signal")) {
            return false;
          }
          break;
        default:
          break;
      }
    }
    return true;
  });
}

function paginateCards<T>(cards: T[], page: number, limit: number) {
  const total = cards.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(Math.max(page, 1), pages);
  const start = (safePage - 1) * limit;
  return {
    cards: cards.slice(start, start + limit),
    total,
    page: safePage,
    pages,
    limit,
  };
}

/**
 * v2 desk — buy-sourced tokens only, ranked by pump-fullend strategy score.
 * Crypsor call-quality / pro_calls / GMGN are NOT used here (kept as backup loaders below).
 */
async function loadPumpBuyDeskCards(limit = 400): Promise<{ cards: CallCard[]; universe: number }> {
  const cacheKey = `calls:feed:v12-pump-buys:${limit}`;
  const cached = await proCacheGet<{ cards: CallCard[]; universe: number }>(cacheKey);
  if (cached?.cards?.length) return cached;

  const universeRow = await db.execute(sql`
    SELECT COUNT(DISTINCT tb.token_id)::int AS n
    FROM token_buys tb
    JOIN tracked_tokens t ON t.id = tb.token_id
    WHERE t.chain = 'solana'
      AND COALESCE(t.status, '') NOT IN ('ignored', 'archive')
  `);
  const universe = Number((universeRow.rows[0] as { n?: number })?.n ?? 0);

  const rows = await db.execute(sql`
    SELECT
      t.id AS token_id,
      t.address, t.chain, t.name, t.symbol, t.logo_uri, t.image_path,
      t.market_cap_usd, t.ath_market_cap_usd, t.volume_24h_usd,
      t.raw_metadata, t.holder_count,
      t.token_created_at, t.first_detected_at, t.last_buy_at,
      t.pump_scan,
      COALESCE(t.momentum_1h, 0)::int AS momentum_1h,
      COALESCE(t.momentum_6h, 0)::int AS momentum_6h,
      t.volume_intensity_score,
      COALESCE(buys.wallet_buys, 0)::int AS wallet_buys
    FROM tracked_tokens t
    JOIN LATERAL (
      SELECT COUNT(DISTINCT tb.wallet_id)::int AS wallet_buys,
             MAX(tb.bought_at) AS last_bought
      FROM token_buys tb
      WHERE tb.token_id = t.id
    ) buys ON buys.wallet_buys > 0
    WHERE t.chain = 'solana'
      AND COALESCE(t.status, '') NOT IN ('ignored', 'archive')
      AND t.pump_scan IS NOT NULL
    ORDER BY buys.last_bought DESC NULLS LAST
    LIMIT ${Math.min(Math.max(limit, 1), 400)}
  `);

  const cards: CallCard[] = (rows.rows as Array<Record<string, unknown>>).map((r) => {
    const pump = pumpFieldsFromRow(r);
    const currentMc = r.market_cap_usd != null
      ? parseFloat(String(r.market_cap_usd)) || null
      : (pump.pumpMarketCap ?? null);
    const calledAt = toIsoUtc(r.last_buy_at ?? r.first_detected_at);
    return {
      id: Number(r.token_id),
      address: String(r.address),
      chain: String(r.chain ?? "solana"),
      name: (r.name as string | null) ?? null,
      symbol: (r.symbol as string | null) ?? null,
      logoUri: resolveLogoUri(r.image_path, r.logo_uri),
      calledAt,
      calledMcUsd: null,
      currentMcUsd: currentMc,
      athMcUsd: r.ath_market_cap_usd != null ? parseFloat(String(r.ath_market_cap_usd)) || null : null,
      gainPct: pump.pumpGainSinceDetection,
      nowMultiple: 1,
      athMultiple: 1,
      walletBuys: Number(r.wallet_buys ?? 0),
      buyVolumeHintUsd: null,
      calledKol: 0,
      calledSmart: 0,
      liveKol: 0,
      liveSmart: 0,
      holderCount: r.holder_count != null ? Number(r.holder_count) : null,
      avgWalletWinRate: null,
      holderQualityScore: null,
      proScore: pump.pumpScore ?? 0,
      qualityLabel: pump.pumpRecommendation ?? "—",
      // Backup fields kept for type compat — desk UI ignores Crypsor labels
      callScore: pump.pumpScore ?? 0,
      callLabel: "watch",
      reasons: [
        pump.pumpRecommendation,
        ...(pump.pumpTags.slice(0, 3).map((t) => t.label)),
      ].filter(Boolean) as string[],
      hit2x: (pump.pumpAthGain ?? 0) >= 100,
      hit5x: (pump.pumpAthGain ?? 0) >= 400,
      hit10x: (pump.pumpAthGain ?? 0) >= 900,
      volume24hUsd: pump.pumpVolume24h
        ?? (r.volume_24h_usd != null ? parseFloat(String(r.volume_24h_usd)) || null : null),
      volumeIntensityScore: r.volume_intensity_score != null
        ? Number(r.volume_intensity_score) : null,
      gain1hPct: null,
      momentum1h: Number(r.momentum_1h ?? 0) || 0,
      momentum6h: Number(r.momentum_6h ?? 0) || 0,
      tokenAgeMin: pump.pumpPairCreatedAt
        ? Math.max(0, Math.round((Date.now() - pump.pumpPairCreatedAt) / 60_000))
        : null,
      ctoFlag: null,
      creatorClose: null,
      creatorAddress: null,
      creatorCreatedCount: null,
      socials: extractSocials(r.raw_metadata),
      entryServed: true,
      properServe: (pump.pumpGrade === "S" || pump.pumpGrade === "A"),
      ...pump,
    };
  });

  const payload = { cards, universe };
  await proCacheSet(cacheKey, payload, 4);
  return payload;
}

const PUMP_FILTERS = new Set([
  "all", "top", "intra", "buy", "watch", "micro", "new", "volume", "dev", "gained",
]);
const PUMP_SORTS = new Set([
  "score", "gain_now", "ath_gain", "volume", "price_change", "newest", "oldest_detect", "txns",
]);

router.get("/calls/feed", async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 20);
    const page = Math.max(parseInt(String(req.query.page ?? "1"), 10) || 1, 1);

    // Pump-fullend desk is default. Legacy Crypsor modes only if ?legacy=1
    const useLegacy = String(req.query.legacy ?? "") === "1";
    if (!useLegacy) {
      const filterRaw = String(req.query.filter ?? req.query.mode ?? "all").toLowerCase();
      const filter = (PUMP_FILTERS.has(filterRaw) ? filterRaw : "all") as PumpFilterId;
      const sortRaw = String(req.query.sort ?? "score").toLowerCase();
      const sort = (PUMP_SORTS.has(sortRaw) ? sortRaw : "score") as PumpSortId;
      const minScore = Math.max(0, parseFloat(String(req.query.minScore ?? req.query.minPumpScore ?? "0")) || 0);

      const pack = await loadPumpBuyDeskCards(400);
      const ranked = applyPumpDeskFilters(pack.cards, filter, sort, minScore);
      const pagePack = paginateCards(ranked, page, limit);
      pagePack.cards = await overlayLiveMarketCaps(pagePack.cards);

      res.setHeader("Cache-Control", "private, no-cache");
      res.json(apiOk({
        ...pagePack,
        universe: pack.universe,
        mode: filter,
        filter,
        sort,
        minScore,
        note: "Pump-SDK desk · buy-sourced tokens · pump-fullend scoring (no Crypsor/GMGN rank)",
      }));
      return;
    }

    // ── LEGACY BACKUP PATH (Crypsor scoring / ENTRY modes) — opt-in only ──
    const mode = String(req.query.mode ?? "latest");
    const filters = parseFeedFilters(req.query as Record<string, unknown>);

    if (mode === "waiting") {
      const pack = await loadWaitingCalls(200);
      const filtered = applyFeedFilters(pack.cards, filters);
      const pagePack = paginateCards(filtered, page, limit);
      pagePack.cards = refreshGain1hOnCards(await overlayLiveMarketCaps(pagePack.cards));
      res.setHeader("Cache-Control", "private, no-cache");
      res.json(apiOk({
        ...pagePack,
        universe: pack.pendingFirstCalls,
        mode: "waiting",
        pendingFirstCalls: pack.pendingFirstCalls,
        note: "LEGACY Waiting lane",
      }));
      return;
    }

    let pack: { cards: CallCard[]; universe: number };
    try {
      pack = await loadCallCards(400);
    } catch (primaryErr) {
      console.error("calls feed primary failed — lite fallback", primaryErr);
      pack = await loadCallCardsLite(200);
    }
    const { cards, universe } = pack;

    let out = cards.filter(c => c.entryServed);
    if (mode === "best") {
      out = [...out].sort((a, b) => {
        const tier = (l: CallCard["callLabel"]) =>
          l === "elite" ? 0 : l === "strong" ? 1 : l === "watch" ? 2 : 3;
        const d = tier(a.callLabel) - tier(b.callLabel);
        if (d !== 0) return d;
        return b.callScore - a.callScore;
      });
    } else if (mode === "hot") {
      out = [...out].sort((a, b) => {
        const heat = (c: CallCard) => {
          const g1h = c.gain1hPct != null && Number.isFinite(c.gain1hPct) ? c.gain1hPct : 0;
          const mom = Number(c.momentum1h ?? 0) || 0;
          const nowBoost = Math.max(0, (c.nowMultiple ?? 1) - 1) * 8;
          return g1h * 2.2 + mom * 0.6 + nowBoost;
        };
        const d = heat(b) - heat(a);
        if (d !== 0) return d;
        return (b.calledAt ?? "").localeCompare(a.calledAt ?? "");
      });
    } else {
      out = [...out].sort((a, b) => (b.calledAt ?? "").localeCompare(a.calledAt ?? ""));
    }

    out = applyFeedFilters(out, filters);
    const pagePack = paginateCards(out, page, limit);
    pagePack.cards = refreshGain1hOnCards(await overlayLiveMarketCaps(pagePack.cards));

    res.setHeader("Cache-Control", "private, no-cache");
    res.json(apiOk({
      ...pagePack,
      universe,
      mode,
      note: "LEGACY Crypsor desk",
    }));
  } catch (err) {
    console.error("calls feed error", err);
    res.status(500).json(apiFail("Internal server error", "calls_feed"));
  }
});

router.get("/calls/waiting", async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 20);
    const page = Math.max(parseInt(String(req.query.page ?? "1"), 10) || 1, 1);
    const filters = parseFeedFilters(req.query as Record<string, unknown>);
    const pack = await loadWaitingCalls(200);
    const filtered = applyFeedFilters(pack.cards, filters);
    const pagePack = paginateCards(filtered, page, limit);
    pagePack.cards = refreshGain1hOnCards(await overlayLiveMarketCaps(pagePack.cards));
    res.setHeader("Cache-Control", "private, no-cache");
    res.json(apiOk({
      ...pagePack,
      pendingFirstCalls: pack.pendingFirstCalls,
      note: "Waiting = latest-called pending ENTRY — separate from ENTRY-served desk",
    }));
  } catch (err) {
    console.error("calls waiting error", err);
    res.status(500).json(apiFail("Internal server error", "calls_waiting"));
  }
});

const STATS_PERIODS = new Set(["1d", "3d", "5d", "7d", "30d"]);

function statsPeriodDays(period: string): number {
  switch (period) {
    case "1d": return 1;
    case "3d": return 3;
    case "5d": return 5;
    case "7d": return 7;
    case "30d": return 30;
    default: return 7;
  }
}

router.get("/calls/stats", async (req, res) => {
  try {
    const rawPeriod = String(req.query.period ?? "7d").toLowerCase();
    const period = STATS_PERIODS.has(rawPeriod) ? rawPeriod : "7d";
    const days = statsPeriodDays(period);

    const cacheKey = `calls:stats:v4:entry:${period}`;
    const cached = await proCacheGet<Record<string, unknown>>(cacheKey);
    if (cached) {
      res.json(apiOk(cached, { cache: "hit" }));
      return;
    }

    // Win-rate = ENTRY-served only (Telegram or in-app ENTRY ping).
    // desk_raw kept for clarity vs the old good/very_good flood.
    const result = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE call_alert_sent_at IS NOT NULL OR runner_alert_sent_at IS NOT NULL
        )::int AS signals,
        COUNT(*) FILTER (
          WHERE (call_alert_sent_at IS NOT NULL OR runner_alert_sent_at IS NOT NULL)
            AND COALESCE(ath_multiple, 1) >= 2
        )::int AS wins_2x,
        COUNT(*) FILTER (
          WHERE (call_alert_sent_at IS NOT NULL OR runner_alert_sent_at IS NOT NULL)
            AND COALESCE(ath_multiple, 1) >= 5
        )::int AS wins_5x,
        COUNT(*) FILTER (
          WHERE (call_alert_sent_at IS NOT NULL OR runner_alert_sent_at IS NOT NULL)
            AND COALESCE(ath_multiple, 1) >= 10
        )::int AS wins_10x,
        AVG(ath_multiple) FILTER (
          WHERE call_alert_sent_at IS NOT NULL OR runner_alert_sent_at IS NOT NULL
        ) AS avg_ath,
        MAX(ath_multiple) FILTER (
          WHERE call_alert_sent_at IS NOT NULL OR runner_alert_sent_at IS NOT NULL
        ) AS best_ath,
        COUNT(*) FILTER (
          WHERE surfaced_at IS NOT NULL OR quality_label IN ('very_good','good')
        )::int AS desk_raw,
        COUNT(*) FILTER (
          WHERE runner_alert_sent_at IS NOT NULL
        )::int AS telegram_n,
        (
          SELECT t.symbol FROM pro_calls pc2
          JOIN tracked_tokens t ON t.id = pc2.token_id
          WHERE pc2.ath_multiple IS NOT NULL
            AND (pc2.call_alert_sent_at IS NOT NULL OR pc2.runner_alert_sent_at IS NOT NULL)
            AND pc2.called_at >= NOW() - (${days}::int * INTERVAL '1 day')
          ORDER BY pc2.ath_multiple DESC NULLS LAST
          LIMIT 1
        ) AS best_symbol
      FROM pro_calls
      WHERE called_at >= NOW() - (${days}::int * INTERVAL '1 day')
    `);
    const r = (result.rows[0] ?? {}) as Record<string, unknown>;
    const signals = Number(r.signals ?? 0);
    const wins = Number(r.wins_2x ?? 0);
    const deskRaw = Number(r.desk_raw ?? 0);
    const data = {
      period,
      days,
      scope: "entry_served",
      winRate: signals ? Math.round((wins / signals) * 1000) / 10 : 0,
      wins,
      signals,
      wins5x: Number(r.wins_5x ?? 0),
      wins10x: Number(r.wins_10x ?? 0),
      avgX: r.avg_ath != null ? Math.round(Number(r.avg_ath) * 100) / 100 : 0,
      bestX: r.best_ath != null ? Math.round(Number(r.best_ath) * 100) / 100 : 0,
      bestSymbol: r.best_symbol != null ? String(r.best_symbol) : null,
      deskRaw,
      telegramN: Number(r.telegram_n ?? 0),
      note: "Win-rate counts ENTRY-served calls only (not raw good desk flood)",
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

export type CallBuyer = {
  walletId: number;
  address: string;
  label: string;
  boughtAt: string | null;
  winRate: number | null;
  amount: string | null;
  priceUsd: string | null;
};

export type CallSnap = {
  at: string | null;
  mcUsd: number | null;
  athMultiple: number | null;
  gainPct: number | null;
  kol: number | null;
  smart: number | null;
};

/** Crypsor-owned holder judgment — not GMGN KOL/smart. */
export type CrypsorWalletRow = {
  address: string;
  ourLabel: string;
  behaviourScore: number;
  weightage: number;
  winRate: number | null;
  wins: number;
  losses: number;
  tokensSeen: number;
  sightings: number;
  holdPct: number | null;
  buyCount: number | null;
  sellCount: number | null;
  realizedPnl: number | null;
  reason: string | null;
  lastSeenAt: string | null;
};

router.get("/calls/token/:tokenId", async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (!Number.isFinite(tokenId)) {
      res.status(400).json(apiFail("Invalid token id", "bad_id"));
      return;
    }

    // Opt-in only — keeps default detail path free of wallet_profiles WR joins
    const wantWinrate = ["1", "true", "yes"].includes(
      String(req.query.winrate ?? "").toLowerCase(),
    );

    let card: CallCard | null = null;
    try {
      card = await loadPumpBuyTokenCard(tokenId);
    } catch (err) {
      console.warn("calls token pump card failed", err);
      card = null;
    }
    // Legacy backup if token has no buys / pump path miss
    if (!card) {
      try {
        card = await loadSingleCallCard(tokenId);
      } catch (err) {
        console.warn("calls token legacy card failed", err);
        card = null;
      }
    }

    // Enrich pump creator / graduation on detail open (cached 30m on token row)
    if (card?.address) {
      try {
        const enrich = await ensureTokenCreatorStats(tokenId, card.address);
        if (enrich) {
          const refreshed = await loadPumpBuyTokenCard(tokenId)
            ?? await loadSingleCallCard(tokenId);
          if (refreshed) card = refreshed;
          else {
            card = {
              ...card,
              graduated: enrich.graduated || card.graduated,
              creatorAddress: enrich.creatorAddress ?? card.creatorAddress,
              creatorUsername: enrich.creatorUsername ?? card.creatorUsername ?? null,
              creatorCreatedCount: enrich.creatorStats?.tokenCount ?? card.creatorCreatedCount,
              pumpAthMcUsd: enrich.pumpAthMarketCapUsd ?? card.pumpAthMcUsd ?? null,
              creatorStats: enrich.creatorStats ?? card.creatorStats ?? null,
            };
          }
        }
      } catch (err) {
        console.warn("calls token creator enrich failed", err);
      }
    }

    // Buyers = YOUR sensor wallets (Helius → token_buys). WR join only if requested.
    let buyers: CallBuyer[] = [];
    try {
      const buyRows = wantWinrate
        ? await db.execute(sql`
            SELECT
              w.id AS wallet_id, w.address, w.label,
              tb.bought_at, tb.amount, tb.price_usd, wp.win_rate
            FROM token_buys tb
            JOIN walletdatasource w ON w.id = tb.wallet_id
            LEFT JOIN wallet_profiles wp ON wp.wallet_address = w.address
            WHERE tb.token_id = ${tokenId}
            ORDER BY tb.bought_at DESC NULLS LAST
            LIMIT 40
          `)
        : await db.execute(sql`
            SELECT
              w.id AS wallet_id, w.address, w.label,
              tb.bought_at, tb.amount, tb.price_usd,
              NULL::float8 AS win_rate
            FROM token_buys tb
            JOIN walletdatasource w ON w.id = tb.wallet_id
            WHERE tb.token_id = ${tokenId}
            ORDER BY tb.bought_at DESC NULLS LAST
            LIMIT 40
          `);
      buyers = (buyRows.rows as Array<Record<string, unknown>>).map(r => ({
        walletId: Number(r.wallet_id),
        address: String(r.address),
        label: String(r.label ?? "wallet"),
        boughtAt: toIsoUtc(r.bought_at),
        winRate: wantWinrate && r.win_rate != null ? Number(r.win_rate) : null,
        amount: r.amount != null ? String(r.amount) : null,
        priceUsd: r.price_usd != null ? String(r.price_usd) : null,
      }));
    } catch (err) {
      console.warn("calls token buyers query failed", err);
    }

    let snaps: CallSnap[] = [];
    try {
      const snapRows = await db.execute(sql`
        SELECT ps.snapshot_at, ps.mc_usd, ps.ath_multiple, ps.gain_pct,
               ps.kol_count, ps.smart_count
        FROM pro_snapshots ps
        WHERE ps.token_id = ${tokenId}
        ORDER BY ps.snapshot_at DESC NULLS LAST
        LIMIT 24
      `);
      snaps = (snapRows.rows as Array<Record<string, unknown>>).map(r => ({
        at: toIsoUtc(r.snapshot_at),
        mcUsd: r.mc_usd != null ? parseFloat(String(r.mc_usd)) : null,
        athMultiple: r.ath_multiple != null ? Number(r.ath_multiple) : null,
        gainPct: r.gain_pct != null ? Number(r.gain_pct) : null,
        kol: r.kol_count != null ? Number(r.kol_count) : null,
        smart: r.smart_count != null ? Number(r.smart_count) : null,
      })).reverse();
    } catch {
      snaps = [];
    }

    if (!card && buyers.length === 0) {
      res.status(404).json(apiFail("Call not found", "not_found"));
      return;
    }

    if (card && buyers.length > 0) {
      card = { ...card, walletBuys: new Set(buyers.map(b => b.walletId)).size };
    }

    if (card && wantWinrate) {
      try {
        const wr = await loadTokenWinrate(tokenId);
        card = { ...card, avgWalletWinRate: wr.avgWalletWinRate };
      } catch (err) {
        console.warn("calls token winrate query failed", err);
      }
    }

    let crypsorWallets: CrypsorWalletRow[] = [];
    try {
      const intelRows = await db.execute(sql`
        SELECT
          e.wallet_address,
          e.our_label_at,
          e.behaviour_score_at,
          e.hold_pct,
          e.buy_count,
          e.sell_count,
          e.realized_pnl,
          i.our_label,
          i.behaviour_score,
          i.weightage,
          i.win_rate,
          i.wins,
          i.losses,
          i.tokens_seen,
          i.sightings,
          i.last_reason,
          i.last_seen_at
        FROM crypsor_wallet_token_events e
        JOIN crypsor_wallet_intel i ON i.wallet_address = e.wallet_address
        WHERE e.token_id = ${tokenId} AND e.role = 'observed'
        ORDER BY
          CASE e.our_label_at
            WHEN 'diamond' THEN 0
            WHEN 'accumulator' THEN 1
            WHEN 'solid' THEN 2
            WHEN 'whale' THEN 3
            WHEN 'watch' THEN 4
            ELSE 5
          END,
          COALESCE(i.weightage, 0) DESC,
          COALESCE(e.hold_pct, 0) DESC
        LIMIT 40
      `);
      crypsorWallets = (intelRows.rows as Array<Record<string, unknown>>).map(r => ({
        address: String(r.wallet_address),
        ourLabel: String(r.our_label ?? r.our_label_at ?? "noise"),
        behaviourScore: Number(r.behaviour_score ?? r.behaviour_score_at ?? 0),
        weightage: Number(r.weightage ?? 0),
        winRate: wantWinrate && r.win_rate != null ? Number(r.win_rate) : null,
        wins: Number(r.wins ?? 0),
        losses: Number(r.losses ?? 0),
        tokensSeen: Number(r.tokens_seen ?? 0),
        sightings: Number(r.sightings ?? 0),
        holdPct: r.hold_pct != null ? Number(r.hold_pct) : null,
        buyCount: r.buy_count != null ? Number(r.buy_count) : null,
        sellCount: r.sell_count != null ? Number(r.sell_count) : null,
        realizedPnl: r.realized_pnl != null ? Number(r.realized_pnl) : null,
        reason: r.last_reason != null ? String(r.last_reason) : null,
        lastSeenAt: toIsoUtc(r.last_seen_at),
      }));
    } catch (err) {
      console.warn("calls token crypsor intel query failed", err);
      crypsorWallets = [];
    }

    res.setHeader("Cache-Control", "private, max-age=6");
    res.json(apiOk({
      card,
      buyers,
      snaps,
      crypsorWallets,
      winrateLoaded: wantWinrate,
      walletBuysNote:
        "Wallet buys = distinct wallets from YOUR tracked list (walletdatasource) that bought this token via Helius scan → token_buys. Not GMGN holders.",
      crypsorNote:
        "Legacy crypsor_wallet_intel rows (if any). Live holder scoring is on Wallet Track — paste a mint there.",
    }));
  } catch (err) {
    console.error("calls token error", err);
    res.status(500).json(apiFail("Internal server error", "calls_token"));
  }
});

export default router;
