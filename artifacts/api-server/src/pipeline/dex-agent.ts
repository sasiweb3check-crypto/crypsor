/**
 * Dex Autopilot — automated paper trader.
 *
 * Rules only. No emotions.
 * Data: runner phase / snaps / velocity / tagged / mint / live MC (on-chain mark).
 * Goal: enter after observation, bank 70% at 3×, trail 30% moon bag.
 * Memory: pattern fingerprints updated on every close.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { opsLog } from "../lib/ops-log";
import {
  computeRunnerScore,
  MIN_ENTRY_OBSERVATION_SNAPS,
  type RunnerPhase,
} from "../lib/runner-score";
import { patternEdge, patternKey } from "../lib/dex-patterns";

const log = logger.child({ module: "dex-agent" });

const TICK_MS = 20_000;
const STARTUP_DELAY_MS = 35_000;

const CFG = {
  startBankroll: 1_000,
  maxOpen: 3,
  stakePct: 0.12,
  minStake: 20,
  maxStake: 120,
  takeProfitMult: 3,
  moonKeepFrac: 0.3,
  trailDrawdown: 0.32,
  hardStopMult: 0.65,
  entryMinScore: 60,
  entryMinVel: 1.2,
};

type AgentState = {
  id: number;
  enabled: boolean;
  bankrollUsd: number;
  realizedPnlUsd: number;
  tradesOpened: number;
  tradesClosed: number;
  hits3x: number;
};

type OpenPos = {
  id: number;
  tokenId: number;
  proCallId: number | null;
  address: string;
  symbol: string | null;
  stakeUsd: number;
  remainingStakeUsd: number;
  entryMcUsd: number;
  peakMultiple: number;
  moonBagTaken: boolean;
  status: string;
  patternKey: string | null;
  realizedPnlUsd: number;
};

async function ensureState(): Promise<AgentState> {
  const existing = await db.execute(sql`
    SELECT id, enabled, bankroll_usd AS "bankrollUsd", realized_pnl_usd AS "realizedPnlUsd",
           trades_opened AS "tradesOpened", trades_closed AS "tradesClosed", hits_3x AS "hits3x"
    FROM dex_agent_state ORDER BY id ASC LIMIT 1
  `);
  if (existing.rows[0]) return existing.rows[0] as AgentState;
  await db.execute(sql`
    INSERT INTO dex_agent_state (enabled, bankroll_usd)
    VALUES (true, ${CFG.startBankroll})
  `);
  const again = await db.execute(sql`
    SELECT id, enabled, bankroll_usd AS "bankrollUsd", realized_pnl_usd AS "realizedPnlUsd",
           trades_opened AS "tradesOpened", trades_closed AS "tradesClosed", hits_3x AS "hits3x"
    FROM dex_agent_state ORDER BY id ASC LIMIT 1
  `);
  return again.rows[0] as AgentState;
}

async function logEvent(
  kind: string,
  level: "info" | "warn" | "error",
  msg: string,
  opts?: { tokenId?: number; symbol?: string | null; meta?: Record<string, unknown> },
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO dex_agent_events (kind, level, msg, token_id, symbol, meta)
      VALUES (
        ${kind}, ${level}, ${msg.slice(0, 400)},
        ${opts?.tokenId ?? null}, ${opts?.symbol ?? null},
        ${opts?.meta ? JSON.stringify(opts.meta) : null}
      )
    `);
  } catch (err) {
    log.warn({ err }, "dex event insert failed");
  }
  opsLog("dex", level, msg.slice(0, 280), opts?.meta);
}

async function getPattern(key: string) {
  const r = await db.execute(sql`
    SELECT samples, wins_3x AS "wins3x", losses,
           sum_exit_multiple AS "sumExitMultiple", best_multiple AS "bestMultiple"
    FROM dex_patterns WHERE pattern_key = ${key} LIMIT 1
  `);
  return (r.rows[0] as {
    samples: number; wins3x: number; losses: number;
    sumExitMultiple: number; bestMultiple: number;
  } | undefined) ?? null;
}

async function learnPattern(key: string, exitMultiple: number, hit3x: boolean): Promise<void> {
  await db.execute(sql`
    INSERT INTO dex_patterns (pattern_key, samples, wins_3x, losses, sum_exit_multiple, best_multiple, last_seen_at)
    VALUES (
      ${key}, 1,
      ${hit3x ? 1 : 0},
      ${hit3x ? 0 : 1},
      ${exitMultiple},
      ${exitMultiple},
      NOW()
    )
    ON CONFLICT (pattern_key) DO UPDATE SET
      samples = dex_patterns.samples + 1,
      wins_3x = dex_patterns.wins_3x + ${hit3x ? 1 : 0},
      losses = dex_patterns.losses + ${hit3x ? 0 : 1},
      sum_exit_multiple = dex_patterns.sum_exit_multiple + ${exitMultiple},
      best_multiple = GREATEST(COALESCE(dex_patterns.best_multiple, 1), ${exitMultiple}),
      last_seen_at = NOW()
  `);
}

async function loadOpenPositions(): Promise<OpenPos[]> {
  const r = await db.execute(sql`
    SELECT id, token_id AS "tokenId", pro_call_id AS "proCallId", address, symbol,
           stake_usd AS "stakeUsd", remaining_stake_usd AS "remainingStakeUsd",
           entry_mc_usd AS "entryMcUsd", COALESCE(peak_multiple, 1) AS "peakMultiple",
           moon_bag_taken AS "moonBagTaken", status, pattern_key AS "patternKey",
           COALESCE(realized_pnl_usd, 0) AS "realizedPnlUsd"
    FROM dex_positions
    WHERE status IN ('open', 'moon') AND remaining_stake_usd > 0
    ORDER BY entry_at ASC
  `);
  return r.rows as OpenPos[];
}

function sizeStake(bankroll: number, boost: number): number {
  const pct = Math.max(0.05, Math.min(0.2, CFG.stakePct * (1 + boost)));
  return Math.max(CFG.minStake, Math.min(CFG.maxStake, Math.round(bankroll * pct)));
}

async function tick(): Promise<void> {
  const state = await ensureState();
  if (!state.enabled) return;

  const open = await loadOpenPositions();

  // Live marks for open positions
  if (open.length > 0) {
    for (const pos of open) {
      const live = await db.execute(sql`
        SELECT
          NULLIF(t.market_cap_usd, '')::numeric AS mc,
          pc.runner_phase AS phase,
          COALESCE(pc.ath_multiple, 1) AS ath
        FROM tracked_tokens t
        LEFT JOIN pro_calls pc ON pc.token_id = t.id
        WHERE t.id = ${pos.tokenId}
        ORDER BY pc.called_at DESC NULLS LAST
        LIMIT 1
      `);
      const row = live.rows[0] as { mc?: string | number; phase?: string; ath?: number } | undefined;
      const mc = parseFloat(String(row?.mc ?? "0")) || 0;
      if (mc <= 0 || pos.entryMcUsd <= 0) continue;
      const mult = mc / pos.entryMcUsd;
      const peak = Math.max(pos.peakMultiple || 1, mult);
      if (peak > (pos.peakMultiple || 1)) {
        await db.execute(sql`
          UPDATE dex_positions SET peak_multiple = ${peak} WHERE id = ${pos.id}
        `);
        pos.peakMultiple = peak;
      }

      const phase = String(row?.phase ?? "");

      // Hard stop
      if (mult <= CFG.hardStopMult || phase === "dead") {
        await closeRemaining(pos, mc, mult, phase === "dead" ? "dead_stop" : "hard_stop", state);
        continue;
      }

      // Take profit 70% at 3× — leave moon bag
      if (!pos.moonBagTaken && mult >= CFG.takeProfitMult) {
        await takeProfitMoon(pos, mc, mult, state);
        continue;
      }

      // Moon bag trail / fade exit
      if (pos.moonBagTaken || pos.status === "moon") {
        const trailFloor = (pos.peakMultiple || mult) * (1 - CFG.trailDrawdown);
        if (mult < trailFloor || phase === "fading" || phase === "dead") {
          await closeRemaining(
            pos,
            mc,
            mult,
            phase === "fading" || phase === "dead" ? `phase_${phase}` : "moon_trail",
            state,
          );
        }
      }
    }
  }

  // Refresh open count after exits
  const openNow = await loadOpenPositions();
  if (openNow.length >= CFG.maxOpen) return;

  const freshState = await ensureState();
  if (!freshState.enabled || freshState.bankrollUsd < CFG.minStake) return;

  // Candidate scan — same desk universe, score with hysteresis
  const cands = await db.execute(sql`
    SELECT
      pc.id AS "proCallId",
      pc.token_id AS "tokenId",
      t.address, t.symbol,
      pc.called_at AS "calledAt",
      pc.called_mc_usd AS "calledMcUsd",
      pc.called_intel_score AS "calledIntel",
      COALESCE(pc.called_smart_count, 0) AS "calledSmart",
      COALESCE(pc.called_kol_count, 0) AS "calledKol",
      pc.ath_multiple AS "athMultiple",
      pc.runner_score AS "runnerScore",
      pc.runner_phase AS "runnerPhase",
      pc.last_snap_mc_usd AS "lastSnapMcUsd",
      GREATEST(
        COALESCE(pc.observation_snap_count, 0),
        (SELECT COUNT(*)::int FROM pro_snapshots ps WHERE ps.pro_call_id = pc.id)
      ) AS "snapCount",
      t.market_cap_usd AS "currentMc",
      COALESCE(t.holder_kol_count, 0) AS "liveKol",
      COALESCE(t.holder_smart_count, 0) AS "liveSmart",
      t.holder_velocity_score AS "liveHv",
      t.volume_intensity_score AS "volumeIntensity",
      t.sec_mint_renounced AS "secMint",
      t.sec_freeze_renounced AS "secFreeze",
      t.sec_is_honeypot AS "secHoneypot"
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    WHERE pc.surfaced_at IS NOT NULL
      AND pc.quality_label IN ('very_good', 'good')
      AND COALESCE(t.status, '') <> 'ignored'
      AND pc.called_at >= NOW() - INTERVAL '3 hours'
      AND NOT EXISTS (
        SELECT 1 FROM dex_positions dp
        WHERE dp.token_id = pc.token_id AND dp.status IN ('open', 'moon')
      )
    ORDER BY pc.called_at DESC
    LIMIT 80
  `);

  const openIds = new Set(openNow.map(p => p.tokenId));
  let slots = CFG.maxOpen - openNow.length;

  for (const raw of cands.rows as Array<Record<string, unknown>>) {
    if (slots <= 0) break;
    const tokenId = Number(raw.tokenId);
    if (openIds.has(tokenId)) continue;

    const calledMc = parseFloat(String(raw.calledMcUsd ?? "0")) || 0;
    const currentMc = parseFloat(String(raw.currentMc ?? "0")) || 0;
    if (calledMc <= 0 || currentMc <= 0) continue;

    const velocity = currentMc / calledMc;
    const gainPct = ((currentMc - calledMc) / calledMc) * 100;
    const calledAt = new Date(String(raw.calledAt)).getTime();
    const ageMinutes = Number.isFinite(calledAt) ? (Date.now() - calledAt) / 60_000 : 9999;
    const lastSnapMc = parseFloat(String(raw.lastSnapMcUsd ?? "")) || calledMc;
    const snapDeltaPct = lastSnapMc > 0 ? (currentMc - lastSnapMc) / lastSnapMc : null;
    const snapCount = Math.max(0, Number(raw.snapCount ?? 0) || 0);
    const prevPhase = (raw.runnerPhase as RunnerPhase | null) ?? "radar";
    const prevScore = raw.runnerScore != null ? Number(raw.runnerScore) : null;

    const runner = computeRunnerScore({
      calledIntelScore: raw.calledIntel != null ? Number(raw.calledIntel) : null,
      calledSmartCount: Number(raw.calledSmart ?? 0),
      calledKolCount: Number(raw.calledKol ?? 0),
      calledMcUsd: calledMc,
      currentMcUsd: currentMc,
      athMultiple: Number(raw.athMultiple ?? 1) || 1,
      gainPct,
      ageMinutes,
      velocity,
      snapDeltaPct,
      liveSmart: Number(raw.liveSmart ?? 0),
      liveKol: Number(raw.liveKol ?? 0),
      secIsHoneypot: raw.secHoneypot as boolean | null,
      secMintRenounced: raw.secMint as boolean | null,
      secFreezeRenounced: raw.secFreeze as boolean | null,
      holderVelocityScore: raw.liveHv != null ? Number(raw.liveHv) : null,
      volumeIntensityScore: raw.volumeIntensity != null ? Number(raw.volumeIntensity) : null,
      prevPhase,
      prevScore,
      snapCount,
    });

    if (raw.secHoneypot === true) continue;
    if (!runner.signals.observationReady || snapCount < MIN_ENTRY_OBSERVATION_SNAPS) {
      continue;
    }

    // Strict automated entry: ENTRY eligible OR strong confirmed heating
    const strongHeat =
      runner.phase === "heating"
      && runner.score >= CFG.entryMinScore
      && velocity >= CFG.entryMinVel
      && runner.signals.taggedOk
      && (runner.signals.mintOk || (raw.calledIntel != null && Number(raw.calledIntel) >= 85));

    if (!(runner.alertEligible || (strongHeat && velocity >= 1.28))) {
      continue;
    }

    const key = patternKey({
      sizeLabel: runner.sizeLabel,
      intel: Number(raw.calledIntel ?? 0),
      taggedOk: runner.signals.taggedOk,
      mintOk: runner.signals.mintOk,
      velocity,
      snapCount,
      phase: runner.phase,
      smart: Number(raw.calledSmart ?? 0),
      kol: Number(raw.calledKol ?? 0),
    });
    const pat = await getPattern(key);
    const edge = patternEdge(pat);
    if (!edge.allow) {
      await logEvent("skip", "info", `⏭ skip $${String(raw.symbol ?? "?")} · ${edge.note}`, {
        tokenId,
        symbol: String(raw.symbol ?? ""),
        meta: { patternKey: key, reason: edge.note },
      });
      continue;
    }

    const st = await ensureState();
    const stake = sizeStake(st.bankrollUsd, edge.boost);
    if (stake > st.bankrollUsd) continue;

    await db.execute(sql`
      INSERT INTO dex_positions (
        token_id, pro_call_id, address, symbol,
        stake_usd, remaining_stake_usd, entry_mc_usd,
        entry_phase, entry_score, entry_velocity, entry_snap_count,
        pattern_key, peak_multiple, moon_bag_taken, status
      ) VALUES (
        ${tokenId}, ${Number(raw.proCallId)}, ${String(raw.address)}, ${raw.symbol != null ? String(raw.symbol) : null},
        ${stake}, ${stake}, ${currentMc},
        ${runner.phase}, ${runner.score}, ${velocity}, ${snapCount},
        ${key}, ${1}, false, 'open'
      )
    `);
    await db.execute(sql`
      UPDATE dex_agent_state
      SET bankroll_usd = bankroll_usd - ${stake},
          trades_opened = trades_opened + 1,
          updated_at = NOW()
      WHERE id = ${st.id}
    `);

    await logEvent(
      "enter",
      "info",
      `🤖 ENTER $${String(raw.symbol ?? "?")} · $${stake} @ MC $${Math.round(currentMc)} · ${runner.phase} · vel ${velocity.toFixed(2)}× · snaps ${snapCount} · ${edge.note}`,
      {
        tokenId,
        symbol: String(raw.symbol ?? ""),
        meta: {
          stake, entryMc: currentMc, phase: runner.phase, score: runner.score,
          velocity, snapCount, patternKey: key, edge: edge.note,
        },
      },
    );

    openIds.add(tokenId);
    slots--;
  }
}

async function takeProfitMoon(
  pos: OpenPos,
  mc: number,
  mult: number,
  state: AgentState,
): Promise<void> {
  const sellFrac = 1 - CFG.moonKeepFrac;
  const sellStake = pos.remainingStakeUsd * sellFrac;
  const moonStake = pos.remainingStakeUsd * CFG.moonKeepFrac;
  const proceeds = sellStake * mult;
  const pnl = proceeds - sellStake;

  await db.execute(sql`
    UPDATE dex_positions
    SET remaining_stake_usd = ${moonStake},
        moon_bag_taken = true,
        status = 'moon',
        peak_multiple = GREATEST(COALESCE(peak_multiple, 1), ${mult}),
        realized_pnl_usd = COALESCE(realized_pnl_usd, 0) + ${pnl}
    WHERE id = ${pos.id}
  `);
  await db.execute(sql`
    UPDATE dex_agent_state
    SET bankroll_usd = bankroll_usd + ${proceeds},
        realized_pnl_usd = realized_pnl_usd + ${pnl},
        hits_3x = hits_3x + 1,
        updated_at = NOW()
    WHERE id = ${state.id}
  `);

  await logEvent(
    "take_profit",
    "info",
    `💰 3× BANK $${pos.symbol ?? "?"} · sold ${(sellFrac * 100).toFixed(0)}% @ ${mult.toFixed(2)}× · moon bag ${(CFG.moonKeepFrac * 100).toFixed(0)}% left 🌙`,
    {
      tokenId: pos.tokenId,
      symbol: pos.symbol,
      meta: { mult, sellStake, moonStake, proceeds, pnl },
    },
  );
}

async function closeRemaining(
  pos: OpenPos,
  mc: number,
  mult: number,
  reason: string,
  state: AgentState,
): Promise<void> {
  const stake = pos.remainingStakeUsd;
  const proceeds = stake * mult;
  const pnl = proceeds - stake;
  const totalPnl = (pos.realizedPnlUsd || 0) + pnl;
  // Effective multiple vs original stake for learning
  const totalProceedsApprox = (pos.stakeUsd - stake) * Math.max(CFG.takeProfitMult, mult) + proceeds;
  // Better: use blended — if moon taken, learn from peak-aware exit
  const learnMult = pos.moonBagTaken
    ? (pos.stakeUsd > 0
      ? ((pos.stakeUsd * (1 - CFG.moonKeepFrac) * CFG.takeProfitMult) + (stake * mult)) / pos.stakeUsd
      : mult)
    : mult;
  const hit3x = learnMult >= CFG.takeProfitMult || pos.moonBagTaken;

  await db.execute(sql`
    UPDATE dex_positions
    SET remaining_stake_usd = 0,
        status = 'closed',
        exit_mc_usd = ${mc},
        exit_at = NOW(),
        exit_reason = ${reason},
        realized_pnl_usd = ${totalPnl}
    WHERE id = ${pos.id}
  `);
  await db.execute(sql`
    UPDATE dex_agent_state
    SET bankroll_usd = bankroll_usd + ${proceeds},
        realized_pnl_usd = realized_pnl_usd + ${pnl},
        trades_closed = trades_closed + 1,
        updated_at = NOW()
    WHERE id = ${state.id}
  `);

  if (pos.patternKey) {
    await learnPattern(pos.patternKey, learnMult, hit3x);
  }

  await logEvent(
    reason.startsWith("hard") || reason.startsWith("dead") ? "stop" : "exit",
    reason.includes("stop") || reason.includes("dead") ? "warn" : "info",
    `${reason.includes("stop") || reason.includes("dead") ? "🛑" : "✅"} EXIT $${pos.symbol ?? "?"} · ${mult.toFixed(2)}× · ${reason} · pnl ${pnl >= 0 ? "+" : ""}$${Math.round(pnl)}`,
    {
      tokenId: pos.tokenId,
      symbol: pos.symbol,
      meta: { mult, learnMult, reason, pnl, hit3x, totalProceedsApprox },
    },
  );
}

export function startDexAgent(): void {
  setTimeout(() => {
    tick().catch(err => log.error({ err }, "dex agent startup tick failed"));
    setInterval(() => {
      tick().catch(err => log.error({ err }, "dex agent tick failed"));
    }, TICK_MS);
  }, STARTUP_DELAY_MS);

  log.info({ tickMs: TICK_MS, takeProfit: CFG.takeProfitMult, moon: CFG.moonKeepFrac }, "Dex Autopilot scheduled");
}
