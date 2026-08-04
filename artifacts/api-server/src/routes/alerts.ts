/**
 * Pump desk alerts API — notification center feed, stats, mark-read.
 *
 * GET  /api/alerts          — recent alerts (paginated)
 * GET  /api/alerts/stats    — counts by kind / telegram / unread
 * POST /api/alerts/read     — mark ids (or all) as read
 * POST /api/alerts/test     — optional test fire (heavy routes only — skipped)
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { apiFail, apiOk } from "../lib/api-envelope";
import { toIsoUtc } from "../lib/pro-cache";

const router = Router();

function mapAlert(r: Record<string, unknown>) {
  return {
    id: Number(r.id),
    tokenId: Number(r.token_id),
    kind: String(r.kind),
    label: String(r.label),
    title: String(r.title),
    body: r.body != null ? String(r.body) : null,
    score: r.score != null ? Number(r.score) : null,
    grade: r.grade != null ? String(r.grade) : null,
    buySignal: r.buy_signal != null ? String(r.buy_signal) : null,
    intraSignal: r.intra_signal != null ? String(r.intra_signal) : null,
    marketCapUsd: r.market_cap_usd != null ? parseFloat(String(r.market_cap_usd)) || null : null,
    mcAtDetection: r.mc_at_detection != null ? parseFloat(String(r.mc_at_detection)) || null : null,
    gainPct: r.gain_pct != null ? Number(r.gain_pct) : null,
    athGainPct: r.ath_gain_pct != null ? Number(r.ath_gain_pct) : null,
    symbol: r.symbol != null ? String(r.symbol) : null,
    name: r.name != null ? String(r.name) : null,
    address: r.address != null ? String(r.address) : null,
    telegramSent: Boolean(r.telegram_sent),
    telegramError: r.telegram_error != null ? String(r.telegram_error) : null,
    readAt: toIsoUtc(r.read_at),
    createdAt: toIsoUtc(r.created_at) ?? new Date(0).toISOString(),
  };
}

router.get("/alerts/stats", async (_req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread,
        COUNT(*) FILTER (WHERE telegram_sent)::int AS telegram_sent,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_24h,
        COUNT(*) FILTER (WHERE kind = 'STRONG_BUY')::int AS strong_buy,
        COUNT(*) FILTER (WHERE kind = 'INTRA_NOW')::int AS intra_now,
        COUNT(*) FILTER (WHERE kind IN ('GRADE_S','GRADE_A'))::int AS grade_sa,
        COUNT(*) FILTER (WHERE kind IN ('EEI','LARRY'))::int AS eei,
        COUNT(*) FILTER (WHERE kind = 'GAIN_50')::int AS gain_50,
        COUNT(*) FILTER (WHERE kind = 'ATH_2X')::int AS ath_2x,
        COUNT(*) FILTER (WHERE kind = 'ATH_5X')::int AS ath_5x,
        COUNT(*) FILTER (WHERE kind = 'ATH_10X')::int AS ath_10x,
        COUNT(*) FILTER (WHERE kind LIKE 'ATH_%')::int AS milestones
      FROM pump_alerts
    `);
    const r = (rows.rows[0] ?? {}) as Record<string, unknown>;
    const byKindRows = await db.execute(sql`
      SELECT kind, COUNT(*)::int AS n
      FROM pump_alerts
      GROUP BY kind
      ORDER BY n DESC
    `);
    res.json(apiOk({
      total: Number(r.total ?? 0),
      unread: Number(r.unread ?? 0),
      telegramSent: Number(r.telegram_sent ?? 0),
      last24h: Number(r.last_24h ?? 0),
      strongBuy: Number(r.strong_buy ?? 0),
      intraNow: Number(r.intra_now ?? 0),
      gradeSa: Number(r.grade_sa ?? 0),
      eei: Number(r.eei ?? 0),
      gain50: Number(r.gain_50 ?? 0),
      ath2x: Number(r.ath_2x ?? 0),
      ath5x: Number(r.ath_5x ?? 0),
      ath10x: Number(r.ath_10x ?? 0),
      milestones: Number(r.milestones ?? 0),
      byKind: (byKindRows.rows as Array<Record<string, unknown>>).map((x) => ({
        kind: String(x.kind),
        count: Number(x.n ?? 0),
      })),
      note: "Pump-desk alerts only · Telegram wired to these kinds",
    }));
  } catch (err) {
    console.error("alerts stats error", err);
    res.status(500).json(apiFail("Internal server error", "alerts_stats"));
  }
});

router.get("/alerts", async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "40"), 10) || 40, 1), 100);
    const page = Math.max(parseInt(String(req.query.page ?? "1"), 10) || 1, 1);
    const offset = (page - 1) * limit;
    const unreadOnly = ["1", "true", "yes"].includes(String(req.query.unread ?? "").toLowerCase());
    const kind = String(req.query.kind ?? "").trim().toUpperCase();

    const whereParts: ReturnType<typeof sql>[] = [];
    if (unreadOnly) whereParts.push(sql`read_at IS NULL`);
    if (kind) whereParts.push(sql`kind = ${kind}`);
    const whereSql = whereParts.length
      ? sql`WHERE ${sql.join(whereParts, sql` AND `)}`
      : sql``;

    const countRow = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM pump_alerts ${whereSql}
    `);
    const total = Number((countRow.rows[0] as { n?: number })?.n ?? 0);

    const rows = await db.execute(sql`
      SELECT *
      FROM pump_alerts
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const unreadRow = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM pump_alerts WHERE read_at IS NULL
    `);

    res.setHeader("Cache-Control", "private, no-cache");
    res.json(apiOk({
      alerts: (rows.rows as Array<Record<string, unknown>>).map(mapAlert),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      limit,
      unread: Number((unreadRow.rows[0] as { n?: number })?.n ?? 0),
    }));
  } catch (err) {
    console.error("alerts feed error", err);
    res.status(500).json(apiFail("Internal server error", "alerts_feed"));
  }
});

router.post("/alerts/read", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { ids?: number[]; all?: boolean };
    if (body.all) {
      await db.execute(sql`
        UPDATE pump_alerts SET read_at = NOW() WHERE read_at IS NULL
      `);
    } else if (Array.isArray(body.ids) && body.ids.length) {
      const ids = body.ids.map(Number).filter(Number.isFinite).slice(0, 200);
      if (ids.length) {
        await db.execute(sql`
          UPDATE pump_alerts
          SET read_at = NOW()
          WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
            AND read_at IS NULL
        `);
      }
    } else {
      res.status(400).json(apiFail("Provide ids[] or all=true", "bad_request"));
      return;
    }
    const unreadRow = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM pump_alerts WHERE read_at IS NULL
    `);
    res.json(apiOk({
      ok: true,
      unread: Number((unreadRow.rows[0] as { n?: number })?.n ?? 0),
    }));
  } catch (err) {
    console.error("alerts read error", err);
    res.status(500).json(apiFail("Internal server error", "alerts_read"));
  }
});

export default router;
