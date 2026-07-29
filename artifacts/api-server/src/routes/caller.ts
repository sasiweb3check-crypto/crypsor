/**
 * GET /api/caller/tokens?ageBased=true|false
 *
 * Returns tokens scored by calculateRunnerPotential.
 * Only tokens with score > 0 are returned, sorted desc.
 *
 * POST /api/caller/telegram/test
 * Sends a test Telegram message using stored credentials.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { tracked_tokens, token_intel_log, settings } from "@workspace/db";
import { isNotNull, desc, sql } from "drizzle-orm";

const router = Router();

// ── Runner potential scoring ──────────────────────────────────────────────────

interface TokenSignals {
  intelligenceScore: number;
  kolSmartScore: number;
  holderVelocityScore: number;
  marketCapUsd: number;
  athGainPct: number | null;
  gainPct: number | null;
  top10Pct: number | null; // 0-1 fraction (secTop10HolderRate)
  snapshotCount: number;
}

type SignalKey =
  | "intel_score"
  | "kol_smart"
  | "holder_velocity"
  | "low_mc"
  | "ath_gap"
  | "distributed";

interface ScoreResult {
  score: number;
  signals: SignalKey[];
  maxPossible: number; // with age-based on
}

function calculateRunnerPotential(
  t: TokenSignals,
  useAgeBased = true,
): ScoreResult {
  let score = 0;
  const signals: SignalKey[] = [];

  if (t.intelligenceScore > 75) { score += 38; signals.push("intel_score"); }
  if (t.kolSmartScore > 45)      { score += 32; signals.push("kol_smart"); }
  if (t.holderVelocityScore > 75){ score += 22; signals.push("holder_velocity"); }
  // Target early-stage viable tokens ($5K–$500K MC).
  // < $5K = effectively dead/zeroed; > $500K = no longer small-cap runner.
  if (t.marketCapUsd >= 5_000 && t.marketCapUsd <= 500_000) { score += 18; signals.push("low_mc"); }

  if (useAgeBased && t.snapshotCount >= 3) {
    const athGap = (t.athGainPct ?? 0) - (t.gainPct ?? 0);
    if (athGap > 120)        { score += 15; signals.push("ath_gap"); }
    if (t.top10Pct !== null && t.top10Pct < 0.68) {
      score += 12; signals.push("distributed");
    }
  }

  return { score: Math.min(100, Math.round(score)), signals, maxPossible: 137 };
}

// ── GET /api/caller/tokens ────────────────────────────────────────────────────

router.get("/caller/tokens", async (req, res) => {
  try {
    const useAgeBased = req.query.ageBased !== "false";

    // Snapshot counts per token
    const snapRows = await db.execute(sql`
      SELECT token_id, COUNT(*)::int AS cnt
      FROM token_intel_log
      GROUP BY token_id
    `);
    const snapMap = new Map<number, number>();
    for (const r of snapRows.rows as { token_id: number; cnt: number }[]) {
      snapMap.set(r.token_id, r.cnt);
    }

    // Called-at MC from first intel log entry per token
    const firstMcRows = await db.execute(sql`
      SELECT DISTINCT ON (token_id) token_id, market_cap_usd AS called_mc
      FROM token_intel_log
      ORDER BY token_id, computed_at ASC
    `);
    const calledMcMap = new Map<number, number>();
    for (const r of firstMcRows.rows as { token_id: number; called_mc: string | null }[]) {
      if (r.called_mc) calledMcMap.set(r.token_id, parseFloat(r.called_mc));
    }

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
        detectedPriceUsd:     tracked_tokens.detectedPriceUsd,
        currentPriceUsd:      tracked_tokens.currentPriceUsd,
        marketCapUsd:         tracked_tokens.marketCapUsd,
        gainPct:              tracked_tokens.gainPct,
        athGainPct:           tracked_tokens.athGainPct,
        holderCount:          tracked_tokens.holderCount,
        holderKolCount:       tracked_tokens.holderKolCount,
        holderSmartCount:     tracked_tokens.holderSmartCount,
        holderTop10Pct:       tracked_tokens.holderTop10Pct,
        intelligenceScore:    tracked_tokens.intelligenceScore,
        qualityLabel:         tracked_tokens.qualityLabel,
        kolSmartScore:        tracked_tokens.kolSmartScore,
        holderVelocityScore:  tracked_tokens.holderVelocityScore,
        secTop10HolderRate:   tracked_tokens.secTop10HolderRate,
        liquidityUsd:         tracked_tokens.liquidityUsd,
        consecutivePositiveChecks: tracked_tokens.consecutivePositiveChecks,
      })
      .from(tracked_tokens)
      .where(isNotNull(tracked_tokens.intelligenceScore))
      .orderBy(desc(tracked_tokens.intelligenceScore));

    const results = tokens
      .map(t => {
        const mcUsd = parseFloat(t.marketCapUsd ?? "0") || 0;
        // Prefer GMGN top10 rate (0-1 fraction); fall back to holderTop10Pct / 100
        const top10Pct = t.secTop10HolderRate != null
          ? t.secTop10HolderRate
          : t.holderTop10Pct > 0 ? t.holderTop10Pct / 100 : null;

        const snapshotCount = snapMap.get(t.id) ?? 0;

        const { score, signals } = calculateRunnerPotential(
          {
            intelligenceScore:  t.intelligenceScore ?? 0,
            kolSmartScore:      t.kolSmartScore ?? 0,
            holderVelocityScore:t.holderVelocityScore ?? 0,
            marketCapUsd:       mcUsd,
            athGainPct:         t.athGainPct,
            gainPct:            t.gainPct,
            top10Pct,
            snapshotCount,
          },
          useAgeBased,
        );

        // Require at least 2 signals to fire (min meaningful score = 50).
        // Single-signal tokens (vel alone=22, kol alone=32, mc alone=18, intel alone=38)
        // are noise — a genuine runner needs multiple confirmations.
        if (score < 50) return null;

        return {
          id:              t.id,
          address:         t.address,
          chain:           t.chain,
          name:            t.name,
          symbol:          t.symbol,
          logoUri:         t.imagePath ? `/api/assets${t.imagePath}` : t.logoUri,
          status:          t.status,
          firstDetectedAt: t.firstDetectedAt?.toISOString(),
          detectedPriceUsd:t.detectedPriceUsd,
          currentPriceUsd: t.currentPriceUsd,
          marketCapUsd:    mcUsd || null,
          calledAtMcUsd:   calledMcMap.get(t.id) ?? null,
          gainPct:         t.gainPct,
          athGainPct:      t.athGainPct,
          holderCount:     t.holderCount,
          holderKolCount:  t.holderKolCount,
          holderSmartCount:t.holderSmartCount,
          top10Pct,
          liquidityUsd:    parseFloat(t.liquidityUsd ?? "0") || null,
          intelligenceScore: t.intelligenceScore,
          qualityLabel:    t.qualityLabel,
          kolSmartScore:   t.kolSmartScore,
          holderVelocityScore: t.holderVelocityScore,
          snapshotCount,
          runnerScore:     score,
          signals,
        };
      })
      .filter(Boolean);

    results.sort((a, b) => b!.runnerScore - a!.runnerScore);

    res.json({ total: results.length, useAgeBased, tokens: results });
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
      res.status(400).json({ error: "Save bot token and chat ID first." });
      return;
    }

    const text = "✅ *Crypsor Caller* — test message\\. Runner alerts are configured correctly\\.";
    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2" }),
    });

    if (!tgRes.ok) {
      const body = await tgRes.text();
      res.status(400).json({ error: `Telegram: ${body}` });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("telegram test error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
