/**
 * Crypsor wallet intel report — search a wallet, enrich via GMGN profile,
 * return our labels / win-rate / observed token events.
 *
 * GET  /api/wallet-intel/:address?chain=sol&refresh=1
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { apiFail, apiOk } from "../lib/api-envelope";
import { enrichAndPersistWalletProfile } from "../lib/wallet-profile-enrich";
import { toIsoUtc } from "../lib/pro-cache";
import { judgeHolder, type RawHolderRow } from "../lib/crypsor-wallet-score";

const router = Router();

const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function normalizeAddress(raw: string): string | null {
  const a = raw.trim();
  if (!SOL_ADDR_RE.test(a)) return null;
  return a;
}

router.get("/wallet-intel/:address", async (req, res) => {
  try {
    const address = normalizeAddress(String(req.params.address ?? ""));
    if (!address) {
      res.status(400).json(apiFail("Invalid Solana wallet address", "bad_address"));
      return;
    }
    const chain = String(req.query.chain ?? "sol");
    const refresh = String(req.query.refresh ?? "") === "1"
      || String(req.query.refresh ?? "").toLowerCase() === "true";

    let enrich: Awaited<ReturnType<typeof enrichAndPersistWalletProfile>> | null = null;
    if (refresh) {
      try {
        enrich = await enrichAndPersistWalletProfile(chain, address, { fetchHoldings: true });
      } catch (err) {
        console.warn("wallet-intel enrich failed", err);
      }
    }

    // DB profile (after enrich if refresh)
    const profileRows = await db.execute(sql`
      SELECT wallet_address, labels, twitter_name, twitter_username,
             total_pnl_usd, realized_pnl_usd, unrealized_pnl_usd,
             win_rate, avg_hold_time_sec, total_trade_count, sol_balance,
             profile_fetched_at, first_seen_at, last_seen_at
      FROM wallet_profiles
      WHERE wallet_address = ${address}
      LIMIT 1
    `);
    const pr = (profileRows.rows[0] ?? null) as Record<string, unknown> | null;

    // Crypsor intel aggregate
    const intelRows = await db.execute(sql`
      SELECT *
      FROM crypsor_wallet_intel
      WHERE wallet_address = ${address}
      LIMIT 1
    `);
    const ir = (intelRows.rows[0] ?? null) as Record<string, unknown> | null;

    // Observed / win / loss events with token context
    const eventRows = await db.execute(sql`
      SELECT
        e.role, e.our_label_at, e.behaviour_score_at, e.hold_pct,
        e.buy_count, e.sell_count, e.realized_pnl,
        e.created_at, e.updated_at, e.token_id,
        t.symbol, t.name, t.address AS token_address,
        pc.called_at, pc.ath_multiple, pc.hit_2x, pc.quality_label,
        pc.call_alert_sent_at, pc.runner_alert_sent_at
      FROM crypsor_wallet_token_events e
      JOIN tracked_tokens t ON t.id = e.token_id
      LEFT JOIN pro_calls pc ON pc.token_id = e.token_id
      WHERE e.wallet_address = ${address}
      ORDER BY
        CASE e.role WHEN 'win' THEN 0 WHEN 'loss' THEN 1 ELSE 2 END,
        e.updated_at DESC NULLS LAST
      LIMIT 80
    `);

    const events = (eventRows.rows as Array<Record<string, unknown>>).map(r => ({
      role: String(r.role),
      ourLabelAt: r.our_label_at != null ? String(r.our_label_at) : null,
      behaviourScoreAt: r.behaviour_score_at != null ? Number(r.behaviour_score_at) : null,
      holdPct: r.hold_pct != null ? Number(r.hold_pct) : null,
      buyCount: r.buy_count != null ? Number(r.buy_count) : null,
      sellCount: r.sell_count != null ? Number(r.sell_count) : null,
      realizedPnl: r.realized_pnl != null ? Number(r.realized_pnl) : null,
      tokenId: Number(r.token_id),
      symbol: r.symbol != null ? String(r.symbol) : null,
      name: r.name != null ? String(r.name) : null,
      tokenAddress: r.token_address != null ? String(r.token_address) : null,
      calledAt: toIsoUtc(r.called_at),
      athMultiple: r.ath_multiple != null ? Number(r.ath_multiple) : null,
      hit2x: r.hit_2x != null ? Boolean(r.hit_2x) : null,
      qualityLabel: r.quality_label != null ? String(r.quality_label) : null,
      entryServed: Boolean(r.call_alert_sent_at || r.runner_alert_sent_at),
      updatedAt: toIsoUtc(r.updated_at ?? r.created_at),
    }));

    // Tracked-wallet buys (sensor list) if this address is in walletdatasource
    const buyRows = await db.execute(sql`
      SELECT
        t.id AS token_id, t.symbol, t.address AS token_address,
        tb.bought_at, tb.amount, tb.price_usd,
        pc.ath_multiple, pc.hit_2x
      FROM walletdatasource w
      JOIN token_buys tb ON tb.wallet_id = w.id
      JOIN tracked_tokens t ON t.id = tb.token_id
      LEFT JOIN pro_calls pc ON pc.token_id = t.id
      WHERE w.address = ${address}
      ORDER BY tb.bought_at DESC NULLS LAST
      LIMIT 40
    `);
    const trackedBuys = (buyRows.rows as Array<Record<string, unknown>>).map(r => ({
      tokenId: Number(r.token_id),
      symbol: r.symbol != null ? String(r.symbol) : null,
      tokenAddress: r.token_address != null ? String(r.token_address) : null,
      boughtAt: toIsoUtc(r.bought_at),
      amount: r.amount != null ? String(r.amount) : null,
      priceUsd: r.price_usd != null ? String(r.price_usd) : null,
      athMultiple: r.ath_multiple != null ? Number(r.ath_multiple) : null,
      hit2x: r.hit_2x != null ? Boolean(r.hit_2x) : null,
    }));

    // If no crypsor events yet, try to judge from latest holder snapshots (live preview)
    let liveJudgment: ReturnType<typeof judgeHolder> | null = null;
    let liveTokenHint: { tokenId: number; symbol: string | null } | null = null;
    if (!ir || events.length === 0) {
      try {
        const snap = await db.execute(sql`
          SELECT t.id AS token_id, t.symbol, ths.holders_data
          FROM token_holder_snapshots ths
          JOIN tracked_tokens t ON t.latest_holder_snapshot_id = ths.id
          WHERE ths.holders_data::text ILIKE ${"%" + address + "%"}
          ORDER BY ths.snapshot_at DESC NULLS LAST
          LIMIT 1
        `);
        const srow = snap.rows[0] as { token_id?: number; symbol?: string; holders_data?: unknown } | undefined;
        if (srow && Array.isArray(srow.holders_data)) {
          const hit = (srow.holders_data as RawHolderRow[]).find(h => {
            const a = String(h.address ?? h.account_address ?? "");
            return a === address;
          });
          if (hit) {
            liveJudgment = judgeHolder(hit);
            liveTokenHint = {
              tokenId: Number(srow.token_id),
              symbol: srow.symbol != null ? String(srow.symbol) : null,
            };
            // Kick background so it gets stored
            const { enqueueWalletIntel } = await import("../pipeline/wallet-intel");
            enqueueWalletIntel(Number(srow.token_id));
          }
        }
      } catch {
        /* non-fatal — JSONB scan may be slow/unavailable */
      }
    }

    const observed = events.filter(e => e.role === "observed");
    const wins = events.filter(e => e.role === "win");
    const losses = events.filter(e => e.role === "loss");

    res.setHeader("Cache-Control", "private, max-age=4");
    res.json(apiOk({
      walletAddress: address,
      chain,
      refreshed: refresh,
      enrichOk: enrich?.ok ?? null,
      gmgn: pr ? {
        labels: Array.isArray(pr.labels) ? pr.labels.map(String) : [],
        twitterName: pr.twitter_name != null ? String(pr.twitter_name) : null,
        twitterUsername: pr.twitter_username != null ? String(pr.twitter_username) : null,
        totalPnlUsd: pr.total_pnl_usd != null ? Number(pr.total_pnl_usd) : null,
        realizedPnlUsd: pr.realized_pnl_usd != null ? Number(pr.realized_pnl_usd) : null,
        unrealizedPnlUsd: pr.unrealized_pnl_usd != null ? Number(pr.unrealized_pnl_usd) : null,
        winRate: pr.win_rate != null ? Number(pr.win_rate) : null,
        avgHoldTimeSec: pr.avg_hold_time_sec != null ? Number(pr.avg_hold_time_sec) : null,
        totalTradeCount: pr.total_trade_count != null ? Number(pr.total_trade_count) : null,
        solBalance: pr.sol_balance != null ? Number(pr.sol_balance) : null,
        profileFetchedAt: toIsoUtc(pr.profile_fetched_at),
        firstSeenAt: toIsoUtc(pr.first_seen_at),
        lastSeenAt: toIsoUtc(pr.last_seen_at),
      } : (enrich?.ok ? {
        labels: enrich.labels,
        twitterName: enrich.twitterName,
        twitterUsername: enrich.twitterUsername,
        totalPnlUsd: enrich.totalPnlUsd,
        realizedPnlUsd: enrich.realizedPnlUsd,
        unrealizedPnlUsd: enrich.unrealizedPnlUsd,
        winRate: enrich.winRate,
        avgHoldTimeSec: enrich.avgHoldTimeSec,
        totalTradeCount: enrich.totalTradeCount,
        solBalance: enrich.solBalance,
        profileFetchedAt: enrich.profileFetchedAt,
        firstSeenAt: null,
        lastSeenAt: null,
      } : null),
      crypsor: ir ? {
        ourLabel: String(ir.our_label ?? "noise"),
        behaviourScore: Number(ir.behaviour_score ?? 0),
        weightage: Number(ir.weightage ?? 0),
        winRate: ir.win_rate != null ? Number(ir.win_rate) : null,
        wins: Number(ir.wins ?? 0),
        losses: Number(ir.losses ?? 0),
        tokensSeen: Number(ir.tokens_seen ?? 0),
        sightings: Number(ir.sightings ?? 0),
        avgHoldPct: ir.avg_hold_pct != null ? Number(ir.avg_hold_pct) : null,
        lastReason: ir.last_reason != null ? String(ir.last_reason) : null,
        lastTokenId: ir.last_token_id != null ? Number(ir.last_token_id) : null,
        firstSeenAt: toIsoUtc(ir.first_seen_at),
        lastSeenAt: toIsoUtc(ir.last_seen_at),
      } : null,
      liveJudgment: liveJudgment ? {
        ourLabel: liveJudgment.ourLabel,
        behaviourScore: liveJudgment.behaviourScore,
        holdPct: liveJudgment.holdPct,
        buyCount: liveJudgment.buyCount,
        sellCount: liveJudgment.sellCount,
        reason: liveJudgment.reason,
        weightDelta: liveJudgment.weightDelta,
        tokenId: liveTokenHint?.tokenId ?? null,
        symbol: liveTokenHint?.symbol ?? null,
        note: "Preview from latest holder snapshot — background job will persist",
      } : null,
      summary: {
        observedTokens: observed.length,
        winEvents: wins.length,
        lossEvents: losses.length,
        trackedBuys: trackedBuys.length,
      },
      events,
      trackedBuys,
      note: "Crypsor labels/win-rate are ours (holder behaviour). GMGN win-rate is separate enricher data.",
      fetchedAt: new Date().toISOString(),
    }));
  } catch (err) {
    console.error("wallet-intel report error", err);
    res.status(500).json(apiFail("Internal server error", "wallet_intel"));
  }
});

export default router;
