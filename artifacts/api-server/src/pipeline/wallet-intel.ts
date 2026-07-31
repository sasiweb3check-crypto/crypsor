/**
 * Crypsor Wallet Intel — background holder judgment + win-rate memory.
 *
 * Source: token_holder_snapshots.holders_data (full holder list for a token).
 * NOT mixed with GMGN KOL / smart tags on token_holders / wallet_profiles.
 *
 * Flow:
 *   holders:updated → queue token → score holders → upsert crypsor_wallet_intel
 *   pro_calls hit_2x → credit wins for early observed quality holders
 *   dead / low ATH calls → credit losses
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus } from "./event-bus";
import { healthMonitor } from "./health-monitor";
import {
  judgeHolder,
  isQualityLabel,
  type RawHolderRow,
  type CrypsorJudgment,
} from "../lib/crypsor-wallet-score";

const log = logger.child({ module: "wallet-intel" });

const TICK_MS = 45_000;
const STARTUP_DELAY_MS = 40_000;
const MAX_HOLDERS_PER_TOKEN = 60;
const QUEUE_CAP = 80;

const pending = new Set<number>();
let running = false;

export function enqueueWalletIntel(tokenId: number): void {
  if (!Number.isFinite(tokenId) || tokenId <= 0) return;
  if (pending.size >= QUEUE_CAP && !pending.has(tokenId)) {
    // Drop oldest-ish by clearing a batch — prefer keeping new ids
    const drop = [...pending].slice(0, 10);
    for (const id of drop) pending.delete(id);
  }
  pending.add(tokenId);
}

async function upsertObserved(tokenId: number, snapshotId: number | null, j: CrypsorJudgment): Promise<void> {
  const priorEvent = await db.execute(sql`
    SELECT updated_at FROM crypsor_wallet_token_events
    WHERE wallet_address = ${j.address} AND token_id = ${tokenId} AND role = 'observed'
    LIMIT 1
  `);
  const firstOnToken = priorEvent.rows.length === 0;

  await db.execute(sql`
    INSERT INTO crypsor_wallet_token_events (
      wallet_address, token_id, role, our_label_at, behaviour_score_at,
      hold_pct, buy_count, sell_count, realized_pnl, snapshot_id, created_at, updated_at
    ) VALUES (
      ${j.address}, ${tokenId}, 'observed', ${j.ourLabel}, ${j.behaviourScore},
      ${j.holdPct}, ${j.buyCount}, ${j.sellCount}, ${j.realizedPnl}, ${snapshotId},
      NOW(), NOW()
    )
    ON CONFLICT (wallet_address, token_id, role) DO UPDATE SET
      our_label_at = EXCLUDED.our_label_at,
      behaviour_score_at = EXCLUDED.behaviour_score_at,
      hold_pct = EXCLUDED.hold_pct,
      buy_count = EXCLUDED.buy_count,
      sell_count = EXCLUDED.sell_count,
      realized_pnl = EXCLUDED.realized_pnl,
      snapshot_id = COALESCE(EXCLUDED.snapshot_id, crypsor_wallet_token_events.snapshot_id),
      updated_at = NOW()
  `);

  // Throttle weight bumps on re-snaps of the same token (still refresh label/score)
  const weightAdd = firstOnToken ? j.weightDelta : 0;

  await db.execute(sql`
    INSERT INTO crypsor_wallet_intel (
      wallet_address, our_label, behaviour_score, weightage, win_rate,
      wins, losses, tokens_seen, sightings, avg_hold_pct, last_token_id,
      last_reason, first_seen_at, last_seen_at, updated_at
    ) VALUES (
      ${j.address}, ${j.ourLabel}, ${j.behaviourScore},
      ${Math.max(0, weightAdd)}, NULL,
      0, 0, 1, 1, ${j.holdPct}, ${tokenId},
      ${j.reason}, NOW(), NOW(), NOW()
    )
    ON CONFLICT (wallet_address) DO UPDATE SET
      our_label = EXCLUDED.our_label,
      behaviour_score = EXCLUDED.behaviour_score,
      weightage = GREATEST(0, crypsor_wallet_intel.weightage + ${weightAdd}),
      sightings = crypsor_wallet_intel.sightings + 1,
      tokens_seen = (
        SELECT COUNT(DISTINCT token_id)::int
        FROM crypsor_wallet_token_events
        WHERE wallet_address = ${j.address} AND role = 'observed'
      ),
      avg_hold_pct = CASE
        WHEN crypsor_wallet_intel.avg_hold_pct IS NULL THEN ${j.holdPct}
        ELSE (crypsor_wallet_intel.avg_hold_pct * 0.7 + ${j.holdPct} * 0.3)
      END,
      last_token_id = ${tokenId},
      last_reason = ${j.reason},
      last_seen_at = NOW(),
      updated_at = NOW()
  `);
}

export async function processTokenHolders(tokenId: number): Promise<number> {
  const snap = await db.execute(sql`
    SELECT ths.id, ths.holders_data
    FROM tracked_tokens t
    JOIN token_holder_snapshots ths ON ths.id = t.latest_holder_snapshot_id
    WHERE t.id = ${tokenId}
    LIMIT 1
  `);
  const row = snap.rows[0] as { id?: number; holders_data?: unknown } | undefined;
  if (!row) return 0;

  const list = Array.isArray(row.holders_data) ? (row.holders_data as RawHolderRow[]) : [];
  if (list.length === 0) return 0;

  const judged: CrypsorJudgment[] = [];
  for (const h of list) {
    const j = judgeHolder(h);
    if (j) judged.push(j);
  }

  // Prefer larger bags first — more signal, slower background ok
  judged.sort((a, b) => b.holdPct - a.holdPct);
  const slice = judged.slice(0, MAX_HOLDERS_PER_TOKEN);
  const snapshotId = row.id != null ? Number(row.id) : null;

  for (const j of slice) {
    try {
      await upsertObserved(tokenId, snapshotId, j);
    } catch (err) {
      log.debug({ err, address: j.address, tokenId }, "wallet-intel upsert failed");
    }
  }

  return slice.length;
}

async function creditOutcome(
  tokenId: number,
  role: "win" | "loss",
): Promise<number> {
  // Early quality holders observed on this token, not yet settled for this role
  const holders = await db.execute(sql`
    SELECT e.wallet_address, e.our_label_at, e.behaviour_score_at
    FROM crypsor_wallet_token_events e
    WHERE e.token_id = ${tokenId}
      AND e.role = 'observed'
      AND e.our_label_at IN ('diamond', 'accumulator', 'solid')
      AND NOT EXISTS (
        SELECT 1 FROM crypsor_wallet_token_events x
        WHERE x.wallet_address = e.wallet_address
          AND x.token_id = ${tokenId}
          AND x.role = ${role}
      )
    LIMIT 80
  `);

  let n = 0;
  for (const r of holders.rows as Array<{
    wallet_address: string;
    our_label_at: string | null;
    behaviour_score_at: number | null;
  }>) {
    const addr = String(r.wallet_address);
    if (!isQualityLabel(r.our_label_at)) continue;

    try {
      await db.execute(sql`
        INSERT INTO crypsor_wallet_token_events (
          wallet_address, token_id, role, our_label_at, behaviour_score_at, created_at, updated_at
        ) VALUES (
          ${addr}, ${tokenId}, ${role}, ${r.our_label_at}, ${r.behaviour_score_at}, NOW(), NOW()
        )
        ON CONFLICT (wallet_address, token_id, role) DO NOTHING
      `);

      const weightBump = role === "win" ? 4 : -2;
      if (role === "win") {
        await db.execute(sql`
          UPDATE crypsor_wallet_intel SET
            wins = wins + 1,
            win_rate = (wins + 1)::real / NULLIF((wins + 1 + losses), 0),
            weightage = GREATEST(0, weightage + ${weightBump}),
            updated_at = NOW()
          WHERE wallet_address = ${addr}
        `);
      } else {
        await db.execute(sql`
          UPDATE crypsor_wallet_intel SET
            losses = losses + 1,
            win_rate = wins::real / NULLIF((wins + losses + 1), 0),
            weightage = GREATEST(0, weightage + ${weightBump}),
            updated_at = NOW()
          WHERE wallet_address = ${addr}
        `);
      }
      n++;
    } catch (err) {
      log.debug({ err, addr, tokenId, role }, "outcome credit failed");
    }
  }
  return n;
}

async function settleOutcomes(): Promise<void> {
  // Wins: hit_2x and we haven't marked token fully (use absence of win events as signal — process each call)
  const wins = await db.execute(sql`
    SELECT pc.token_id
    FROM pro_calls pc
    WHERE pc.hit_2x IS TRUE
      AND pc.called_at >= NOW() - INTERVAL '14 days'
      AND EXISTS (
        SELECT 1 FROM crypsor_wallet_token_events e
        WHERE e.token_id = pc.token_id AND e.role = 'observed'
      )
      AND EXISTS (
        SELECT 1 FROM crypsor_wallet_token_events e
        WHERE e.token_id = pc.token_id AND e.role = 'observed'
          AND e.our_label_at IN ('diamond', 'accumulator', 'solid')
          AND NOT EXISTS (
            SELECT 1 FROM crypsor_wallet_token_events x
            WHERE x.wallet_address = e.wallet_address
              AND x.token_id = pc.token_id AND x.role = 'win'
          )
      )
    ORDER BY pc.hit_2x_at DESC NULLS LAST
    LIMIT 12
  `);

  for (const r of wins.rows as Array<{ token_id: number }>) {
    const credited = await creditOutcome(Number(r.token_id), "win");
    if (credited > 0) log.info({ tokenId: r.token_id, credited }, "Crypsor wallet wins credited");
  }

  // Losses: aged calls that never hit 2× — never credit loss if win already exists
  const losses = await db.execute(sql`
    SELECT pc.token_id
    FROM pro_calls pc
    WHERE COALESCE(pc.hit_2x, false) IS FALSE
      AND COALESCE(pc.ath_multiple, 1) < 2
      AND pc.called_at <= NOW() - INTERVAL '6 hours'
      AND pc.called_at >= NOW() - INTERVAL '14 days'
      AND EXISTS (
        SELECT 1 FROM crypsor_wallet_token_events e
        WHERE e.token_id = pc.token_id AND e.role = 'observed'
          AND e.our_label_at IN ('diamond', 'accumulator', 'solid')
          AND NOT EXISTS (
            SELECT 1 FROM crypsor_wallet_token_events x
            WHERE x.wallet_address = e.wallet_address
              AND x.token_id = pc.token_id AND x.role IN ('loss', 'win')
          )
      )
    ORDER BY pc.called_at ASC
    LIMIT 12
  `);

  for (const r of losses.rows as Array<{ token_id: number }>) {
    const credited = await creditOutcome(Number(r.token_id), "loss");
    if (credited > 0) log.info({ tokenId: r.token_id, credited }, "Crypsor wallet losses credited");
  }
}

async function seedRecentTokens(): Promise<void> {
  // Catch tokens that already have holder snapshots but weren't judged yet
  const rows = await db.execute(sql`
    SELECT t.id
    FROM tracked_tokens t
    JOIN pro_calls pc ON pc.token_id = t.id
    WHERE t.latest_holder_snapshot_id IS NOT NULL
      AND pc.called_at >= NOW() - INTERVAL '72 hours'
      AND (
        NOT EXISTS (
          SELECT 1 FROM crypsor_wallet_token_events e
          WHERE e.token_id = t.id AND e.role = 'observed'
        )
        OR t.last_holders_updated_at > NOW() - INTERVAL '2 hours'
      )
    ORDER BY
      (NOT EXISTS (
        SELECT 1 FROM crypsor_wallet_token_events e
        WHERE e.token_id = t.id AND e.role = 'observed'
      )) DESC,
      pc.called_at DESC
    LIMIT 25
  `);
  for (const r of rows.rows as Array<{ id: number }>) {
    enqueueWalletIntel(Number(r.id));
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  const t0 = Date.now();
  try {
    if (pending.size === 0) await seedRecentTokens();

    const batch = [...pending].slice(0, 6);
    for (const id of batch) pending.delete(id);

    let judged = 0;
    for (const tokenId of batch) {
      judged += await processTokenHolders(tokenId);
    }

    await settleOutcomes();
    healthMonitor.ok("wallet-intel", Date.now() - t0);
    if (batch.length > 0 || judged > 0) {
      log.info({ batch: batch.length, judged, queue: pending.size }, "wallet-intel tick");
    }
  } catch (err) {
    healthMonitor.error("wallet-intel", err);
    log.warn({ err }, "wallet-intel tick failed");
  } finally {
    running = false;
  }
}

export function startWalletIntel(): void {
  eventBus.on("holders:updated", (e) => {
    enqueueWalletIntel(e.tokenId);
  });

  const loop = () => {
    tick()
      .catch(() => {})
      .finally(() => setTimeout(loop, TICK_MS));
  };
  setTimeout(loop, STARTUP_DELAY_MS);
  log.info("Crypsor wallet intel started (background holder labeling + win-rate)");
}
