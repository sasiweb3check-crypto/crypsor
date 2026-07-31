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

// ── GET /api/pro/stats ────────────────────────────────────────────────────────

router.get("/pro/stats", async (_req, res) => {
  try {
    const body = await cachedJson("pro:stats", 15_000, async () => {
      const result = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE quality_label IN ('very_good', 'good'))::int           AS total,
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
        x100Count:      Number(row.x100 ?? 0),
        x200Count:      Number(row.x200 ?? 0),
        bestAth:        row.best_ath != null ? Number(row.best_ath) : null,
        veryGoodCount:  Number(row.very_good_count ?? 0),
        goodCount:      Number(row.good_count      ?? 0),
        qualityCount:   Number(row.very_good_count ?? 0) + Number(row.good_count ?? 0),
        recentCount:    Number(row.recent_count    ?? 0),
      };
    });
    res.json(body);
  } catch (err) {
    console.error("pro stats error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/pro/history ──────────────────────────────────────────────────────
// Fast path: filter/sort/limit in SQL. Live MC/KOL/intel from tracked_tokens
// (always current) — no per-row LATERAL into pro_snapshots.

router.get("/pro/history", async (req, res) => {
  try {
    const sort    = (req.query.sort    as string) ?? "proScore";
    const order   = (req.query.order   as string) === "asc" ? "asc" : "desc";
    const quality = (req.query.quality as string) ?? "quality";
    const limit   = Math.min(Math.max(parseInt(String(req.query.limit ?? "150"), 10) || 150, 1), 300);

    const cacheKey = `pro:history:${quality}:${sort}:${order}:${limit}`;
    const body = await cachedJson(cacheKey, 10_000, async () => {
      let whereClause: SQL;
      if (quality === "very_good") {
        whereClause = sql`pc.quality_label = 'very_good'`;
      } else if (quality === "good") {
        whereClause = sql`pc.quality_label = 'good'`;
      } else if (quality === "recent") {
        whereClause = sql`pc.quality_label IN ('very_good', 'good')
          AND pc.called_at >= NOW() - INTERVAL '24 hours'`;
      } else if (quality === "all") {
        whereClause = sql`TRUE`;
      } else {
        // default "quality" = very_good + good
        whereClause = sql`pc.quality_label IN ('very_good', 'good')`;
      }

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
        case "proScore":
        default:
          orderClause = sql`pc.pro_score ${dir} NULLS LAST, pc.called_at DESC`;
          break;
      }

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
          pc.hit_2x,  pc.hit_2x_at,
          pc.hit_3x,  pc.hit_3x_at,
          pc.hit_5x,  pc.hit_5x_at,
          pc.hit_10x, pc.hit_10x_at,
          pc.hit_100x,pc.hit_100x_at,
          pc.surfaced_at,
          pc.surfaced_mc_usd,
          pc.scanner_label,
          t.address, t.chain, t.name, t.symbol,
          t.logo_uri, t.image_path,
          t.status,
          t.market_cap_usd,
          t.liquidity_usd,
          t.raw_metadata,
          t.intelligence_score AS live_intel,
          t.holder_kol_count   AS live_kol,
          t.holder_smart_count AS live_smart,
          t.sec_is_honeypot,
          t.sec_mint_renounced,
          t.sec_freeze_renounced,
          t.sec_top10_holder_rate,
          t.sec_lp_locked,
          t.sec_rat_trader_amt_rate,
          COUNT(*) OVER()::int AS total_matching
        FROM pro_calls pc
        JOIN tracked_tokens t ON t.id = pc.token_id
        WHERE ${whereClause}
        ORDER BY ${orderClause}
        LIMIT ${limit}
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
        scanner_label: string | null;
        live_intel: number | null;
        live_kol: number | null; live_smart: number | null;
        address: string; chain: string; name: string | null; symbol: string | null;
        logo_uri: string | null; image_path: string | null;
        status: string; market_cap_usd: string | null;
        liquidity_usd: string | null; raw_metadata: unknown;
        sec_is_honeypot: boolean | null; sec_mint_renounced: boolean | null;
        sec_freeze_renounced: boolean | null; sec_top10_holder_rate: number | null;
        sec_lp_locked: boolean | null; sec_rat_trader_amt_rate: number | null;
        total_matching: number;
      };

      const rows = callRows.rows as CallRow[];
      const totalMatching = rows[0]?.total_matching ?? 0;

      const tokens = rows.map(call => {
        const calledMc  = call.called_mc_usd ? parseFloat(call.called_mc_usd) : null;
        const currentMc = parseFloat(call.market_cap_usd ?? "0") || null;
        const liquidityUsd = parseFloat(call.liquidity_usd ?? "0") || null;
        const gainSinceCall = calledMc && currentMc
          ? ((currentMc - calledMc) / calledMc) * 100 : null;
        const athMultiple = call.ath_multiple ?? 1;
        const runStatus = deriveRunStatus(currentMc, calledMc, athMultiple);

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
