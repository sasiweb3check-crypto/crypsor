/**
 * Caller Routes
 *
 * GET  /api/caller/tokens           — tokens currently qualifying (intel >= 90, KOL/Smart >= 1)
 * GET  /api/caller/history          — all tokens that ever qualified, with performance + postmortem + socials
 * GET  /api/caller/stats            — aggregate win-rate stats (2X/3X/5X counts from ATH gain)
 * POST /api/caller/kol-smart-sync   — backfill KOL/smart data in intel log + pro_calls + snapshots
 * GET  /api/caller/kol-smart-status — live view of KOL/smart counts for high-score tokens
 * POST /api/caller/telegram/test    — send a test message
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { tracked_tokens, token_intel_log, settings } from "@workspace/db";
import { sql } from "drizzle-orm";
import { derivePostmortemLabel } from "../lib/postmortem";
import { extractSocials } from "../lib/socials";

const router = Router();

const MIN_INTEL = 90;
const MIN_CALLED_MC = 5000;

// ── GET /api/caller/stats ─────────────────────────────────────────────────────
// Aggregate win-rate metrics computed from ATH gain (not current gain).

router.get("/caller/stats", async (req, res) => {
  try {
    // Use pro_calls for accurate win-rate — ath_multiple is anchored to called_mc_usd.
    // Scoped to caller-tier threshold (intel >= 90) matching MIN_INTEL above.
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::int                                              AS total,
        COUNT(CASE WHEN ath_multiple >= 2   THEN 1 END)::int      AS win,
        COUNT(CASE WHEN ath_multiple >= 2   THEN 1 END)::int      AS x2,
        COUNT(CASE WHEN ath_multiple >= 3   THEN 1 END)::int      AS x3,
        COUNT(CASE WHEN ath_multiple >= 5   THEN 1 END)::int      AS x5,
        ROUND((MIN(ath_multiple) - 1)::numeric * 100, 1)          AS min_ath,
        ROUND((MAX(ath_multiple) - 1)::numeric * 100, 1)          AS max_ath
      FROM pro_calls
      WHERE called_intel_score >= ${MIN_INTEL}
    `);
    const row = (result.rows[0] ?? {}) as Record<string, unknown>;
    const total = Number(row.total ?? 0);
    const win   = Number(row.win   ?? 0);
    res.json({
      total,
      winRate:    total > 0 ? Math.round((win / total) * 100) : 0,
      x2Count:   Number(row.x2      ?? 0),
      x3Count:   Number(row.x3      ?? 0),
      x5Count:   Number(row.x5      ?? 0),
      minAthGain: Number(row.min_ath ?? 0),
      maxAthGain: Number(row.max_ath ?? 0),
    });
  } catch (err) {
    console.error("caller stats error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/caller/tokens ────────────────────────────────────────────────────

router.get("/caller/tokens", async (req, res) => {
  try {
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
        id: tracked_tokens.id, address: tracked_tokens.address,
        chain: tracked_tokens.chain, name: tracked_tokens.name,
        symbol: tracked_tokens.symbol, logoUri: tracked_tokens.logoUri,
        imagePath: tracked_tokens.imagePath, status: tracked_tokens.status,
        firstDetectedAt: tracked_tokens.firstDetectedAt,
        marketCapUsd: tracked_tokens.marketCapUsd,
        gainPct: tracked_tokens.gainPct, athGainPct: tracked_tokens.athGainPct,
        holderCount: tracked_tokens.holderCount,
        holderKolCount: tracked_tokens.holderKolCount,
        holderSmartCount: tracked_tokens.holderSmartCount,
        intelligenceScore: tracked_tokens.intelligenceScore,
        qualityLabel: tracked_tokens.qualityLabel,
        kolSmartScore: tracked_tokens.kolSmartScore,
        holderVelocityScore: tracked_tokens.holderVelocityScore,
        mcGrowthScore: tracked_tokens.mcGrowthScore,
        liquidityUsd: tracked_tokens.liquidityUsd,
        intelligenceUpdatedAt: tracked_tokens.intelligenceUpdatedAt,
        compositeFactors: tracked_tokens.compositeFactors,
        rawMetadata: tracked_tokens.rawMetadata,
      })
      .from(tracked_tokens)
      .where(
        sql`intelligence_score >= ${MIN_INTEL}
            AND (holder_kol_count >= 1 OR holder_smart_count >= 1)
            AND market_cap_usd::numeric >= ${MIN_CALLED_MC}`,
      )
      .orderBy(sql`intelligence_score DESC`);

    const results = tokens.map(t => {
      const snap = snapMcMap.get(t.id);
      return {
        id: t.id, address: t.address, chain: t.chain,
        name: t.name, symbol: t.symbol,
        logoUri: t.imagePath ? `/api/assets${t.imagePath}` : t.logoUri,
        status: t.status,
        firstDetectedAt: t.firstDetectedAt?.toISOString() ?? null,
        marketCapUsd: parseFloat(t.marketCapUsd ?? "0") || null,
        snapshotMcUsd: snap?.mc ? parseFloat(snap.mc) || null : null,
        snapshotAt: snap?.at ?? null,
        gainPct: t.gainPct, athGainPct: t.athGainPct,
        holderCount: t.holderCount, holderKolCount: t.holderKolCount,
        holderSmartCount: t.holderSmartCount,
        intelligenceScore: t.intelligenceScore, qualityLabel: t.qualityLabel,
        kolSmartScore: t.kolSmartScore, holderVelocityScore: t.holderVelocityScore,
        mcGrowthScore: t.mcGrowthScore,
        liquidityUsd: parseFloat(t.liquidityUsd ?? "0") || null,
        intelligenceUpdatedAt: t.intelligenceUpdatedAt?.toISOString() ?? null,
        postmortemLabel: derivePostmortemLabel(t.compositeFactors),
        socials: extractSocials(t.rawMetadata),
      };
    });

    res.json({ total: results.length, tokens: results });
  } catch (err) {
    console.error("caller tokens error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/caller/history ───────────────────────────────────────────────────

router.get("/caller/history", async (req, res) => {
  try {
    const sort  = (req.query.sort  as string) ?? "calledAt";
    const order = (req.query.order as string) ?? "desc";

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
        AND market_cap_usd::numeric >= ${MIN_CALLED_MC}
      ORDER BY token_id, computed_at ASC
    `);

    if (histRows.rows.length === 0) {
      res.json({ total: 0, tokens: [] });
      return;
    }

    type HistRow = {
      token_id: number; called_mc: string | null;
      called_intel: number; called_kol: number;
      called_smart: number; called_at: string;
    };
    const histMap = new Map<number, HistRow>();
    for (const r of histRows.rows as HistRow[]) histMap.set(r.token_id, r);
    const tokenIds = [...histMap.keys()];

    const tokens = await db
      .select({
        id: tracked_tokens.id, address: tracked_tokens.address,
        chain: tracked_tokens.chain, name: tracked_tokens.name,
        symbol: tracked_tokens.symbol, logoUri: tracked_tokens.logoUri,
        imagePath: tracked_tokens.imagePath, status: tracked_tokens.status,
        marketCapUsd: tracked_tokens.marketCapUsd,
        gainPct: tracked_tokens.gainPct, athGainPct: tracked_tokens.athGainPct,
        holderKolCount: tracked_tokens.holderKolCount,
        holderSmartCount: tracked_tokens.holderSmartCount,
        intelligenceScore: tracked_tokens.intelligenceScore,
        qualityLabel: tracked_tokens.qualityLabel,
        holderVelocityScore: tracked_tokens.holderVelocityScore,
        firstDetectedAt: tracked_tokens.firstDetectedAt,
        compositeFactors: tracked_tokens.compositeFactors,
        rawMetadata: tracked_tokens.rawMetadata,
      })
      .from(tracked_tokens)
      .where(sql`id = ANY(ARRAY[${sql.raw(tokenIds.join(","))}]::int[])`);

    const QUALITY_ORDER: Record<string, number> = {
      Elite: 7, Excellent: 6, Strong: 5, Good: 4, Average: 3, Speculative: 2, Weak: 1,
    };

    const results = tokens
      .filter(t => (parseFloat(t.marketCapUsd ?? "0") || 0) >= MIN_CALLED_MC)
      .map(t => {
      const hist = histMap.get(t.id)!;
      const calledMc  = hist.called_mc ? parseFloat(hist.called_mc) : null;
      const currentMc = parseFloat(t.marketCapUsd ?? "0") || null;
      const gainSinceCall = calledMc && currentMc
        ? ((currentMc - calledMc) / calledMc) * 100 : null;

      return {
        id: t.id, address: t.address, chain: t.chain,
        name: t.name, symbol: t.symbol,
        logoUri: t.imagePath ? `/api/assets${t.imagePath}` : t.logoUri,
        status: t.status,
        firstDetectedAt: t.firstDetectedAt?.toISOString() ?? null,
        calledAt: hist.called_at, calledMcUsd: calledMc,
        calledIntel: hist.called_intel, calledKol: hist.called_kol,
        calledSmart: hist.called_smart, currentMcUsd: currentMc,
        gainSinceCall, athGainPct: t.athGainPct,
        qualityLabel: t.qualityLabel,
        intelligenceScore: t.intelligenceScore,
        holderKolCount: t.holderKolCount,
        holderSmartCount: t.holderSmartCount,
        holderVelocityScore: t.holderVelocityScore,
        postmortemLabel: derivePostmortemLabel(t.compositeFactors),
        socials: extractSocials(t.rawMetadata),
        _qualityOrder: QUALITY_ORDER[t.qualityLabel ?? ""] ?? 0,
      };
    });

    // History shows ALL ever-called tokens regardless of current MC or postmortem label.
    // (Live tokens endpoint keeps the MC filter; history is permanent.)
    const filtered = results;

    filtered.sort((a, b) => {
      let diff = 0;
      if (sort === "quality")       diff = b._qualityOrder - a._qualityOrder;
      else if (sort === "gain")     diff = (b.gainSinceCall ?? -Infinity) - (a.gainSinceCall ?? -Infinity);
      else if (sort === "intel")    diff = (b.intelligenceScore ?? 0) - (a.intelligenceScore ?? 0);
      else if (sort === "calledMc") diff = (b.calledMcUsd ?? 0) - (a.calledMcUsd ?? 0);
      else /* calledAt */           diff = new Date(b.calledAt).getTime() - new Date(a.calledAt).getTime();
      return order === "asc" ? -diff : diff;
    });

    res.json({ total: filtered.length, tokens: filtered });
  } catch (err) {
    console.error("caller history error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/caller/kol-smart-sync ──────────────────────────────────────────
//
// Root-cause fix for the KOL/Smart data gap:
//
// Timeline of the bug:
//   1. New token detected → intelligence engine scores it immediately (KOL/smart = 0
//      because GMGN holder scan hasn't run yet) → logs entry with kol = 0.
//   2. GMGN data arrives → tracked_tokens.holder_kol_count updated to 3, 5, etc.
//   3. Next intel cycle writes a NEW log entry with correct KOL/smart — but
//      the pro-scanner picks the EARLIEST qualifying entry per token.
//      If that earliest entry had kol = 0, the token never enters pro_calls.
//
// This endpoint:
//   Step 1 — Updates token_intel_log entries (intel >= 80, kol = 0) where
//             tracked_tokens now has kol/smart > 0. Backfills the counts.
//   Step 2 — Updates pro_calls where called_kol/smart = 0 but tracked_tokens
//             now has real data (fixes existing calls showing K0 S0).
//   Step 3 — Updates latest pro_snapshots kol/smart = 0 entries (fixes
//             currentKol / currentSmart shown in the frontend token rows).
//   Step 4 — Runs the pro-scanner INSERT to register any tokens that now
//             qualify after the log backfill.

router.post("/caller/kol-smart-sync", async (_req, res) => {
  try {
    // ── Step 1: backfill token_intel_log ───────────────────────────────────
    const logUpdate = await db.execute(sql`
      UPDATE token_intel_log l
      SET
        holder_kol_count   = t.holder_kol_count,
        holder_smart_count = t.holder_smart_count,
        kol_smart_score    = LEAST(100.0, GREATEST(0.0, (
          (t.holder_kol_count::float / NULLIF(t.holder_count, 0)) * 250.0 +
          (t.holder_smart_count::float / NULLIF(t.holder_count, 0)) * 200.0
        )::real))
      FROM tracked_tokens t
      WHERE l.token_id = t.id
        AND (l.holder_kol_count IS NULL OR l.holder_kol_count = 0)
        AND (l.holder_smart_count IS NULL OR l.holder_smart_count = 0)
        AND (t.holder_kol_count >= 1 OR t.holder_smart_count >= 1)
        AND l.intelligence_score >= 80
    `);

    // ── Step 2: backfill pro_calls.called_kol/smart ────────────────────────
    const callsUpdate = await db.execute(sql`
      UPDATE pro_calls pc
      SET
        called_kol_count     = t.holder_kol_count,
        called_smart_count   = t.holder_smart_count,
        called_kol_smart_score = LEAST(100.0, GREATEST(0.0, (
          (t.holder_kol_count::float / NULLIF(t.holder_count, 0)) * 250.0 +
          (t.holder_smart_count::float / NULLIF(t.holder_count, 0)) * 200.0
        )::real))
      FROM tracked_tokens t
      WHERE pc.token_id = t.id
        AND (pc.called_kol_count IS NULL OR pc.called_kol_count = 0)
        AND (pc.called_smart_count IS NULL OR pc.called_smart_count = 0)
        AND (t.holder_kol_count >= 1 OR t.holder_smart_count >= 1)
    `);

    // ── Step 3: backfill latest pro_snapshots kol/smart ───────────────────
    const snapUpdate = await db.execute(sql`
      UPDATE pro_snapshots ps
      SET
        kol_count   = t.holder_kol_count,
        smart_count = t.holder_smart_count
      FROM tracked_tokens t
      JOIN pro_calls pc ON pc.token_id = t.id
      WHERE ps.pro_call_id = pc.id
        AND ps.id = (
          SELECT id FROM pro_snapshots s2
          WHERE s2.pro_call_id = pc.id
          ORDER BY s2.snapshot_at DESC
          LIMIT 1
        )
        AND (ps.kol_count IS NULL OR ps.kol_count = 0)
        AND (ps.smart_count IS NULL OR ps.smart_count = 0)
        AND (t.holder_kol_count >= 1 OR t.holder_smart_count >= 1)
    `);

    // ── Step 4: register newly qualifying tokens (pro-scanner pass) ────────
    const MIN_INTEL = 80;
    const MIN_MC    = 5_000;
    const proInsert = await db.execute(sql`
      INSERT INTO pro_calls (
        token_id, called_at, called_mc_usd, called_intel_score,
        called_kol_count, called_smart_count, called_kol_smart_score
      )
      SELECT DISTINCT ON (l.token_id)
        l.token_id,
        l.computed_at,
        l.market_cap_usd,
        l.intelligence_score,
        l.holder_kol_count,
        l.holder_smart_count,
        l.kol_smart_score
      FROM token_intel_log l
      WHERE l.intelligence_score        >= ${MIN_INTEL}
        AND (l.holder_kol_count >= 1 OR l.holder_smart_count >= 1)
        AND l.market_cap_usd::numeric   >= ${MIN_MC}
        AND l.status_after IN ('new', 'active', 'watch')
        AND NOT EXISTS (
          SELECT 1 FROM pro_calls pc WHERE pc.token_id = l.token_id
        )
      ORDER BY l.token_id, l.computed_at ASC
      ON CONFLICT (token_id) DO NOTHING
    `);

    const logUpdated   = Number((logUpdate   as unknown as { rowCount?: number }).rowCount ?? 0);
    const callsUpdated = Number((callsUpdate as unknown as { rowCount?: number }).rowCount ?? 0);
    const snapsUpdated = Number((snapUpdate  as unknown as { rowCount?: number }).rowCount ?? 0);
    const newCalls     = Number((proInsert   as unknown as { rowCount?: number }).rowCount ?? 0);

    console.log(`[kol-smart-sync] log=${logUpdated} calls=${callsUpdated} snaps=${snapsUpdated} new=${newCalls}`);
    res.json({
      ok: true,
      logEntriesBackfilled: logUpdated,
      proCallsBackfilled:   callsUpdated,
      snapshotsBackfilled:  snapsUpdated,
      newProCallsAdded:     newCalls,
    });
  } catch (err) {
    console.error("kol-smart-sync error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/caller/kol-smart-status ─────────────────────────────────────────
// Live view: shows high-score tokens with their current KOL/smart counts from
// tracked_tokens vs what's stored in the latest intel log entry + pro_calls.
// Use this to verify the sync worked and to monitor the live pipeline.

router.get("/caller/kol-smart-status", async (_req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT
        t.id,
        t.name,
        t.symbol,
        t.market_cap_usd,
        t.intelligence_score,
        t.holder_kol_count     AS live_kol,
        t.holder_smart_count   AS live_smart,
        t.holder_count,
        pc.id IS NOT NULL      AS in_pro_calls,
        pc.called_kol_count    AS pc_kol,
        pc.called_smart_count  AS pc_smart,
        latest_log.holder_kol_count   AS log_kol,
        latest_log.holder_smart_count AS log_smart,
        latest_log.computed_at        AS log_at
      FROM tracked_tokens t
      LEFT JOIN pro_calls pc ON pc.token_id = t.id
      LEFT JOIN LATERAL (
        SELECT holder_kol_count, holder_smart_count, computed_at
        FROM token_intel_log
        WHERE token_id = t.id
        ORDER BY computed_at DESC
        LIMIT 1
      ) latest_log ON true
      WHERE t.intelligence_score >= 70
        AND t.market_cap_usd::numeric >= 1000
      ORDER BY t.intelligence_score DESC
      LIMIT 100
    `);
    res.json({ tokens: rows.rows, total: rows.rows.length });
  } catch (err) {
    console.error("kol-smart-status error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/caller/telegram/test ────────────────────────────────────────────
// Optional body: { botToken?, chatId? } — falls back to saved settings.

router.post("/caller/telegram/test", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { botToken?: string; chatId?: string };
    const rows = await db.select().from(settings)
      .where(sql`key IN ('telegram_bot_token', 'telegram_chat_id')`);
    const botToken = (
      (typeof body.botToken === "string" && body.botToken.trim()) ||
      (rows.find(r => r.key === "telegram_bot_token")?.value ?? "")
    ).trim();
    const chatIdRaw = (
      (typeof body.chatId === "string" && body.chatId.trim()) ||
      (rows.find(r => r.key === "telegram_chat_id")?.value ?? "")
    ).trim();
    if (!botToken || !chatIdRaw) {
      const { opsLog } = await import("../lib/ops-log");
      opsLog("telegram", "warn", "Test skipped — missing bot token or chat id");
      res.status(400).json({ error: "Save bot token and chat ID first (or pass them in the request)." });
      return;
    }
    const chat_id = /^-?\d+$/.test(chatIdRaw) ? Number(chatIdRaw) : chatIdRaw;

    const text = "Crypsor Caller — test OK. Alerts are configured.";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const t0 = Date.now();
    let tgRes: Response;
    try {
      tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id, text, disable_web_page_preview: true }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const { opsLog } = await import("../lib/ops-log");
    const latencyMs = Date.now() - t0;
    const bodyText = await tgRes.text().catch(() => "");
    if (!tgRes.ok) {
      let detail = bodyText.slice(0, 400);
      try {
        const j = JSON.parse(bodyText) as { description?: string };
        if (j.description) detail = j.description;
      } catch { /* keep raw */ }
      opsLog("telegram", "error", `Test failed: ${detail}`, { latencyMs }, latencyMs);
      res.status(400).json({ error: `Telegram: ${detail}` });
      return;
    }
    opsLog("telegram", "info", "Telegram test OK", { latencyMs }, latencyMs);
    res.json({ ok: true, latencyMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("telegram test error", err);
    try {
      const { opsLog } = await import("../lib/ops-log");
      opsLog("telegram", "error", `Test exception: ${msg.slice(0, 180)}`);
    } catch { /* ignore */ }
    res.status(500).json({
      error: msg.includes("abort") || msg.includes("Abort")
        ? "Telegram request timed out — check outbound network from the API host."
        : `Telegram test failed: ${msg}`,
    });
  }
});

export default router;
