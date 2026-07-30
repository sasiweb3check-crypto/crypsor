/**
 * Pro Caller Routes
 *
 * GET /api/pro/stats    — aggregate performance (hit rates from called MC)
 * GET /api/pro/history  — all pro-called tokens with latest snapshot + run status
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { sql } from "drizzle-orm";
import { extractSocials } from "../lib/socials";

const router = Router();

// ── Run-status derivation ─────────────────────────────────────────────────────

type RunStatus = "PUMPING" | "RAN" | "SLOW" | "FLAT" | "DEAD";

function deriveRunStatus(
  currentMc: number | null,
  calledMc:  number | null,
  athMultiple: number | null,
): RunStatus {
  if (!currentMc || currentMc < 5_000) return "DEAD";
  if (!calledMc  || calledMc  === 0)   return "FLAT";

  const ratio  = currentMc / calledMc;
  const ath    = athMultiple ?? 1;
  const athMc  = calledMc * ath;

  // Still actively pumping — above call price and near ATH
  if (ratio >= 1.1 && currentMc >= athMc * 0.70) return "PUMPING";

  // Had a meaningful run (≥ 2×) but has since pulled back significantly
  if (ath >= 2.0 && currentMc < athMc * 0.50)    return "RAN";

  // Small pump, came back — peaked but not a 2× runner
  if (ath >= 1.3 && currentMc < athMc * 0.60)    return "RAN";

  // Barely moved since the call
  if (ratio >= 0.70 && ratio <= 1.30)             return "SLOW";

  return "FLAT";
}

// ── GET /api/pro/stats ────────────────────────────────────────────────────────

router.get("/pro/stats", async (_req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::int                                            AS total,
        COUNT(CASE WHEN ath_multiple >= 2   THEN 1 END)::int    AS win,
        COUNT(CASE WHEN ath_multiple >= 1.5 THEN 1 END)::int    AS x1,
        COUNT(CASE WHEN ath_multiple >= 2   THEN 1 END)::int    AS x2,
        COUNT(CASE WHEN ath_multiple >= 3   THEN 1 END)::int    AS x3,
        COUNT(CASE WHEN ath_multiple >= 5   THEN 1 END)::int    AS x5,
        COUNT(CASE WHEN ath_multiple >= 10  THEN 1 END)::int    AS x10,
        COUNT(CASE WHEN ath_multiple >= 100 THEN 1 END)::int    AS x100,
        COUNT(CASE WHEN ath_multiple >= 200 THEN 1 END)::int    AS x200,
        ROUND(MAX(ath_multiple)::numeric, 2)                    AS best_ath
      FROM pro_calls
    `);

    const row   = (result.rows[0] ?? {}) as Record<string, unknown>;
    const total = Number(row.total ?? 0);
    const win   = Number(row.win   ?? 0);

    res.json({
      total,
      winRate:   total > 0 ? Math.round((win / total) * 100) : 0,
      x1Count:   Number(row.x1   ?? 0),
      x2Count:   Number(row.x2   ?? 0),
      x3Count:   Number(row.x3   ?? 0),
      x5Count:   Number(row.x5   ?? 0),
      x10Count:  Number(row.x10  ?? 0),
      x100Count: Number(row.x100 ?? 0),
      x200Count: Number(row.x200 ?? 0),
      bestAth:   row.best_ath != null ? Number(row.best_ath) : null,
    });
  } catch (err) {
    console.error("pro stats error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/pro/history ──────────────────────────────────────────────────────

router.get("/pro/history", async (req, res) => {
  try {
    const sort  = (req.query.sort  as string) ?? "calledAt";
    const order = (req.query.order as string) ?? "desc";

    // Load all pro_calls with latest snapshot data
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
        -- Latest snapshot data
        snap.mc_usd        AS snap_mc,
        snap.kol_count     AS snap_kol,
        snap.smart_count   AS snap_smart,
        snap.intel_score   AS snap_intel,
        snap.snapshot_at   AS snap_at
      FROM pro_calls pc
      LEFT JOIN LATERAL (
        SELECT mc_usd, kol_count, smart_count, intel_score, snapshot_at
        FROM pro_snapshots
        WHERE pro_call_id = pc.id
        ORDER BY snapshot_at DESC
        LIMIT 1
      ) snap ON TRUE
    `);

    if (callRows.rows.length === 0) {
      res.json({ total: 0, tokens: [] });
      return;
    }

    type CallRow = {
      pro_call_id: number; token_id: number;
      called_at: string; called_mc_usd: string | null;
      called_intel_score: number | null;
      called_kol_count: number; called_smart_count: number;
      called_kol_smart_score: number | null;
      ath_multiple: number | null;
      snap_mc: string | null; snap_kol: number | null;
      snap_smart: number | null; snap_intel: number | null;
      snap_at: string | null;
    };

    const callMap = new Map<number, CallRow>();
    for (const r of callRows.rows as CallRow[]) callMap.set(r.token_id, r);
    const tokenIds = [...callMap.keys()];

    // Load token metadata
    const tokens = await db
      .select({
        id:          tracked_tokens.id,
        address:     tracked_tokens.address,
        chain:       tracked_tokens.chain,
        name:        tracked_tokens.name,
        symbol:      tracked_tokens.symbol,
        logoUri:     tracked_tokens.logoUri,
        imagePath:   tracked_tokens.imagePath,
        status:      tracked_tokens.status,
        marketCapUsd: tracked_tokens.marketCapUsd,
        rawMetadata: tracked_tokens.rawMetadata,
      })
      .from(tracked_tokens)
      .where(sql`id = ANY(ARRAY[${sql.raw(tokenIds.join(","))}]::int[])`);

    const results = tokens.map(t => {
      const call = callMap.get(t.id)!;
      const calledMc  = call.called_mc_usd ? parseFloat(call.called_mc_usd) : null;
      // Prefer snapshot MC (most recent pro-snapshot), fall back to tracked_tokens MC
      const snapMc    = call.snap_mc    ? parseFloat(call.snap_mc)    : null;
      const currentMc = snapMc ?? (parseFloat(t.marketCapUsd ?? "0") || null);
      const gainSinceCall = calledMc && currentMc
        ? ((currentMc - calledMc) / calledMc) * 100 : null;
      const athMultiple = call.ath_multiple ?? 1;
      const runStatus   = deriveRunStatus(currentMc, calledMc, athMultiple);

      return {
        id: t.id, address: t.address, chain: t.chain,
        name: t.name, symbol: t.symbol,
        logoUri: t.imagePath ? `/api/assets${t.imagePath}` : t.logoUri,
        status: t.status,
        calledAt:      call.called_at,
        calledMcUsd:   calledMc,
        calledIntel:   call.called_intel_score,
        calledKol:     call.called_kol_count,
        calledSmart:   call.called_smart_count,
        calledKolSmartScore: call.called_kol_smart_score,
        currentMcUsd:  currentMc,
        gainSinceCall,
        athMultiple,
        runStatus,
        // Current kol/smart from latest snapshot (or fall back to call-time values)
        currentKol:    call.snap_kol   ?? call.called_kol_count,
        currentSmart:  call.snap_smart ?? call.called_smart_count,
        currentIntel:  call.snap_intel ?? call.called_intel_score,
        lastSnapshotAt: call.snap_at ?? null,
        socials:       extractSocials(t.rawMetadata),
      };
    });

    // Sort
    results.sort((a, b) => {
      let diff = 0;
      if      (sort === "ath")      diff = (b.athMultiple ?? 0)    - (a.athMultiple ?? 0);
      else if (sort === "gain")     diff = (b.gainSinceCall ?? -Infinity) - (a.gainSinceCall ?? -Infinity);
      else if (sort === "intel")    diff = (b.currentIntel ?? 0)   - (a.currentIntel ?? 0);
      else if (sort === "calledMc") diff = (b.calledMcUsd ?? 0)    - (a.calledMcUsd ?? 0);
      else                          diff = new Date(b.calledAt).getTime() - new Date(a.calledAt).getTime();
      return order === "asc" ? -diff : diff;
    });

    res.json({ total: results.length, tokens: results });
  } catch (err) {
    console.error("pro history error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
