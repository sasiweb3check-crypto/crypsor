/**
 * Pro Caller Routes
 *
 * GET /api/pro/stats         — aggregate performance (hit rates from called MC)
 * GET /api/pro/history       — pro-called tokens with quality scores + run status
 * GET /api/pro/token/:id     — single token's pro call record (milestones, entry point)
 *
 * Quality labels  (Pro Score thresholds)
 *   very_good  ≥ 75
 *   good       55–74
 *   below      < 55
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { sql } from "drizzle-orm";
import { extractSocials } from "../lib/socials";
import { computeProScore, deriveRunStatus, type QualityLabel } from "../lib/pro-scoring";

const router = Router();

// ── GET /api/pro/stats ────────────────────────────────────────────────────────

router.get("/pro/stats", async (_req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT
        -- Quality-scoped counts (very_good + good only)
        COUNT(*) FILTER (WHERE quality_label IN ('very_good', 'good'))::int           AS total,
        -- All-time total regardless of current quality label
        COUNT(*)::int                                                                  AS total_all_time,
        COUNT(CASE WHEN ath_multiple >= 2   AND quality_label IN ('very_good','good') THEN 1 END)::int  AS win,
        COUNT(CASE WHEN ath_multiple >= 1.5 AND quality_label IN ('very_good','good') THEN 1 END)::int  AS x1,
        COUNT(CASE WHEN ath_multiple >= 2   AND quality_label IN ('very_good','good') THEN 1 END)::int  AS x2,
        COUNT(CASE WHEN ath_multiple >= 3   AND quality_label IN ('very_good','good') THEN 1 END)::int  AS x3,
        COUNT(CASE WHEN ath_multiple >= 5   AND quality_label IN ('very_good','good') THEN 1 END)::int  AS x5,
        COUNT(CASE WHEN ath_multiple >= 10  AND quality_label IN ('very_good','good') THEN 1 END)::int  AS x10,
        COUNT(CASE WHEN ath_multiple >= 100 AND quality_label IN ('very_good','good') THEN 1 END)::int  AS x100,
        COUNT(CASE WHEN ath_multiple >= 200 AND quality_label IN ('very_good','good') THEN 1 END)::int  AS x200,
        ROUND(MAX(CASE WHEN quality_label IN ('very_good','good') THEN ath_multiple END)::numeric, 2)   AS best_ath,
        COUNT(CASE WHEN quality_label = 'very_good' THEN 1 END)::int                  AS very_good_count,
        COUNT(CASE WHEN quality_label = 'good'      THEN 1 END)::int                  AS good_count,
        COUNT(*) FILTER (
          WHERE quality_label IN ('very_good','good')
            AND called_at >= NOW() - INTERVAL '24 hours'
        )::int                                                                         AS recent_count
      FROM pro_calls pc
    `);

    const row   = (result.rows[0] ?? {}) as Record<string, unknown>;
    const total = Number(row.total ?? 0);
    const win   = Number(row.win   ?? 0);

    res.json({
      total,
      totalAllTime:   Number(row.total_all_time ?? 0),
      winRate:        total > 0 ? Math.round((win / total) * 100) : 0,
      x1Count:        Number(row.x1   ?? 0),
      x2Count:        Number(row.x2   ?? 0),
      x3Count:        Number(row.x3   ?? 0),
      x5Count:        Number(row.x5   ?? 0),
      x10Count:       Number(row.x10  ?? 0),
      x100Count:      Number(row.x100 ?? 0),
      x200Count:      Number(row.x200 ?? 0),
      bestAth:        row.best_ath != null ? Number(row.best_ath) : null,
      veryGoodCount:  Number(row.very_good_count ?? 0),
      goodCount:      Number(row.good_count      ?? 0),
      qualityCount:   Number(row.very_good_count ?? 0) + Number(row.good_count ?? 0),
      recentCount:    Number(row.recent_count    ?? 0),
    });
  } catch (err) {
    console.error("pro stats error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/pro/history ──────────────────────────────────────────────────────

router.get("/pro/history", async (req, res) => {
  try {
    const sort    = (req.query.sort    as string) ?? "proScore";
    const order   = (req.query.order   as string) ?? "desc";
    // quality filter: 'all' | 'quality' (very_good + good only) | 'very_good'
    const quality = (req.query.quality as string) ?? "quality";

    // Load all pro_calls with latest snapshot + security data + milestones
    const callRows = await db.execute(sql`
      SELECT
        pc.id              AS pro_call_id,
        pc.token_id,
        pc.called_at,
        pc.called_mc_usd,
        pc.called_intel_score,
        pc.called_kol_count,
        pc.called_smart_count,
        pc.called_kol_smart_score,
        pc.ath_multiple,
        pc.last_snapshot_at AS snap_at,
        pc.pro_score,
        pc.quality_label,
        -- milestone flags + timestamps
        pc.hit_2x,  pc.hit_2x_at,
        pc.hit_3x,  pc.hit_3x_at,
        pc.hit_5x,  pc.hit_5x_at,
        pc.hit_10x, pc.hit_10x_at,
        pc.hit_100x,pc.hit_100x_at,
        pc.surfaced_at,
        pc.surfaced_mc_usd,
        -- latest snapshot for MC/kol/intel
        ps.mc_usd          AS snap_mc,
        ps.kol_count       AS snap_kol,
        ps.smart_count     AS snap_smart,
        ps.intel_score     AS snap_intel,
        -- current token state
        t.address, t.chain, t.name, t.symbol,
        t.logo_uri, t.image_path,
        t.status,
        t.market_cap_usd,
        t.liquidity_usd,
        t.raw_metadata,
        -- live KOL/smart from tracked_tokens (most up-to-date; snapshots may be 0 if
        -- taken before GMGN data arrived — tracked_tokens is always the current truth)
        t.holder_kol_count   AS live_kol,
        t.holder_smart_count AS live_smart,
        t.sec_is_honeypot,
        t.sec_mint_renounced,
        t.sec_freeze_renounced,
        t.sec_top10_holder_rate,
        t.sec_lp_locked,
        t.sec_rat_trader_amt_rate
      FROM pro_calls pc
      JOIN tracked_tokens t ON t.id = pc.token_id
      -- latest snapshot per pro_call
      LEFT JOIN LATERAL (
        SELECT mc_usd, kol_count, smart_count, intel_score
        FROM pro_snapshots
        WHERE pro_call_id = pc.id
        ORDER BY snapshot_at DESC
        LIMIT 1
      ) ps ON true
      -- No MC filter here — all pro_calls qualify (scanner enforced $5K at call time)
      -- Dead/low-MC tokens still show under "All" and count in win rate denominator
    `);

    type CallRow = {
      pro_call_id: number; token_id: number;
      called_at: string; called_mc_usd: string | null;
      called_intel_score: number | null;
      called_kol_count: number | null; called_smart_count: number | null;
      called_kol_smart_score: number | null;
      ath_multiple: number | null; snap_at: string | null;
      pro_score: number | null; quality_label: string | null;
      hit_2x: boolean | null; hit_2x_at: string | null;
      hit_3x: boolean | null; hit_3x_at: string | null;
      hit_5x: boolean | null; hit_5x_at: string | null;
      hit_10x: boolean | null; hit_10x_at: string | null;
      hit_100x: boolean | null; hit_100x_at: string | null;
      surfaced_at: string | null;
      surfaced_mc_usd: string | null;
      snap_mc: string | null; snap_kol: number | null;
      snap_smart: number | null; snap_intel: number | null;
      live_kol: number | null; live_smart: number | null;
      address: string; chain: string; name: string | null; symbol: string | null;
      logo_uri: string | null; image_path: string | null;
      status: string; market_cap_usd: string | null;
      liquidity_usd: string | null; raw_metadata: unknown;
      sec_is_honeypot: boolean | null; sec_mint_renounced: boolean | null;
      sec_freeze_renounced: boolean | null; sec_top10_holder_rate: number | null;
      sec_lp_locked: boolean | null; sec_rat_trader_amt_rate: number | null;
    };

    const results = (callRows.rows as CallRow[]).map(call => {
      const calledMc  = call.called_mc_usd ? parseFloat(call.called_mc_usd) : null;
      const snapMc    = call.snap_mc ? parseFloat(call.snap_mc) : null;
      const currentMc = snapMc ?? (parseFloat(call.market_cap_usd ?? "0") || null);
      const liquidityUsd = parseFloat(call.liquidity_usd ?? "0") || null;
      const gainSinceCall = calledMc && currentMc
        ? ((currentMc - calledMc) / calledMc) * 100 : null;
      const athMultiple = call.ath_multiple ?? 1;
      const runStatus = deriveRunStatus(currentMc, calledMc, athMultiple);

      // Use stored score if available; otherwise compute live
      let proScore: number;
      let qualityLabel: QualityLabel;
      if (call.pro_score != null && call.quality_label != null) {
        proScore = call.pro_score;
        qualityLabel = call.quality_label as QualityLabel;
      } else {
        const result = computeProScore({
          calledIntelScore:    call.called_intel_score,
          calledKolCount:      call.called_kol_count ?? 0,
          calledSmartCount:    call.called_smart_count ?? 0,
          calledMcUsd:         calledMc,
          currentMcUsd:        currentMc,
          athMultiple,
          gainSinceCall,
          runStatus,
          liquidityUsd,
          secIsHoneypot:        call.sec_is_honeypot,
          secMintRenounced:     call.sec_mint_renounced,
          secFreezeRenounced:   call.sec_freeze_renounced,
          secTop10HolderRate:   call.sec_top10_holder_rate,
          secLpLocked:          call.sec_lp_locked,
          secRatTraderAmtRate:  call.sec_rat_trader_amt_rate,
        });
        proScore = result.score;
        qualityLabel = result.qualityLabel;
      }

      return {
        id:             call.token_id,
        address:        call.address,
        chain:          call.chain,
        name:           call.name,
        symbol:         call.symbol,
        logoUri:        call.image_path ? `/api/assets${call.image_path}` : call.logo_uri,
        status:         call.status,
        calledAt:       call.called_at,
        calledMcUsd:    calledMc,
        calledIntel:    call.called_intel_score,
        calledKol:      call.called_kol_count ?? 0,
        calledSmart:    call.called_smart_count ?? 0,
        calledKolSmartScore: call.called_kol_smart_score,
        currentMcUsd:   currentMc,
        gainSinceCall,
        athMultiple,
        runStatus,
        proScore,
        qualityLabel,
        // Use the best available KOL/smart value across three sources.
        // ?? only skips null/undefined — not 0 — so snapshots written before
        // GMGN data arrived (kol_count = 0) would silently hide real called values.
        // Taking the max ensures a non-zero value from any source wins.
        currentKol:   Math.max(call.live_kol ?? 0, call.snap_kol ?? 0, call.called_kol_count ?? 0),
        currentSmart: Math.max(call.live_smart ?? 0, call.snap_smart ?? 0, call.called_smart_count ?? 0),
        currentIntel:   call.snap_intel ?? call.called_intel_score,
        lastSnapshotAt: call.snap_at ?? null,
        // Milestone flags + timestamps
        hit2x:    call.hit_2x    ?? false, hit2xAt:  call.hit_2x_at   ?? null,
        hit3x:    call.hit_3x    ?? false, hit3xAt:  call.hit_3x_at   ?? null,
        hit5x:    call.hit_5x    ?? false, hit5xAt:  call.hit_5x_at   ?? null,
        hit10x:   call.hit_10x   ?? false, hit10xAt: call.hit_10x_at  ?? null,
        hit100x:  call.hit_100x  ?? false, hit100xAt:call.hit_100x_at ?? null,
        // Surfaced tracking — when the token first became visible in Pro Intel.
        // surfacedMcUsd is the real "entry" price users should see.
        // Falls back to calledMcUsd for tokens that qualified immediately or
        // for historical records predating this field.
        surfacedAt:     call.surfaced_at ?? null,
        surfacedMcUsd:  call.surfaced_mc_usd ? parseFloat(call.surfaced_mc_usd) : null,
        // Security summary
        secMintRenounced:   call.sec_mint_renounced,
        secFreezeRenounced: call.sec_freeze_renounced,
        secIsHoneypot:      call.sec_is_honeypot,
        socials:            extractSocials(call.raw_metadata),
      };
    });

    // Apply quality filter
    const now24hAgo = Date.now() - 24 * 60 * 60 * 1000;
    const filtered = results.filter(t => {
      if (quality === "all")       return true;
      if (quality === "very_good") return t.qualityLabel === "very_good";
      if (quality === "recent") {
        // Quality tokens (very_good + good) called within the last 24 hours
        return (t.qualityLabel === "very_good" || t.qualityLabel === "good")
          && new Date(t.calledAt).getTime() >= now24hAgo;
      }
      // default "quality" = very_good + good
      return t.qualityLabel === "very_good" || t.qualityLabel === "good";
    });

    // Sort
    filtered.sort((a, b) => {
      let diff = 0;
      if      (sort === "ath")      diff = (b.athMultiple ?? 0)          - (a.athMultiple ?? 0);
      else if (sort === "gain")     diff = (b.gainSinceCall ?? -Infinity) - (a.gainSinceCall ?? -Infinity);
      else if (sort === "intel")    diff = (b.currentIntel ?? 0)          - (a.currentIntel ?? 0);
      else if (sort === "calledMc") diff = (b.calledMcUsd ?? 0)           - (a.calledMcUsd ?? 0);
      else if (sort === "proScore") diff = (b.proScore ?? 0)              - (a.proScore ?? 0);
      else                          diff = new Date(b.calledAt).getTime() - new Date(a.calledAt).getTime();
      return order === "asc" ? -diff : diff;
    });

    res.json({ total: filtered.length, totalAll: results.length, tokens: filtered });
  } catch (err) {
    console.error("pro history error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/pro/token/:tokenId ───────────────────────────────────────────────
// Returns the pro call record for a single token, including milestone data.
// Used by the token detail page to render the milestone tracker.

router.get("/pro/token/:tokenId", async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (isNaN(tokenId)) {
      res.status(400).json({ error: "Invalid token ID" });
      return;
    }

    const result = await db.execute(sql`
      SELECT
        pc.id,
        pc.token_id,
        pc.called_at,
        pc.called_mc_usd,
        pc.called_intel_score,
        pc.called_kol_count,
        pc.called_smart_count,
        pc.ath_multiple,
        pc.pro_score,
        pc.quality_label,
        pc.hit_2x,  pc.hit_2x_at,
        pc.hit_3x,  pc.hit_3x_at,
        pc.hit_5x,  pc.hit_5x_at,
        pc.hit_10x, pc.hit_10x_at,
        pc.hit_100x,pc.hit_100x_at,
        pc.last_snapshot_at
      FROM pro_calls pc
      WHERE pc.token_id = ${tokenId}
      LIMIT 1
    `);

    if (!result.rows.length) {
      res.json({ proCall: null });
      return;
    }

    const r = result.rows[0] as Record<string, unknown>;
    res.json({
      proCall: {
        id:               Number(r.id),
        calledAt:         r.called_at,
        calledMcUsd:      r.called_mc_usd ? parseFloat(String(r.called_mc_usd)) : null,
        calledIntelScore: r.called_intel_score != null ? Number(r.called_intel_score) : null,
        calledKolCount:   Number(r.called_kol_count ?? 0),
        calledSmartCount: Number(r.called_smart_count ?? 0),
        athMultiple:      r.ath_multiple != null ? Number(r.ath_multiple) : null,
        proScore:         r.pro_score != null ? Number(r.pro_score) : null,
        qualityLabel:     r.quality_label ?? null,
        lastSnapshotAt:   r.last_snapshot_at ?? null,
        hit2x:    Boolean(r.hit_2x),    hit2xAt:  r.hit_2x_at   ?? null,
        hit3x:    Boolean(r.hit_3x),    hit3xAt:  r.hit_3x_at   ?? null,
        hit5x:    Boolean(r.hit_5x),    hit5xAt:  r.hit_5x_at   ?? null,
        hit10x:   Boolean(r.hit_10x),   hit10xAt: r.hit_10x_at  ?? null,
        hit100x:  Boolean(r.hit_100x),  hit100xAt:r.hit_100x_at ?? null,
      },
    });
  } catch (err) {
    console.error("pro token error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
