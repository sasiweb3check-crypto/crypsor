/**
 * GET /api/caller/tokens
 * Returns all scored tokens with composite scores computed from existing
 * sub-scores in tracked_tokens, sorted by compositeScore desc.
 *
 * POST /api/caller/telegram/test
 * Sends a test Telegram message using stored bot token + chat id.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { tracked_tokens, token_intel_log, settings } from "@workspace/db";
import { eq, desc, sql, isNotNull, and, asc } from "drizzle-orm";

const router = Router();

// ── Scoring engine (inlined from scoringEngine.ts) ────────────────────────────

const WEIGHTS = {
  holderVelocity: 0.40,
  mcGrowth:       0.22,
  liquidityHealth:0.16,
  kolSmart:       0.13,
  volIntensity:   0.09,
};

const T = {
  liquidityHealthLow:   15,
  liquidityHealthHigh:  20,
  kolSmartHigh:         70,
  kolSmartMid:          48,
  mcGrowthLow:          15,
  mcGrowthHigh:         51.9,
  volIntensityHigh:     86.6,
  holderVelocityHigh:   90,
  holderVelocityLow:    40,
};

type FactorTag =
  | "GOOD_MOMENTUM"
  | "GOOD_LIQUIDITY"
  | "GOOD_SMART_MONEY"
  | "SURPRISE_ACCUMULATION"
  | "SURPRISE_HOLDER_SURGE"
  | "DUMP_LIQUIDITY_DRAIN"
  | "DUMP_HOLDER_EXODUS"
  | "DUMP_STALE_PUMP";

function computeComposite(sig: {
  mcGrowth: number; volIntensity: number; holderVelocity: number;
  kolSmart: number; liquidityHealth: number; ageMultiplier: number;
}): number {
  const raw =
    sig.holderVelocity  * WEIGHTS.holderVelocity  +
    sig.mcGrowth        * WEIGHTS.mcGrowth        +
    sig.liquidityHealth * WEIGHTS.liquidityHealth +
    sig.kolSmart        * WEIGHTS.kolSmart        +
    sig.volIntensity    * WEIGHTS.volIntensity;
  const ageFactor = Math.min(1.3, Math.max(0.7, sig.ageMultiplier));
  return Math.round(Math.max(0, Math.min(100, raw * ageFactor)) * 10) / 10;
}

function detectFactors(sig: {
  holderVelocity: number; liquidityHealth: number; liquidityUsd: number;
  kolSmart: number; mcGrowth: number; volIntensity: number;
  totalBuys: number; smartBuys: number;
}): FactorTag[] {
  const tags: FactorTag[] = [];
  const smartRatio = sig.totalBuys > 0 ? sig.smartBuys / sig.totalBuys : 0;

  if (sig.holderVelocity >= T.holderVelocityHigh) tags.push("GOOD_MOMENTUM");
  if (sig.liquidityHealth >= T.liquidityHealthHigh && sig.liquidityUsd > 5000)
    tags.push("GOOD_LIQUIDITY");
  if (sig.kolSmart >= T.kolSmartHigh && sig.mcGrowth >= T.mcGrowthLow && smartRatio > 0)
    tags.push("GOOD_SMART_MONEY");
  if (sig.kolSmart >= T.kolSmartMid && sig.mcGrowth < T.mcGrowthLow)
    tags.push("SURPRISE_ACCUMULATION");
  if (sig.holderVelocity >= T.holderVelocityHigh && sig.mcGrowth < T.mcGrowthLow)
    tags.push("SURPRISE_HOLDER_SURGE");
  if (sig.liquidityHealth <= T.liquidityHealthLow && sig.volIntensity >= T.volIntensityHigh)
    tags.push("DUMP_LIQUIDITY_DRAIN");
  if (sig.holderVelocity <= T.holderVelocityLow && sig.volIntensity >= T.volIntensityHigh)
    tags.push("DUMP_HOLDER_EXODUS");
  if (
    sig.mcGrowth >= T.mcGrowthHigh &&
    sig.holderVelocity <= T.holderVelocityLow &&
    sig.liquidityHealth <= T.liquidityHealthLow
  ) tags.push("DUMP_STALE_PUMP");

  return tags;
}

// ── GET /api/caller/tokens ────────────────────────────────────────────────────

router.get("/caller/tokens", async (req, res) => {
  try {
    // Fetch all tokens that have been through the intelligence engine
    const tokens = await db
      .select({
        id:                   tracked_tokens.id,
        address:              tracked_tokens.address,
        chain:                tracked_tokens.chain,
        name:                 tracked_tokens.name,
        symbol:               tracked_tokens.symbol,
        logoUri:              tracked_tokens.logoUri,
        imagePath:            tracked_tokens.imagePath,
        status:               tracked_tokens.status,
        firstDetectedAt:      tracked_tokens.firstDetectedAt,
        tokenCreatedAt:       tracked_tokens.tokenCreatedAt,
        detectedPriceUsd:     tracked_tokens.detectedPriceUsd,
        currentPriceUsd:      tracked_tokens.currentPriceUsd,
        marketCapUsd:         tracked_tokens.marketCapUsd,
        athMarketCapUsd:      tracked_tokens.athMarketCapUsd,
        peakMcUsd:            tracked_tokens.peakMcUsd,
        gainPct:              tracked_tokens.gainPct,
        athGainPct:           tracked_tokens.athGainPct,
        liquidityUsd:         tracked_tokens.liquidityUsd,
        volume24hUsd:         tracked_tokens.volume24hUsd,
        holderCount:          tracked_tokens.holderCount,
        holderKolCount:       tracked_tokens.holderKolCount,
        holderSmartCount:     tracked_tokens.holderSmartCount,
        intelligenceScore:    tracked_tokens.intelligenceScore,
        qualityLabel:         tracked_tokens.qualityLabel,
        mcGrowthScore:        tracked_tokens.mcGrowthScore,
        volumeIntensityScore: tracked_tokens.volumeIntensityScore,
        holderVelocityScore:  tracked_tokens.holderVelocityScore,
        kolSmartScore:        tracked_tokens.kolSmartScore,
        liquidityHealthScore: tracked_tokens.liquidityHealthScore,
        intelligenceUpdatedAt:tracked_tokens.intelligenceUpdatedAt,
        consecutivePositiveChecks: tracked_tokens.consecutivePositiveChecks,
      })
      .from(tracked_tokens)
      .where(isNotNull(tracked_tokens.intelligenceScore))
      .orderBy(desc(tracked_tokens.intelligenceScore));

    // Get earliest intel log entry per token (for "called at MC")
    const firstLogEntries = await db.execute(sql`
      SELECT DISTINCT ON (token_id) token_id, market_cap_usd AS called_at_mc_usd
      FROM token_intel_log
      ORDER BY token_id, computed_at ASC
    `);

    const calledMcMap = new Map<number, number>();
    for (const row of firstLogEntries.rows as { token_id: number; called_at_mc_usd: string | null }[]) {
      if (row.called_at_mc_usd != null) {
        calledMcMap.set(row.token_id, parseFloat(row.called_at_mc_usd));
      }
    }

    // Compute composite scores
    const now = Date.now();
    const result = tokens.map(t => {
      const ageHours = t.firstDetectedAt
        ? (now - new Date(t.firstDetectedAt).getTime()) / 3_600_000
        : 0;
      // Age multiplier: 0.7 for very new (<1h) or very old (>72h), peaks 1.3 at ~8h
      const ageMultiplier = ageHours < 1
        ? 0.7 + ageHours * 0.3
        : ageHours <= 8
        ? 1.0 + (ageHours - 1) * (0.3 / 7)
        : ageHours <= 24
        ? 1.3 - (ageHours - 8) * (0.3 / 16)
        : Math.max(0.7, 1.0 - (ageHours - 24) * (0.01));

      const mcGrowth        = t.mcGrowthScore        ?? 0;
      const volIntensity    = t.volumeIntensityScore  ?? 0;
      const holderVelocity  = t.holderVelocityScore   ?? 0;
      const kolSmart        = t.kolSmartScore         ?? 0;
      const liquidityHealth = t.liquidityHealthScore  ?? 0;
      const liquidityUsd    = parseFloat(t.liquidityUsd ?? "0") || 0;

      const compositeScore = computeComposite({
        mcGrowth, volIntensity, holderVelocity, kolSmart, liquidityHealth, ageMultiplier,
      });

      const factors = detectFactors({
        holderVelocity, liquidityHealth, liquidityUsd,
        kolSmart, mcGrowth, volIntensity,
        totalBuys: 0, smartBuys: 0,
      });

      const calledAtMcUsd = calledMcMap.get(t.id) ?? null;
      const mcUsd = parseFloat(t.marketCapUsd ?? "0") || null;

      return {
        id:               t.id,
        address:          t.address,
        chain:            t.chain,
        name:             t.name,
        symbol:           t.symbol,
        logoUri:          t.imagePath ? `/api/assets${t.imagePath}` : t.logoUri,
        status:           t.status,
        firstDetectedAt:  t.firstDetectedAt?.toISOString(),
        detectedPriceUsd: t.detectedPriceUsd,
        currentPriceUsd:  t.currentPriceUsd,
        marketCapUsd:     mcUsd,
        athMarketCapUsd:  t.athMarketCapUsd ? parseFloat(t.athMarketCapUsd) : null,
        peakMcUsd:        t.peakMcUsd ? parseFloat(t.peakMcUsd) : null,
        calledAtMcUsd,
        gainPct:          t.gainPct,
        athGainPct:       t.athGainPct,
        liquidityUsd,
        volume24hUsd:     parseFloat(t.volume24hUsd ?? "0") || null,
        holderCount:      t.holderCount,
        holderKolCount:   t.holderKolCount,
        holderSmartCount: t.holderSmartCount,
        // Master score (from intel engine)
        intelligenceScore: t.intelligenceScore,
        qualityLabel:      t.qualityLabel,
        // Composite score (from caller scoring engine)
        compositeScore,
        factors,
        subScores: {
          mcGrowth,
          volIntensity,
          holderVelocity,
          kolSmart,
          liquidityHealth,
        },
        ageHours: Math.round(ageHours * 10) / 10,
        consecutivePositiveChecks: t.consecutivePositiveChecks,
        intelligenceUpdatedAt: t.intelligenceUpdatedAt?.toISOString() ?? null,
      };
    });

    // Sort by compositeScore desc
    result.sort((a, b) => b.compositeScore - a.compositeScore);

    res.json({ total: result.length, tokens: result });
  } catch (err) {
    console.error("caller tokens error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/caller/telegram/test ────────────────────────────────────────────

router.post("/caller/telegram/test", async (req, res) => {
  try {
    const rows = await db.select().from(settings)
      .where(sql`key IN ('telegram_bot_token', 'telegram_chat_id')`);

    const botToken = rows.find(r => r.key === "telegram_bot_token")?.value ?? "";
    const chatId   = rows.find(r => r.key === "telegram_chat_id")?.value   ?? "";

    if (!botToken || !chatId) {
      res.status(400).json({ error: "Bot token and chat ID must be saved first." });
      return;
    }

    const text =
      `✅ *Crypsor Caller — Test Message*\n\nYour Telegram alerts are configured correctly\\. Crypsor will notify you here when a token scores a GOOD\\_SETUP, SURPRISE\\_SIGNAL, or DUMP\\_WARNING\\.`;

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const tgRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2" }),
    });

    if (!tgRes.ok) {
      const body = await tgRes.text();
      res.status(400).json({ error: `Telegram error: ${body}` });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("telegram test error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
