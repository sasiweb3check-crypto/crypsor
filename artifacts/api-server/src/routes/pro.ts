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
import { sql, type SQL } from "drizzle-orm";
import { extractSocials } from "../lib/socials";
import { computeProScore, deriveRunStatus, type QualityLabel } from "../lib/pro-scoring";

const router = Router();

/** Short in-process cache — cuts repeat polls while MC stays fresh enough. */
const responseCache = new Map<string, { expires: number; body: unknown }>();
function cachedJson(key: string, ttlMs: number, compute: () => Promise<unknown>) {
  const hit = responseCache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.body);
  return compute().then((body) => {
    responseCache.set(key, { expires: Date.now() + ttlMs, body });
    return body;
  });
}

function qualityAthWhere(quality: string): SQL {
  const base = sql`pc.quality_label IN ('very_good', 'good')`;
  switch (quality) {
    case "very_good":
      return sql`pc.quality_label = 'very_good'`;
    case "good":
      return sql`pc.quality_label = 'good'`;
    case "recent":
      return sql`${base} AND pc.called_at >= NOW() - INTERVAL '24 hours'`;
    case "all":
      return sql`TRUE`;
    case "x5":
      return sql`${base} AND pc.ath_multiple >= 5 AND pc.ath_multiple < 10`;
    case "x10":
      return sql`${base} AND pc.ath_multiple >= 10 AND pc.ath_multiple < 20`;
    case "x10plus":
      return sql`${base} AND pc.ath_multiple >= 20`;
    case "quality":
    default:
      return base;
  }
}

// ── GET /api/pro/stats ────────────────────────────────────────────────────────

router.get("/pro/stats", async (_req, res) => {
  try {
    const body = await cachedJson("pro:stats", 10_000, async () => {
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
              AND called_at >= NOW() - INTERVAL '24 hours'
          )::int                                                                         AS recent_count,
          ROUND(AVG(CASE WHEN quality_label IN ('very_good','good') THEN survival_score END)::numeric, 1) AS avg_survival
        FROM pro_calls
      `);

      const row   = (result.rows[0] ?? {}) as Record<string, unknown>;
      const total = Number(row.total ?? 0);
      const win   = Number(row.win   ?? 0);

      return {
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
        recentCount:    Number(row.recent_count    ?? 0),
        avgSurvival:    row.avg_survival != null ? Number(row.avg_survival) : null,
      };
    });
    res.json(body);
  } catch (err) {
    console.error("pro stats error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/pro/history ──────────────────────────────────────────────────────

router.get("/pro/history", async (req, res) => {
  try {
    const sort    = (req.query.sort    as string) ?? "proScore";
    const order   = (req.query.order   as string) === "asc" ? "asc" : "desc";
    const quality = (req.query.quality as string) ?? "quality";
    const limit   = Math.min(Math.max(parseInt(String(req.query.limit ?? "150"), 10) || 150, 1), 300);

    const cacheKey = `pro:history:${quality}:${sort}:${order}:${limit}`;
    const body = await cachedJson(cacheKey, 8_000, async () => {
      const whereClause = qualityAthWhere(quality);

      const dir = order === "asc" ? sql`ASC` : sql`DESC`;
      let orderClause: SQL;
      switch (sort) {
        case "ath":
          orderClause = sql`pc.ath_multiple ${dir} NULLS LAST, pc.called_at DESC`;
          break;
        case "gain":
          orderClause = sql`(
            CASE WHEN NULLIF(pc.called_mc_usd, '')::numeric > 0
                 THEN (NULLIF(t.market_cap_usd, '')::numeric / NULLIF(pc.called_mc_usd, '')::numeric)
                 ELSE NULL END
          ) ${dir} NULLS LAST, pc.called_at DESC`;
          break;
        case "intel":
          orderClause = sql`t.intelligence_score ${dir} NULLS LAST, pc.called_at DESC`;
          break;
        case "calledMc":
          orderClause = sql`NULLIF(pc.called_mc_usd, '')::numeric ${dir} NULLS LAST, pc.called_at DESC`;
          break;
        case "calledAt":
          orderClause = sql`pc.called_at ${dir}`;
          break;
        case "survival":
          orderClause = sql`pc.survival_score ${dir} NULLS LAST, pc.called_at DESC`;
          break;
        case "proScore":
        default:
          orderClause = sql`pc.pro_score ${dir} NULLS LAST, pc.called_at DESC`;
          break;
      }

      const [countRows, callRows] = await Promise.all([
        db.execute(sql`
          SELECT COUNT(*)::int AS total_matching
          FROM pro_calls pc
          WHERE ${whereClause}
        `),
        db.execute(sql`
          SELECT
            pc.id              AS pro_call_id,
            pc.token_id,
            pc.called_at,
            pc.called_mc_usd,
            pc.called_intel_score,
            pc.called_kol_count,
            pc.called_smart_count,
            pc.called_kol_smart_score,
            pc.called_holder_velocity,
            pc.called_mc_growth,
            pc.called_volume_intensity,
            pc.ath_multiple,
            pc.last_snapshot_at AS snap_at,
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
            pc.surfaced_at,
            pc.surfaced_mc_usd,
            pc.scanner_label,
            pc.kol_smart_source,
            pc.verified_at,
            t.address, t.chain, t.name, t.symbol,
            t.logo_uri, t.image_path,
            t.status,
            t.market_cap_usd,
            t.liquidity_usd,
            t.raw_metadata,
            t.intelligence_score AS live_intel,
            t.holder_kol_count   AS live_kol,
            t.holder_smart_count AS live_smart,
            t.holder_velocity_score AS live_hv,
            t.sec_is_honeypot,
            t.sec_mint_renounced,
            t.sec_freeze_renounced,
            t.sec_top10_holder_rate,
            t.sec_lp_locked,
            t.sec_rat_trader_amt_rate
          FROM pro_calls pc
          JOIN tracked_tokens t ON t.id = pc.token_id
          WHERE ${whereClause}
          ORDER BY ${orderClause}
          LIMIT ${limit}
        `),
      ]);

      type CallRow = {
        pro_call_id: number; token_id: number;
        called_at: string; called_mc_usd: string | null;
        called_intel_score: number | null;
        called_kol_count: number | null; called_smart_count: number | null;
        called_kol_smart_score: number | null;
        called_holder_velocity: number | null;
        called_mc_growth: number | null; called_volume_intensity: number | null;
        ath_multiple: number | null; snap_at: string | null;
        pro_score: number | null; quality_label: string | null;
        survival_score: number | null; entry_tier: string | null;
        score_version: string | null;
        hit_2x: boolean | null; hit_2x_at: string | null;
        hit_3x: boolean | null; hit_3x_at: string | null;
        hit_5x: boolean | null; hit_5x_at: string | null;
        hit_10x: boolean | null; hit_10x_at: string | null;
        hit_100x: boolean | null; hit_100x_at: string | null;
        surfaced_at: string | null;
        surfaced_mc_usd: string | null;
        scanner_label: string | null;
        kol_smart_source: string | null;
        verified_at: string | null;
        live_intel: number | null;
        live_kol: number | null; live_smart: number | null;
        live_hv: number | null;
        address: string; chain: string; name: string | null; symbol: string | null;
        logo_uri: string | null; image_path: string | null;
        status: string; market_cap_usd: string | null;
        liquidity_usd: string | null; raw_metadata: unknown;
        sec_is_honeypot: boolean | null; sec_mint_renounced: boolean | null;
        sec_freeze_renounced: boolean | null; sec_top10_holder_rate: number | null;
        sec_lp_locked: boolean | null; sec_rat_trader_amt_rate: number | null;
      };

      const rows = callRows.rows as CallRow[];
      const totalMatching = Number(
        (countRows.rows[0] as { total_matching?: number } | undefined)?.total_matching ?? rows.length,
      );

      const tokens = rows.map(call => {
        const calledMc  = call.called_mc_usd ? parseFloat(call.called_mc_usd) : null;
        const currentMc = parseFloat(call.market_cap_usd ?? "0") || null;
        const liquidityUsd = parseFloat(call.liquidity_usd ?? "0") || null;
        const gainSinceCall = calledMc && currentMc
          ? ((currentMc - calledMc) / calledMc) * 100 : null;
        const athMultiple = call.ath_multiple ?? 1;
        const runStatus = deriveRunStatus(currentMc, calledMc, athMultiple);
        const ageHours = call.called_at
          ? (Date.now() - new Date(call.called_at).getTime()) / 3_600_000
          : null;

        let proScore: number;
        let qualityLabel: QualityLabel;
        let survivalScore: number | null = call.survival_score;
        if (call.pro_score != null && call.quality_label != null && call.score_version === "v2") {
          proScore = call.pro_score;
          qualityLabel = call.quality_label as QualityLabel;
        } else {
          const result = computeProScore({
            calledIntelScore:    call.called_intel_score,
            calledKolCount:      call.called_kol_count ?? 0,
            calledSmartCount:    call.called_smart_count ?? 0,
            calledMcUsd:         calledMc,
            calledHolderVelocity: call.called_holder_velocity,
            calledMcGrowth:      call.called_mc_growth,
            calledVolumeIntensity: call.called_volume_intensity,
            currentMcUsd:        currentMc,
            athMultiple,
            gainSinceCall,
            runStatus,
            liquidityUsd,
            ageHoursSinceCall:   ageHours,
            holderVelocityScore: call.live_hv,
            secIsHoneypot:        call.sec_is_honeypot,
            secMintRenounced:     call.sec_mint_renounced,
            secFreezeRenounced:   call.sec_freeze_renounced,
            secTop10HolderRate:   call.sec_top10_holder_rate,
            secLpLocked:          call.sec_lp_locked,
            secRatTraderAmtRate:  call.sec_rat_trader_amt_rate,
          });
          proScore = result.score;
          qualityLabel = result.qualityLabel;
          survivalScore = result.survivalScore;
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
          calledHolderVelocity: call.called_holder_velocity,
          currentMcUsd:   currentMc,
          gainSinceCall,
          athMultiple,
          runStatus,
          proScore,
          qualityLabel,
          survivalScore,
          entryTier: call.entry_tier ?? null,
          scoreVersion: call.score_version ?? "v2",
          currentKol:   Math.max(call.live_kol ?? 0, call.called_kol_count ?? 0),
          currentSmart: Math.max(call.live_smart ?? 0, call.called_smart_count ?? 0),
          currentIntel:   call.live_intel ?? call.called_intel_score,
          lastSnapshotAt: call.snap_at ?? null,
          hit2x:    call.hit_2x    ?? false, hit2xAt:  call.hit_2x_at   ?? null,
          hit3x:    call.hit_3x    ?? false, hit3xAt:  call.hit_3x_at   ?? null,
          hit5x:    call.hit_5x    ?? false, hit5xAt:  call.hit_5x_at   ?? null,
          hit10x:   call.hit_10x   ?? false, hit10xAt: call.hit_10x_at  ?? null,
          hit100x:  call.hit_100x  ?? false, hit100xAt:call.hit_100x_at ?? null,
          surfacedAt:     call.surfaced_at ?? null,
          surfacedMcUsd:  call.surfaced_mc_usd ? parseFloat(call.surfaced_mc_usd) : null,
          scannerLabel:   (call.scanner_label ?? "very_strong") as "very_strong" | "strong",
          kolSmartSource: call.kol_smart_source ?? null,
          verifiedAt:     call.verified_at ?? null,
          secMintRenounced:   call.sec_mint_renounced,
          secFreezeRenounced: call.sec_freeze_renounced,
          secIsHoneypot:      call.sec_is_honeypot,
          socials:            extractSocials(call.raw_metadata),
        };
      });

      return { total: totalMatching, totalAll: totalMatching, tokens };
    });

    res.json(body);
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
