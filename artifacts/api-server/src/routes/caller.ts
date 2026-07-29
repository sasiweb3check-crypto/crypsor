/**
 * Caller Routes
 *
 * GET /api/caller/tokens   — tokens currently qualifying (intel >= 90, KOL/Smart >= 1)
 * GET /api/caller/history  — all tokens that ever qualified, with performance since call
 * POST /api/caller/telegram/test — send a test message
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { tracked_tokens, token_intel_log, settings } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

const MIN_INTEL = 90;

// ── GET /api/caller/tokens ────────────────────────────────────────────────────
// Tokens currently meeting the alert criteria, sorted by intel desc.

router.get("/caller/tokens", async (req, res) => {
  try {
    // Latest snapshot MC per token (from intel log)
    const snapMcRows = await db.execute(sql`
      SELECT DISTINCT ON (token_id)
        token_id,
        market_cap_usd AS snap_mc,
        computed_at    AS snap_at
      FROM token_intel_log
      ORDER BY token_id, computed_at DESC
    `);
    const snapMcMap = new Map<number, { mc: string | null; at: string }>();
    for (const r of snapMcRows.rows as { token_id: number; snap_mc: string | null; snap_at: string }[]) {
      snapMcMap.set(r.token_id, { mc: r.snap_mc, at: r.snap_at });
    }

    const tokens = await db
      .select({
        id:                tracked_tokens.id,
        address:           tracked_tokens.address,
        chain:             tracked_tokens.chain,
        name:              tracked_tokens.name,
        symbol:            tracked_tokens.symbol,
        logoUri:           tracked_tokens.logoUri,
        imagePath:         tracked_tokens.imagePath,
        status:            tracked_tokens.status,
        firstDetectedAt:   tracked_tokens.firstDetectedAt,
        marketCapUsd:      tracked_tokens.marketCapUsd,
        gainPct:           tracked_tokens.gainPct,
        athGainPct:        tracked_tokens.athGainPct,
        holderCount:       tracked_tokens.holderCount,
        holderKolCount:    tracked_tokens.holderKolCount,
        holderSmartCount:  tracked_tokens.holderSmartCount,
        intelligenceScore: tracked_tokens.intelligenceScore,
        qualityLabel:      tracked_tokens.qualityLabel,
        kolSmartScore:     tracked_tokens.kolSmartScore,
        holderVelocityScore: tracked_tokens.holderVelocityScore,
        mcGrowthScore:     tracked_tokens.mcGrowthScore,
        liquidityUsd:      tracked_tokens.liquidityUsd,
        intelligenceUpdatedAt: tracked_tokens.intelligenceUpdatedAt,
      })
      .from(tracked_tokens)
      .where(
        sql`intelligence_score >= ${MIN_INTEL}
            AND (holder_kol_count >= 1 OR holder_smart_count >= 1)
            AND market_cap_usd::numeric >= 5000`,
      )
      .orderBy(sql`intelligence_score DESC`);

    const results = tokens.map(t => {
      const snap = snapMcMap.get(t.id);
      return {
        id:              t.id,
        address:         t.address,
        chain:           t.chain,
        name:            t.name,
        symbol:          t.symbol,
        logoUri:         t.imagePath ? `/api/assets${t.imagePath}` : t.logoUri,
        status:          t.status,
        firstDetectedAt: t.firstDetectedAt?.toISOString() ?? null,
        marketCapUsd:    parseFloat(t.marketCapUsd ?? "0") || null,
        snapshotMcUsd:   snap?.mc ? parseFloat(snap.mc) || null : null,
        snapshotAt:      snap?.at ?? null,
        gainPct:         t.gainPct,
        athGainPct:      t.athGainPct,
        holderCount:     t.holderCount,
        holderKolCount:  t.holderKolCount,
        holderSmartCount: t.holderSmartCount,
        intelligenceScore: t.intelligenceScore,
        qualityLabel:    t.qualityLabel,
        kolSmartScore:   t.kolSmartScore,
        holderVelocityScore: t.holderVelocityScore,
        mcGrowthScore:   t.mcGrowthScore,
        liquidityUsd:    parseFloat(t.liquidityUsd ?? "0") || null,
        intelligenceUpdatedAt: t.intelligenceUpdatedAt?.toISOString() ?? null,
      };
    });

    res.json({ total: results.length, tokens: results });
  } catch (err) {
    console.error("caller tokens error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/caller/history ───────────────────────────────────────────────────
// Tokens that have ever been called (first time they hit intel >= 90 + KOL/Smart >= 1).
// "Called at MC" = MC from that first qualifying snapshot.

router.get("/caller/history", async (req, res) => {
  try {
    const sort  = (req.query.sort  as string) ?? "calledAt";
    const order = (req.query.order as string) ?? "desc";

    // First qualifying snapshot per token
    const histRows = await db.execute(sql`
      SELECT DISTINCT ON (token_id)
        token_id,
        market_cap_usd       AS called_mc,
        intelligence_score   AS called_intel,
        holder_kol_count     AS called_kol,
        holder_smart_count   AS called_smart,
        computed_at          AS called_at
      FROM token_intel_log
      WHERE intelligence_score >= ${MIN_INTEL}
        AND (holder_kol_count >= 1 OR holder_smart_count >= 1)
        AND market_cap_usd::numeric >= 5000
      ORDER BY token_id, computed_at ASC
    `);

    if (histRows.rows.length === 0) {
      res.json({ total: 0, tokens: [] });
      return;
    }

    type HistRow = {
      token_id: number;
      called_mc: string | null;
      called_intel: number;
      called_kol: number;
      called_smart: number;
      called_at: string;
    };
    const histMap = new Map<number, HistRow>();
    for (const r of histRows.rows as HistRow[]) {
      histMap.set(r.token_id, r);
    }
    const tokenIds = [...histMap.keys()];

    const tokens = await db
      .select({
        id:                tracked_tokens.id,
        address:           tracked_tokens.address,
        chain:             tracked_tokens.chain,
        name:              tracked_tokens.name,
        symbol:            tracked_tokens.symbol,
        logoUri:           tracked_tokens.logoUri,
        imagePath:         tracked_tokens.imagePath,
        status:            tracked_tokens.status,
        marketCapUsd:      tracked_tokens.marketCapUsd,
        gainPct:           tracked_tokens.gainPct,
        athGainPct:        tracked_tokens.athGainPct,
        holderKolCount:    tracked_tokens.holderKolCount,
        holderSmartCount:  tracked_tokens.holderSmartCount,
        intelligenceScore: tracked_tokens.intelligenceScore,
        qualityLabel:      tracked_tokens.qualityLabel,
        holderVelocityScore: tracked_tokens.holderVelocityScore,
        firstDetectedAt:   tracked_tokens.firstDetectedAt,
      })
      .from(tracked_tokens)
      .where(sql`id = ANY(ARRAY[${sql.raw(tokenIds.join(","))}]::int[])`);

    const QUALITY_ORDER: Record<string, number> = {
      Elite: 7, Excellent: 6, Strong: 5, Good: 4, Average: 3, Speculative: 2, Weak: 1,
    };

    const results = tokens.map(t => {
      const hist = histMap.get(t.id)!;
      const calledMc = hist.called_mc ? parseFloat(hist.called_mc) : null;
      const currentMc = parseFloat(t.marketCapUsd ?? "0") || null;
      const gainSinceCall = calledMc && currentMc
        ? ((currentMc - calledMc) / calledMc) * 100
        : null;

      return {
        id:              t.id,
        address:         t.address,
        chain:           t.chain,
        name:            t.name,
        symbol:          t.symbol,
        logoUri:         t.imagePath ? `/api/assets${t.imagePath}` : t.logoUri,
        status:          t.status,
        firstDetectedAt: t.firstDetectedAt?.toISOString() ?? null,
        calledAt:        hist.called_at,
        calledMcUsd:     calledMc,
        calledIntel:     hist.called_intel,
        calledKol:       hist.called_kol,
        calledSmart:     hist.called_smart,
        currentMcUsd:    currentMc,
        gainSinceCall,
        athGainPct:      t.athGainPct,
        qualityLabel:    t.qualityLabel,
        intelligenceScore: t.intelligenceScore,
        holderKolCount:  t.holderKolCount,
        holderSmartCount: t.holderSmartCount,
        holderVelocityScore: t.holderVelocityScore,
        _qualityOrder:   QUALITY_ORDER[t.qualityLabel ?? ""] ?? 0,
      };
    });

    // Sorting
    results.sort((a, b) => {
      let diff = 0;
      if (sort === "quality")       diff = b._qualityOrder - a._qualityOrder;
      else if (sort === "gain")     diff = (b.gainSinceCall ?? -Infinity) - (a.gainSinceCall ?? -Infinity);
      else if (sort === "intel")    diff = (b.intelligenceScore ?? 0) - (a.intelligenceScore ?? 0);
      else if (sort === "calledMc") diff = (b.calledMcUsd ?? 0) - (a.calledMcUsd ?? 0);
      else /* calledAt */           diff = new Date(b.calledAt).getTime() - new Date(a.calledAt).getTime();
      return order === "asc" ? -diff : diff;
    });

    res.json({ total: results.length, tokens: results });
  } catch (err) {
    console.error("caller history error", err);
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
