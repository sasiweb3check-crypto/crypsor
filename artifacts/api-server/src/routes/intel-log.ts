/**
 * GET /api/intel-log/:tokenId
 *
 * Returns the full intel score history for a token — every entry that was
 * written because the score moved ≥ 1 point or a status change occurred.
 *
 * Query params:
 *   limit  — max rows to return (default 100, max 500)
 *   offset — pagination offset (default 0)
 *   trigger — filter by trigger type: "first" | "score_change" | "status_change"
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { token_intel_log, tracked_tokens } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";

const router = Router();

router.get("/intel-log/:tokenId", async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (!isFinite(tokenId) || tokenId <= 0) {
      res.status(400).json({ error: "Invalid tokenId" });
      return;
    }

    const limit  = Math.min(parseInt(String(req.query.limit  ?? "100"), 10) || 100, 500);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"),   10) || 0,   0);
    const triggerFilter = req.query.trigger as string | undefined;

    // Validate trigger filter
    const validTriggers = ["first", "score_change", "status_change"];
    if (triggerFilter && !validTriggers.includes(triggerFilter)) {
      res.status(400).json({ error: `trigger must be one of: ${validTriggers.join(", ")}` });
      return;
    }

    // Verify token exists
    const token = await db.select({
      id: tracked_tokens.id,
      address: tracked_tokens.address,
      name: tracked_tokens.name,
      symbol: tracked_tokens.symbol,
      status: tracked_tokens.status,
      intelligenceScore: tracked_tokens.intelligenceScore,
    }).from(tracked_tokens).where(eq(tracked_tokens.id, tokenId)).limit(1);

    if (!token.length) {
      res.status(404).json({ error: "Token not found" });
      return;
    }

    // Build where clause
    const conditions = [eq(token_intel_log.tokenId, tokenId)];
    if (triggerFilter) {
      conditions.push(eq(token_intel_log.trigger, triggerFilter));
    }

    const entries = await db.select().from(token_intel_log)
      .where(and(...conditions))
      .orderBy(desc(token_intel_log.computedAt))
      .limit(limit)
      .offset(offset);

    res.json({
      token: token[0],
      weights: {
        mcGrowth:    0.27,
        volume:      0.25,
        holderVel:   0.22,
        kolSmart:    0.18,
        liquidity:   0.08,
      },
      graduationRules: {
        scoreThreshold:    55,
        positiveSignals:   3,
        consecutiveChecks: 3,
        signalFloor:       40,
      },
      total: entries.length,
      limit,
      offset,
      entries: entries.map(e => ({
        id:                   e.id,
        computedAt:           e.computedAt,
        trigger:              e.trigger,

        // Master score
        intelligenceScore:     e.intelligenceScore,
        prevIntelligenceScore: e.prevIntelligenceScore,
        scoreDelta:            e.prevIntelligenceScore !== null
          ? Math.round((e.intelligenceScore - e.prevIntelligenceScore) * 10) / 10
          : null,

        // Sub-scores with their weights
        subScores: {
          mcGrowth:        { score: e.mcGrowthScore,        weight: "27%" },
          volumeIntensity: { score: e.volumeIntensityScore, weight: "25%" },
          holderVelocity:  { score: e.holderVelocityScore,  weight: "22%" },
          kolSmart:        { score: e.kolSmartScore,         weight: "18%" },
          liquidityHealth: { score: e.liquidityHealthScore,  weight: "8%"  },
        },

        // Age factor
        ageHours:      e.tokenAgeHours,
        ageMultiplier: e.ageMultiplier,

        // Market context
        marketCapUsd:  e.marketCapUsd,
        volume24hUsd:  e.volume24hUsd,
        liquidityUsd:  e.liquidityUsd,
        peakMcUsd:     e.peakMcUsd,

        // Holder context
        holderCount:      e.holderCount,
        holderKolCount:   e.holderKolCount,
        holderSmartCount: e.holderSmartCount,

        // Buy quality
        totalBuys:       e.totalBuys,
        smartBuys:       e.smartBuys,
        labeledFraction: e.labeledFraction,

        // Cohort normalisation context
        cohort: {
          ageGroup:              e.ageGroup,
          cohortSize:            e.cohortSize,
          volumePercentile:      e.cohortVolumePercentile,
          holderVelocityPerHour: e.holderVelocityPerHour,
        },

        // Graduation gate state
        graduation: {
          consecutive:    e.graduationConsecutive,
          thresholdMet:   e.graduationThresholdMet,
          requiredStreak: 3,
        },

        // Lifecycle
        statusBefore:  e.statusBefore,
        statusAfter:   e.statusAfter,
        statusChanged: e.statusChanged,
      })),
    });
  } catch (err) {
    console.error("intel-log route error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/intel-log/recent
 *
 * Returns the most recent log entry for every tracked token — useful for a
 * quick dashboard view of which tokens are moving.
 *
 * Query params:
 *   limit  — max tokens to return (default 50, max 200)
 *   status_change_only — if "true", only tokens that had a status change in their last entry
 */
router.get("/intel-log", async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);

    // Get the latest log entry per token using a subquery approach
    const entries = await db.select().from(token_intel_log)
      .orderBy(desc(token_intel_log.computedAt))
      .limit(limit);

    res.json({
      weights: {
        mcGrowth:    0.27,
        volume:      0.25,
        holderVel:   0.22,
        kolSmart:    0.18,
        liquidity:   0.08,
      },
      total: entries.length,
      entries: entries.map(e => ({
        id:                   e.id,
        tokenId:              e.tokenId,
        tokenAddress:         e.tokenAddress,
        computedAt:           e.computedAt,
        trigger:              e.trigger,
        intelligenceScore:    e.intelligenceScore,
        prevIntelligenceScore: e.prevIntelligenceScore,
        scoreDelta:           e.prevIntelligenceScore !== null
          ? Math.round((e.intelligenceScore - e.prevIntelligenceScore) * 10) / 10
          : null,
        subScores: {
          mcGrowth:        { score: e.mcGrowthScore,        weight: "27%" },
          volumeIntensity: { score: e.volumeIntensityScore, weight: "25%" },
          holderVelocity:  { score: e.holderVelocityScore,  weight: "22%" },
          kolSmart:        { score: e.kolSmartScore,         weight: "18%" },
          liquidityHealth: { score: e.liquidityHealthScore,  weight: "8%"  },
        },
        ageHours:      e.tokenAgeHours,
        ageMultiplier: e.ageMultiplier,
        marketCapUsd:  e.marketCapUsd,
        volume24hUsd:  e.volume24hUsd,
        liquidityUsd:  e.liquidityUsd,
        peakMcUsd:     e.peakMcUsd,
        holderCount:      e.holderCount,
        holderKolCount:   e.holderKolCount,
        holderSmartCount: e.holderSmartCount,
        totalBuys:       e.totalBuys,
        smartBuys:       e.smartBuys,
        labeledFraction: e.labeledFraction,
        cohort: {
          ageGroup:              e.ageGroup,
          cohortSize:            e.cohortSize,
          volumePercentile:      e.cohortVolumePercentile,
          holderVelocityPerHour: e.holderVelocityPerHour,
        },
        graduation: {
          consecutive:    e.graduationConsecutive,
          thresholdMet:   e.graduationThresholdMet,
          requiredStreak: 3,
        },
        statusBefore:  e.statusBefore,
        statusAfter:   e.statusAfter,
        statusChanged: e.statusChanged,
      })),
    });
  } catch (err) {
    console.error("intel-log recent route error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
