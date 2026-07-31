/**
 * Dex Autopilot API — automated paper agent status / book / patterns / events
 * Envelope: { ok, data, meta }
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { apiFail, apiOk } from "../lib/api-envelope";
import { toIsoUtc } from "../lib/pro-cache";

const router = Router();

router.get("/trader/status", async (_req, res) => {
  try {
    const st = await db.execute(sql`
      SELECT id, enabled, bankroll_usd, realized_pnl_usd, trades_opened, trades_closed, hits_3x, updated_at
      FROM dex_agent_state ORDER BY id ASC LIMIT 1
    `);
    const row = st.rows[0] as Record<string, unknown> | undefined;
    const open = await db.execute(sql`
      SELECT COUNT(*)::int AS n,
             COALESCE(SUM(remaining_stake_usd), 0)::real AS open_stake
      FROM dex_positions WHERE status IN ('open', 'moon')
    `);
    const o = open.rows[0] as { n?: number; open_stake?: number };

    // Mark-to-market open equity
    const marks = await db.execute(sql`
      SELECT dp.remaining_stake_usd, dp.entry_mc_usd,
             NULLIF(t.market_cap_usd, '')::numeric AS live_mc
      FROM dex_positions dp
      JOIN tracked_tokens t ON t.id = dp.token_id
      WHERE dp.status IN ('open', 'moon') AND dp.remaining_stake_usd > 0
    `);
    let openMark = 0;
    for (const m of marks.rows as Array<{ remaining_stake_usd: number; entry_mc_usd: number; live_mc: string | number | null }>) {
      const entry = Number(m.entry_mc_usd) || 0;
      const live = parseFloat(String(m.live_mc ?? "0")) || entry;
      const rem = Number(m.remaining_stake_usd) || 0;
      openMark += entry > 0 ? rem * (live / entry) : rem;
    }

    const bankroll = row ? Number(row.bankroll_usd ?? 0) : 1000;
    res.json(apiOk({
      enabled: row ? Boolean(row.enabled) : true,
      bankrollUsd: bankroll,
      openMarkUsd: Math.round(openMark * 100) / 100,
      equityUsd: Math.round((bankroll + openMark) * 100) / 100,
      realizedPnlUsd: row ? Number(row.realized_pnl_usd ?? 0) : 0,
      tradesOpened: row ? Number(row.trades_opened ?? 0) : 0,
      tradesClosed: row ? Number(row.trades_closed ?? 0) : 0,
      hits3x: row ? Number(row.hits_3x ?? 0) : 0,
      openCount: Number(o?.n ?? 0),
      mode: "autopilot",
      rules: {
        takeProfit: "70% @ 3×",
        moonBag: "30% trailed",
        observationSnaps: 5,
        maxOpen: 3,
      },
      updatedAt: row ? toIsoUtc(row.updated_at) : null,
    }));
  } catch (err) {
    console.error("trader status error", err);
    res.status(500).json(apiFail("Internal server error", "trader_status"));
  }
});

router.post("/trader/enabled", async (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    await db.execute(sql`
      INSERT INTO dex_agent_state (enabled, bankroll_usd)
      SELECT ${enabled}, 1000
      WHERE NOT EXISTS (SELECT 1 FROM dex_agent_state)
    `);
    await db.execute(sql`
      UPDATE dex_agent_state SET enabled = ${enabled}, updated_at = NOW()
      WHERE id = (SELECT id FROM dex_agent_state ORDER BY id ASC LIMIT 1)
    `);
    res.json(apiOk({ enabled }));
  } catch (err) {
    console.error("trader enabled error", err);
    res.status(500).json(apiFail("Internal server error", "trader_enabled"));
  }
});

router.get("/trader/positions", async (_req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT
        dp.id, dp.token_id, dp.pro_call_id, dp.address, dp.symbol,
        dp.stake_usd, dp.remaining_stake_usd, dp.entry_mc_usd, dp.entry_at,
        dp.entry_phase, dp.entry_score, dp.entry_velocity, dp.entry_snap_count,
        dp.pattern_key, dp.peak_multiple, dp.moon_bag_taken, dp.status,
        dp.exit_mc_usd, dp.exit_at, dp.exit_reason, dp.realized_pnl_usd,
        NULLIF(t.market_cap_usd, '')::numeric AS live_mc,
        t.logo_uri, t.image_path, pc.runner_phase
      FROM dex_positions dp
      JOIN tracked_tokens t ON t.id = dp.token_id
      LEFT JOIN pro_calls pc ON pc.id = dp.pro_call_id
      ORDER BY
        CASE dp.status WHEN 'open' THEN 0 WHEN 'moon' THEN 1 ELSE 2 END,
        dp.entry_at DESC
      LIMIT 80
    `);

    const positions = (rows.rows as Array<Record<string, unknown>>).map(r => {
      const entry = Number(r.entry_mc_usd) || 0;
      const live = parseFloat(String(r.live_mc ?? r.exit_mc_usd ?? entry)) || entry;
      const mult = entry > 0 ? live / entry : 1;
      const rem = Number(r.remaining_stake_usd) || 0;
      return {
        id: Number(r.id),
        tokenId: Number(r.token_id),
        address: String(r.address),
        symbol: r.symbol != null ? String(r.symbol) : null,
        stakeUsd: Number(r.stake_usd),
        remainingStakeUsd: rem,
        entryMcUsd: entry,
        liveMcUsd: live,
        multiple: Math.round(mult * 100) / 100,
        markUsd: Math.round(rem * mult * 100) / 100,
        entryAt: toIsoUtc(r.entry_at),
        entryPhase: r.entry_phase != null ? String(r.entry_phase) : null,
        entryScore: r.entry_score != null ? Number(r.entry_score) : null,
        entryVelocity: r.entry_velocity != null ? Number(r.entry_velocity) : null,
        entrySnapCount: r.entry_snap_count != null ? Number(r.entry_snap_count) : null,
        patternKey: r.pattern_key != null ? String(r.pattern_key) : null,
        peakMultiple: Number(r.peak_multiple ?? 1),
        moonBagTaken: Boolean(r.moon_bag_taken),
        status: String(r.status),
        exitReason: r.exit_reason != null ? String(r.exit_reason) : null,
        exitAt: toIsoUtc(r.exit_at),
        realizedPnlUsd: Number(r.realized_pnl_usd ?? 0),
        runnerPhase: r.runner_phase != null ? String(r.runner_phase) : null,
      };
    });

    res.json(apiOk({ positions }));
  } catch (err) {
    console.error("trader positions error", err);
    res.status(500).json(apiFail("Internal server error", "trader_positions"));
  }
});

router.get("/trader/events", async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit ?? "40"), 10) || 40));
    const rows = await db.execute(sql`
      SELECT id, created_at, kind, level, msg, token_id, symbol, meta
      FROM dex_agent_events
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    const events = (rows.rows as Array<Record<string, unknown>>).map(r => ({
      id: Number(r.id),
      at: toIsoUtc(r.created_at),
      kind: String(r.kind),
      level: String(r.level),
      msg: String(r.msg),
      tokenId: r.token_id != null ? Number(r.token_id) : null,
      symbol: r.symbol != null ? String(r.symbol) : null,
      meta: r.meta ? (() => { try { return JSON.parse(String(r.meta)); } catch { return null; } })() : null,
    }));
    res.json(apiOk({ events }));
  } catch (err) {
    console.error("trader events error", err);
    res.status(500).json(apiFail("Internal server error", "trader_events"));
  }
});

router.get("/trader/patterns", async (_req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT pattern_key, samples, wins_3x, losses, sum_exit_multiple, best_multiple, last_seen_at, notes
      FROM dex_patterns
      WHERE samples >= 1
      ORDER BY wins_3x DESC, samples DESC
      LIMIT 40
    `);
    const patterns = (rows.rows as Array<Record<string, unknown>>).map(r => {
      const samples = Number(r.samples) || 0;
      const wins = Number(r.wins_3x) || 0;
      const sum = Number(r.sum_exit_multiple) || 0;
      return {
        key: String(r.pattern_key),
        samples,
        wins3x: wins,
        losses: Number(r.losses) || 0,
        winRate: samples > 0 ? Math.round((wins / samples) * 1000) / 10 : 0,
        avgExit: samples > 0 ? Math.round((sum / samples) * 100) / 100 : 0,
        bestMultiple: Number(r.best_multiple ?? 1),
        lastSeenAt: toIsoUtc(r.last_seen_at),
      };
    });
    res.json(apiOk({ patterns }));
  } catch (err) {
    console.error("trader patterns error", err);
    res.status(500).json(apiFail("Internal server error", "trader_patterns"));
  }
});

export default router;
