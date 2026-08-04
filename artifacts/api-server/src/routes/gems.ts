/**
 * GEM desk API — the trusted lane.
 *
 *   GET /gems            paginated GEM calls (survival-scored, live MC)
 *   GET /gems/log        newly captured tokens (discovery log, compact)
 *   GET /gems/token/:id  fast lightweight detail: one SQL + tape + story
 *
 * Design: the desk shows only (a) confirmed GEM calls being judged by
 * survival after the call, and (b) a live log of fresh captures. No modes,
 * no waiting lanes. Detail endpoint does NO synchronous third-party fetches
 * except one budget-capped live-price read.
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { apiOk, apiFail } from "../lib/api-envelope";
import { proCacheGet, proCacheSet } from "../lib/pro-cache";
import { fetchLivePrice } from "../pipeline/price-service";
import {
  computeSurvival,
  type SurvivalResult,
  type SurvivalTapePoint,
} from "../lib/survival-score";
import { buildTokenStory, type TokenStory } from "../lib/token-story";

const router: IRouter = Router();

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null =>
  v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null;

function toIso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export type GemCard = {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  gemScore: number;
  gemConfidence: number;
  gemComponents: Record<string, number> | null;
  calledAt: string | null;
  callMcUsd: number | null;
  currentMcUsd: number | null;
  peakMcUsd: number | null;
  gainSinceCallPct: number | null;
  peakMultiple: number | null;
  offPeakPct: number | null;
  liqUsd: number | null;
  holderCount: number | null;
  trackedWallets: number;
  minutesSinceCall: number | null;
  survival: SurvivalResult | null;
};

async function loadTapes(tokenIds: number[], rowsPerToken = 30): Promise<Map<number, SurvivalTapePoint[]>> {
  const map = new Map<number, SurvivalTapePoint[]>();
  if (!tokenIds.length) return map;
  const rows = await db.execute(sql`
    SELECT token_id, EXTRACT(EPOCH FROM at) * 1000 AS at_ms,
           mc_usd, liq_usd, buys_5m, sells_5m, holder_count
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY at DESC) AS rn
      FROM gem_snapshots
      WHERE token_id = ANY(${sql.raw(`ARRAY[${tokenIds.map((n) => Number(n)).join(",")}]::int[]`)})
    ) x
    WHERE x.rn <= ${rowsPerToken}
    ORDER BY token_id, at ASC
  `);
  for (const r of rows.rows as Array<Record<string, unknown>>) {
    const id = num(r.token_id);
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push({
      atMs: num(r.at_ms),
      mcUsd: numOrNull(r.mc_usd),
      liqUsd: numOrNull(r.liq_usd),
      buys5m: numOrNull(r.buys_5m),
      sells5m: numOrNull(r.sells_5m),
      holderCount: numOrNull(r.holder_count),
    });
  }
  return map;
}

function survivalFor(
  callMc: number | null,
  currentMc: number | null,
  peakMc: number | null,
  calledAt: string | null,
  tape: SurvivalTapePoint[],
): SurvivalResult | null {
  if (!callMc || callMc <= 0 || !currentMc || currentMc <= 0) return null;
  const minutes = calledAt ? Math.max(0, (Date.now() - new Date(calledAt).getTime()) / 60_000) : 0;
  return computeSurvival({
    callMcUsd: callMc,
    currentMcUsd: currentMc,
    peakMcUsd: Math.max(peakMc ?? 0, currentMc),
    tape,
    minutesSinceCall: minutes,
  });
}

// ── GET /gems — the called gems, judged by survival ─────────────────────────

router.get("/gems", async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "8"), 10) || 8, 1), 20);
    const page = Math.max(parseInt(String(req.query.page ?? "1"), 10) || 1, 1);

    const cacheKey = `gems:feed:v1:${page}:${limit}`;
    const cached = await proCacheGet<Record<string, unknown>>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "private, no-cache");
      res.json(apiOk(cached));
      return;
    }

    const totalRow = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM gem_scores WHERE first_gem_at IS NOT NULL
    `);
    const total = num((totalRow.rows[0] as { n?: number })?.n);
    const pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, pages);

    const rows = await db.execute(sql`
      SELECT
        g.token_id, g.score, g.confidence, g.components,
        g.first_gem_at, g.gem_call_mc_usd, g.peak_after_call_mc,
        t.address, t.chain, t.name, t.symbol, t.logo_uri, t.image_path,
        t.market_cap_usd, t.liquidity_usd, t.holder_count,
        COALESCE(tb.n, 0)::int AS tracked_wallets
      FROM gem_scores g
      JOIN tracked_tokens t ON t.id = g.token_id
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT wallet_id) AS n FROM token_buys WHERE token_id = g.token_id
      ) tb ON TRUE
      WHERE g.first_gem_at IS NOT NULL
      ORDER BY g.first_gem_at DESC
      LIMIT ${limit} OFFSET ${(safePage - 1) * limit}
    `);

    const raw = rows.rows as Array<Record<string, unknown>>;
    const ids = raw.map((r) => num(r.token_id));
    const tapes = await loadTapes(ids);

    const cards: GemCard[] = raw.map((r) => {
      const id = num(r.token_id);
      const callMc = numOrNull(r.gem_call_mc_usd);
      const currentMc = numOrNull(r.market_cap_usd);
      const peakMc = Math.max(numOrNull(r.peak_after_call_mc) ?? 0, currentMc ?? 0) || null;
      const calledAt = toIso(r.first_gem_at);
      const tape = tapes.get(id) ?? [];
      const survival = survivalFor(callMc, currentMc, peakMc, calledAt, tape);
      const gain = callMc && currentMc && callMc > 0 ? ((currentMc - callMc) / callMc) * 100 : null;
      return {
        id,
        address: String(r.address),
        chain: String(r.chain ?? "solana"),
        name: (r.name as string | null) ?? null,
        symbol: (r.symbol as string | null) ?? null,
        logoUri: (r.logo_uri as string | null) ?? null,
        gemScore: num(r.score),
        gemConfidence: num(r.confidence),
        gemComponents: (r.components as Record<string, number> | null) ?? null,
        calledAt,
        callMcUsd: callMc,
        currentMcUsd: currentMc,
        peakMcUsd: peakMc,
        gainSinceCallPct: gain,
        peakMultiple: callMc && peakMc && callMc > 0 ? peakMc / callMc : null,
        offPeakPct: peakMc && currentMc && peakMc > 0 ? (1 - currentMc / peakMc) * 100 : null,
        liqUsd: numOrNull(r.liquidity_usd),
        holderCount: numOrNull(r.holder_count),
        trackedWallets: num(r.tracked_wallets),
        minutesSinceCall: calledAt
          ? Math.round((Date.now() - new Date(calledAt).getTime()) / 60_000)
          : null,
        survival,
      };
    });

    const payload = { cards, total, page: safePage, pages, limit };
    await proCacheSet(cacheKey, payload, 4);
    res.setHeader("Cache-Control", "private, no-cache");
    res.json(apiOk(payload));
  } catch (err) {
    console.error("gems feed failed", err);
    res.status(500).json(apiFail("gems feed failed"));
  }
});

// ── GET /gems/log — newly captured tokens (discovery log) ───────────────────

export type GemLogRow = {
  id: number;
  address: string;
  symbol: string | null;
  name: string | null;
  logoUri: string | null;
  detectedAt: string | null;
  detectMcUsd: number | null;
  currentMcUsd: number | null;
  gemScore: number | null;
  gemVerdict: string | null;
  trackedWallets: number;
};

router.get("/gems/log", async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "25"), 10) || 25, 1), 50);

    const cacheKey = `gems:log:v1:${limit}`;
    const cached = await proCacheGet<{ rows: GemLogRow[] }>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "private, no-cache");
      res.json(apiOk(cached));
      return;
    }

    const rows = await db.execute(sql`
      SELECT
        t.id, t.address, t.symbol, t.name, t.logo_uri,
        t.first_detected_at, t.market_cap_usd,
        (t.pump_scan->>'mcAtDetection')::real AS detect_mc,
        g.score AS gem_score, g.verdict AS gem_verdict,
        COALESCE(tb.n, 0)::int AS tracked_wallets
      FROM tracked_tokens t
      JOIN LATERAL (
        SELECT COUNT(DISTINCT wallet_id) AS n FROM token_buys WHERE token_id = t.id
      ) tb ON tb.n > 0
      LEFT JOIN gem_scores g ON g.token_id = t.id
      WHERE t.chain = 'solana'
        AND COALESCE(t.status, '') NOT IN ('ignored', 'archive')
        AND t.first_detected_at > NOW() - INTERVAL '24 hours'
      ORDER BY t.first_detected_at DESC
      LIMIT ${limit}
    `);

    const out: GemLogRow[] = (rows.rows as Array<Record<string, unknown>>).map((r) => ({
      id: num(r.id),
      address: String(r.address),
      symbol: (r.symbol as string | null) ?? null,
      name: (r.name as string | null) ?? null,
      logoUri: (r.logo_uri as string | null) ?? null,
      detectedAt: toIso(r.first_detected_at),
      detectMcUsd: numOrNull(r.detect_mc),
      currentMcUsd: numOrNull(r.market_cap_usd),
      gemScore: numOrNull(r.gem_score),
      gemVerdict: (r.gem_verdict as string | null) ?? null,
      trackedWallets: num(r.tracked_wallets),
    }));

    const payload = { rows: out };
    await proCacheSet(cacheKey, payload, 5);
    res.setHeader("Cache-Control", "private, no-cache");
    res.json(apiOk(payload));
  } catch (err) {
    console.error("gems log failed", err);
    res.status(500).json(apiFail("gems log failed"));
  }
});

// ── GET /gems/token/:id — fast lightweight detail ───────────────────────────

export type GemDetail = {
  card: GemCard & {
    gemVerdict: string | null;
    gemVetoes: string[];
    top10Pct: number | null;
    sniperCount: number | null;
    bundlerCount: number | null;
    smartCount: number | null;
    kolCount: number | null;
    vol24hUsd: number | null;
    pairAgeMin: number | null;
    detectedAt: string | null;
    socials: { twitter?: string; telegram?: string; website?: string };
  };
  spark: Array<{ t: number; mc: number }>;
  flow: { buys5m: number; sells5m: number; buys1h: number; sells1h: number } | null;
  story: TokenStory;
  live: boolean;
};

function extractSocialsLite(raw: unknown): { twitter?: string; telegram?: string; website?: string } {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const out: { twitter?: string; telegram?: string; website?: string } = {};
  for (const key of ["twitter", "telegram", "website"] as const) {
    const v = o[key];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) out[key] = v;
  }
  return out;
}

router.get("/gems/token/:id", async (req, res) => {
  try {
    const tokenId = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(tokenId)) {
      res.status(400).json(apiFail("bad token id"));
      return;
    }

    const rows = await db.execute(sql`
      SELECT
        t.id, t.address, t.chain, t.name, t.symbol, t.logo_uri,
        t.market_cap_usd, t.liquidity_usd, t.volume_24h_usd,
        t.holder_count, t.holder_top10_pct, t.holder_sniper_count,
        t.holder_bundler_count, t.holder_smart_count, t.holder_kol_count,
        t.first_detected_at, t.raw_metadata,
        (t.pump_scan->>'pairCreatedAt')::bigint AS pair_created_at,
        g.score AS gem_score, g.verdict AS gem_verdict, g.confidence,
        g.components, g.vetoes, g.first_gem_at, g.gem_call_mc_usd, g.peak_after_call_mc,
        COALESCE(tb.n, 0)::int AS tracked_wallets
      FROM tracked_tokens t
      LEFT JOIN gem_scores g ON g.token_id = t.id
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT wallet_id) AS n FROM token_buys WHERE token_id = t.id
      ) tb ON TRUE
      WHERE t.id = ${tokenId}
      LIMIT 1
    `);
    const r = rows.rows[0] as Record<string, unknown> | undefined;
    if (!r) {
      res.status(404).json(apiFail("token not found"));
      return;
    }

    const tapes = await loadTapes([tokenId], 48);
    const tape = tapes.get(tokenId) ?? [];

    // One budget-capped live read (Dex → pump.fun fallback). Never blocks >1.4s.
    let currentMc = numOrNull(r.market_cap_usd);
    let liqUsd = numOrNull(r.liquidity_usd);
    let live = false;
    try {
      const fresh = await Promise.race([
        fetchLivePrice(String(r.chain ?? "solana"), String(r.address)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_400)),
      ]);
      const freshMc = fresh?.marketCapUsd != null ? parseFloat(fresh.marketCapUsd) : NaN;
      const freshLiq = fresh?.liquidityUsd != null ? parseFloat(fresh.liquidityUsd) : NaN;
      if (Number.isFinite(freshMc) && freshMc > 0) {
        currentMc = freshMc;
        if (Number.isFinite(freshLiq) && freshLiq > 0) liqUsd = freshLiq;
        live = true;
      }
    } catch { /* stale DB value is fine */ }

    const callMc = numOrNull(r.gem_call_mc_usd);
    const calledAt = toIso(r.first_gem_at);
    const peakMc = Math.max(numOrNull(r.peak_after_call_mc) ?? 0, currentMc ?? 0) || null;
    const survival = survivalFor(callMc, currentMc, peakMc, calledAt, tape);
    const vetoes = Array.isArray(r.vetoes) ? (r.vetoes as string[]) : [];
    const detectedAt = toIso(r.first_detected_at);
    const pairAgeMin = r.pair_created_at
      ? Math.max(0, Math.round((Date.now() - num(r.pair_created_at)) / 60_000))
      : null;
    const gain = callMc && currentMc && callMc > 0 ? ((currentMc - callMc) / callMc) * 100 : null;

    const last = tape[tape.length - 1] ?? null;
    const flowRow = await db.execute(sql`
      SELECT buys_5m, sells_5m, buys_1h, sells_1h
      FROM gem_snapshots WHERE token_id = ${tokenId}
      ORDER BY at DESC LIMIT 1
    `);
    const f = flowRow.rows[0] as Record<string, unknown> | undefined;

    const story = buildTokenStory({
      symbol: String(r.symbol ?? r.name ?? String(r.address).slice(0, 6)),
      tape,
      callMcUsd: callMc,
      peakMcUsd: peakMc,
      currentMcUsd: currentMc ?? 0,
      liqUsd,
      minutesSinceDetect: detectedAt
        ? Math.round((Date.now() - new Date(detectedAt).getTime()) / 60_000)
        : null,
      gemScore: numOrNull(r.gem_score),
      gemVerdict: (r.gem_verdict as string | null) ?? null,
      gemVetoes: vetoes,
      survival,
      holderCount: numOrNull(r.holder_count),
      top10Pct: numOrNull(r.holder_top10_pct),
      trackedWallets: num(r.tracked_wallets),
    });

    const detail: GemDetail = {
      card: {
        id: tokenId,
        address: String(r.address),
        chain: String(r.chain ?? "solana"),
        name: (r.name as string | null) ?? null,
        symbol: (r.symbol as string | null) ?? null,
        logoUri: (r.logo_uri as string | null) ?? null,
        gemScore: num(r.gem_score),
        gemConfidence: num(r.confidence),
        gemComponents: (r.components as Record<string, number> | null) ?? null,
        gemVerdict: (r.gem_verdict as string | null) ?? null,
        gemVetoes: vetoes,
        calledAt,
        callMcUsd: callMc,
        currentMcUsd: currentMc,
        peakMcUsd: peakMc,
        gainSinceCallPct: gain,
        peakMultiple: callMc && peakMc && callMc > 0 ? peakMc / callMc : null,
        offPeakPct: peakMc && currentMc && peakMc > 0 ? (1 - currentMc / peakMc) * 100 : null,
        liqUsd,
        holderCount: numOrNull(r.holder_count),
        trackedWallets: num(r.tracked_wallets),
        minutesSinceCall: calledAt
          ? Math.round((Date.now() - new Date(calledAt).getTime()) / 60_000)
          : null,
        survival,
        top10Pct: numOrNull(r.holder_top10_pct),
        sniperCount: numOrNull(r.holder_sniper_count),
        bundlerCount: numOrNull(r.holder_bundler_count),
        smartCount: numOrNull(r.holder_smart_count),
        kolCount: numOrNull(r.holder_kol_count),
        vol24hUsd: numOrNull(r.volume_24h_usd),
        pairAgeMin,
        detectedAt,
        socials: extractSocialsLite(r.raw_metadata),
      },
      spark: tape
        .filter((p) => p.mcUsd != null && p.mcUsd > 0)
        .map((p) => ({ t: p.atMs, mc: p.mcUsd! })),
      flow: f
        ? {
          buys5m: num(f.buys_5m), sells5m: num(f.sells_5m),
          buys1h: num(f.buys_1h), sells1h: num(f.sells_1h),
        }
        : (last ? { buys5m: last.buys5m ?? 0, sells5m: last.sells5m ?? 0, buys1h: 0, sells1h: 0 } : null),
      story,
      live,
    };

    res.setHeader("Cache-Control", "private, no-cache");
    res.json(apiOk(detail));
  } catch (err) {
    console.error("gem detail failed", err);
    res.status(500).json(apiFail("gem detail failed"));
  }
});

export default router;
