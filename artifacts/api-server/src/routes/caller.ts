/**
 * GET /api/caller
 *
 * Returns tokens ranked by callerScore, with all fields needed for the
 * Degen Caller UI. Isolated from the main /api/tokens route.
 *
 * Query params:
 *   label   — filter by callerLabel: STRONG MOON CALL | GOOD CALL | WATCH | SKIP
 *   phase   — filter by callerPhase: Early Degen | Survival
 *   limit   — max rows (default 100, max 200)
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { desc, sql, and, eq, isNotNull } from "drizzle-orm";

const router = Router();

router.get("/caller", async (req, res) => {
  try {
    const limit  = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "100"), 10) || 100));
    const label  = String(req.query.label  ?? "").trim();
    const phase  = String(req.query.phase  ?? "").trim();

    const conditions = [isNotNull(tracked_tokens.callerScore)];

    if (label) conditions.push(eq(tracked_tokens.callerLabel, label));
    if (phase) conditions.push(eq(tracked_tokens.callerPhase, phase));

    const rows = await db
      .select({
        id:                  tracked_tokens.id,
        address:             tracked_tokens.address,
        chain:               tracked_tokens.chain,
        name:                tracked_tokens.name,
        symbol:              tracked_tokens.symbol,
        logoUri:             tracked_tokens.logoUri,
        imagePath:           tracked_tokens.imagePath,
        status:              tracked_tokens.status,
        marketCapUsd:        tracked_tokens.marketCapUsd,
        gainPct:             tracked_tokens.gainPct,
        athGainPct:          tracked_tokens.athGainPct,
        firstDetectedAt:     tracked_tokens.firstDetectedAt,
        lastHoldersUpdatedAt: tracked_tokens.lastHoldersUpdatedAt,
        // Core sub-scores
        mcGrowthScore:       tracked_tokens.mcGrowthScore,
        holderVelocityScore: tracked_tokens.holderVelocityScore,
        kolSmartScore:       tracked_tokens.kolSmartScore,
        holderTop10Pct:      tracked_tokens.holderTop10Pct,
        holderKolCount:      tracked_tokens.holderKolCount,
        holderSmartCount:    tracked_tokens.holderSmartCount,
        holderCount:         tracked_tokens.holderCount,
        // Caller score fields
        callerScore:         tracked_tokens.callerScore,
        callerPhase:         tracked_tokens.callerPhase,
        callerLabel:         tracked_tokens.callerLabel,
        holderSnapshotCount: tracked_tokens.holderSnapshotCount,
        // ATH gap (computed on the fly for display)
        athGap: sql<number | null>`
          CASE
            WHEN ${tracked_tokens.athGainPct} IS NOT NULL AND ${tracked_tokens.gainPct} IS NOT NULL
            THEN ${tracked_tokens.athGainPct} - ${tracked_tokens.gainPct}
            ELSE NULL
          END
        `,
      })
      .from(tracked_tokens)
      .where(and(...conditions))
      .orderBy(desc(tracked_tokens.callerScore))
      .limit(limit);

    const data = rows.map(r => ({
      ...r,
      logoUri:         r.imagePath ? `/api/assets${r.imagePath}` : r.logoUri,
      firstDetectedAt: r.firstDetectedAt.toISOString(),
      lastHoldersUpdatedAt: r.lastHoldersUpdatedAt?.toISOString() ?? null,
    }));

    res.json({ data, total: data.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
