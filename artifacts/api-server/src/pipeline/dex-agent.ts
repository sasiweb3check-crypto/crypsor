/**
 * Dex Autopilot — automated paper trader.
 *
 * Rules only. No emotions.
 * Data: runner phase / snaps / velocity / tagged / mint / live MC (on-chain mark).
 * Goal: enter after observation, bank 70% at 3×, trail 30% moon bag.
 * Memory: pattern fingerprints + full entry/exit feedback JSON.
 *
 * 24/7: in-process setInterval while Render API is awake; also expose
 * runDexAgentTick() via GET/POST /api/trader/tick for external cron wakeups
 * (needed on Render free plan which spins down).
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { opsLog } from "../lib/ops-log";
import {
  computeRunnerScore,
  MIN_ENTRY_OBSERVATION_SNAPS,
  type RunnerPhase,
  type RunnerScoreResult,
} from "../lib/runner-score";
import { patternEdge, patternKey } from "../lib/dex-patterns";
import {
  buildEntryFeedback,
  buildExitFeedback,
  type DexMarketSnap,
} from "../lib/dex-feedback";

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
  entryAt: string | Date | null;
  peakMultiple: number;
  moonBagTaken: boolean;
  status: string;
  patternKey: string | null;
  realizedPnlUsd: number;
};

let ticking = false;

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

async function touchTick(stateId: number): Promise<void> {
  await db.execute(sql`
    UPDATE dex_agent_state SET last_tick_at = NOW(), updated_at = NOW() WHERE id = ${stateId}
  `);
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
           entry_mc_usd AS "entryMcUsd", entry_at AS "entryAt",
           COALESCE(peak_multiple, 1) AS "peakMultiple",
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

function holdMinutes(entryAt: string | Date | null | undefined): number {
  if (!entryAt) return 0;
  const t = entryAt instanceof Date ? entryAt.getTime() : new Date(entryAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return (Date.now() - t) / 60_000;
}

async function loadMarketSnap(tokenId: number, proCallId: number | null): Promise<{
  market: DexMarketSnap;
  runner: RunnerScoreResult;
} | null> {
  const r = await db.execute(sql`
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
      t.liquidity_usd AS "liquidityUsd",
      t.holder_count AS "holderCount",
      t.sec_mint_renounced AS "secMint",
      t.sec_freeze_renounced AS "secFreeze",
      t.sec_is_honeypot AS "secHoneypot"
    FROM tracked_tokens t
    LEFT JOIN pro_calls pc ON pc.token_id = t.id
      ${proCallId != null ? sql`AND pc.id = ${proCallId}` : sql``}
    WHERE t.id = ${tokenId}
    ORDER BY pc.called_at DESC NULLS LAST
    LIMIT 1
  `);
  const raw = r.rows[0] as Record<string, unknown> | undefined;
  if (!raw) return null;

  const calledMc = parseFloat(String(raw.calledMcUsd ?? "0")) || 0;
  const currentMc = parseFloat(String(raw.currentMc ?? "0")) || 0;
  const velocity = calledMc > 0 && currentMc > 0 ? currentMc / calledMc : 1;
  const gainPct = calledMc > 0 && currentMc > 0 ? ((currentMc - calledMc) / calledMc) * 100 : 0;
  const calledAt = raw.calledAt ? new Date(String(raw.calledAt)).getTime() : NaN;
  const ageMinutes = Number.isFinite(calledAt) ? (Date.now() - calledAt) / 60_000 : 9999;
  const lastSnapMc = parseFloat(String(raw.lastSnapMcUsd ?? "")) || calledMc || currentMc;
  const snapDeltaPct = lastSnapMc > 0 ? (currentMc - lastSnapMc) / lastSnapMc : null;
  const snapCount = Math.max(0, Number(raw.snapCount ?? 0) || 0);

  const runner = computeRunnerScore({
    calledIntelScore: raw.calledIntel != null ? Number(raw.calledIntel) : null,
    calledSmartCount: Number(raw.calledSmart ?? 0),
    calledKolCount: Number(raw.calledKol ?? 0),
    calledMcUsd: calledMc || null,
    currentMcUsd: currentMc || null,
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
    prevPhase: (raw.runnerPhase as RunnerPhase | null) ?? "radar",
    prevScore: raw.runnerScore != null ? Number(raw.runnerScore) : null,
    snapCount,
  });

  const liq = parseFloat(String(raw.liquidityUsd ?? "")) || null;
  const market: DexMarketSnap = {
    at: new Date().toISOString(),
    tokenId,
    proCallId: raw.proCallId != null ? Number(raw.proCallId) : proCallId,
    address: String(raw.address ?? ""),
    symbol: raw.symbol != null ? String(raw.symbol) : null,
    calledMcUsd: calledMc || null,
    liveMcUsd: currentMc || null,
    velocity: Math.round(velocity * 1000) / 1000,
    gainPct: Math.round(gainPct * 10) / 10,
    athMultiple: Number(raw.athMultiple ?? 1) || 1,
    ageMinutes: Math.round(ageMinutes * 10) / 10,
    snapCount,
    phase: runner.phase,
    score: runner.score,
    alertEligible: runner.alertEligible,
    reasons: runner.reasons,
    blockers: runner.blockers,
    sizeLabel: runner.sizeLabel,
    calledIntel: raw.calledIntel != null ? Number(raw.calledIntel) : null,
    calledSmart: Number(raw.calledSmart ?? 0),
    calledKol: Number(raw.calledKol ?? 0),
    liveSmart: Number(raw.liveSmart ?? 0),
    liveKol: Number(raw.liveKol ?? 0),
    liveHv: raw.liveHv != null ? Number(raw.liveHv) : null,
    volumeIntensity: raw.volumeIntensity != null ? Number(raw.volumeIntensity) : null,
    liquidityUsd: liq,
    holderCount: raw.holderCount != null ? Number(raw.holderCount) : null,
    mintOk: runner.signals.mintOk,
    freezeOk: raw.secFreeze === true ? true : raw.secFreeze === false ? false : null,
    honeypot: raw.secHoneypot === true,
    taggedOk: runner.signals.taggedOk,
    freshnessOk: runner.signals.freshnessOk,
    observationReady: runner.signals.observationReady,
  };

  return { market, runner };
}

async function tick(): Promise<{ ok: boolean; actions: string[] }> {
  const actions: string[] = [];
  const state = await ensureState();
  await touchTick(state.id);
  if (!state.enabled) {
    actions.push("disabled");
    return { ok: true, actions };
  }

  const open = await loadOpenPositions();

  for (const pos of open) {
    const snap = await loadMarketSnap(pos.tokenId, pos.proCallId);
    const mc = snap?.market.liveMcUsd ?? 0;
    if (!snap || !mc || pos.entryMcUsd <= 0) continue;

    const mult = mc / pos.entryMcUsd;
    const peak = Math.max(pos.peakMultiple || 1, mult);
    if (peak > (pos.peakMultiple || 1)) {
      await db.execute(sql`
        UPDATE dex_positions SET peak_multiple = ${peak} WHERE id = ${pos.id}
      `);
      pos.peakMultiple = peak;
    }

    const phase = snap.market.phase;

    if (mult <= CFG.hardStopMult || phase === "dead") {
      const reason = phase === "dead" ? "dead_stop" : "hard_stop";
      await closeRemaining(pos, snap, mult, reason,
        phase === "dead"
          ? "Phase flipped to dead — cut remaining"
          : `Multiple hit hard stop ${CFG.hardStopMult}×`,
        state);
      actions.push(`${reason}:${pos.symbol}`);
      continue;
    }

    if (!pos.moonBagTaken && mult >= CFG.takeProfitMult) {
      await takeProfitMoon(pos, snap, mult, state);
      actions.push(`take_profit:${pos.symbol}`);
      continue;
    }

    if (pos.moonBagTaken || pos.status === "moon") {
      const trailFloor = (pos.peakMultiple || mult) * (1 - CFG.trailDrawdown);
      if (mult < trailFloor || phase === "fading" || phase === "dead") {
        const reason = phase === "fading" || phase === "dead" ? `phase_${phase}` : "moon_trail";
        const detail = reason.startsWith("phase_")
          ? `Moon bag cut — phase ${phase}`
          : `Moon bag trailed under peak×(1-${CFG.trailDrawdown}) = ${trailFloor.toFixed(2)}×`;
        await closeRemaining(pos, snap, mult, reason, detail, state);
        actions.push(`${reason}:${pos.symbol}`);
      }
    }
  }

  const openNow = await loadOpenPositions();
  if (openNow.length >= CFG.maxOpen) {
    actions.push("max_open");
    return { ok: true, actions };
  }

  const freshState = await ensureState();
  if (!freshState.enabled || freshState.bankrollUsd < CFG.minStake) {
    return { ok: true, actions };
  }

  const cands = await db.execute(sql`
    SELECT pc.id AS "proCallId", pc.token_id AS "tokenId"
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

  for (const row of cands.rows as Array<{ proCallId: number; tokenId: number }>) {
    if (slots <= 0) break;
    const tokenId = Number(row.tokenId);
    if (openIds.has(tokenId)) continue;

    const loaded = await loadMarketSnap(tokenId, Number(row.proCallId));
    if (!loaded) continue;
    const { market, runner } = loaded;
    if (market.honeypot) continue;
    if (!market.observationReady || market.snapCount < MIN_ENTRY_OBSERVATION_SNAPS) continue;
    if (!market.liveMcUsd || market.liveMcUsd <= 0) continue;

    const strongHeat =
      runner.phase === "heating"
      && runner.score >= CFG.entryMinScore
      && market.velocity >= CFG.entryMinVel
      && runner.signals.taggedOk
      && (runner.signals.mintOk || (market.calledIntel != null && market.calledIntel >= 85));

    const entryGate = runner.alertEligible
      ? "alertEligible"
      : (strongHeat && market.velocity >= 1.28 ? "strongHeat" : "");
    if (!entryGate) continue;

    const key = patternKey({
      sizeLabel: runner.sizeLabel,
      intel: market.calledIntel ?? 0,
      taggedOk: runner.signals.taggedOk,
      mintOk: runner.signals.mintOk,
      velocity: market.velocity,
      snapCount: market.snapCount,
      phase: runner.phase,
      smart: market.calledSmart,
      kol: market.calledKol,
    });
    const pat = await getPattern(key);
    const edge = patternEdge(pat);
    if (!edge.allow) {
      await logEvent("skip", "info", `⏭ skip $${market.symbol ?? "?"} · ${edge.note}`, {
        tokenId,
        symbol: market.symbol,
        meta: { patternKey: key, reason: edge.note, market },
      });
      continue;
    }

    const st = await ensureState();
    const stake = sizeStake(st.bankrollUsd, edge.boost);
    if (stake > st.bankrollUsd) continue;

    const feedback = buildEntryFeedback({
      market,
      stakeUsd: stake,
      patternKey: key,
      patternEdge: edge,
      patternStats: pat,
      entryGate,
      cfg: CFG,
    });

    await db.execute(sql`
      INSERT INTO dex_positions (
        token_id, pro_call_id, address, symbol,
        stake_usd, remaining_stake_usd, entry_mc_usd,
        entry_phase, entry_score, entry_velocity, entry_snap_count,
        pattern_key, peak_multiple, moon_bag_taken, status, entry_feedback
      ) VALUES (
        ${tokenId}, ${market.proCallId}, ${market.address}, ${market.symbol},
        ${stake}, ${stake}, ${market.liveMcUsd},
        ${runner.phase}, ${runner.score}, ${market.velocity}, ${market.snapCount},
        ${key}, ${1}, false, 'open', ${JSON.stringify(feedback)}
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
      `🤖 ENTER $${market.symbol ?? "?"} · $${stake} @ MC $${Math.round(market.liveMcUsd)} · ${runner.phase} · vel ${market.velocity.toFixed(2)}× · snaps ${market.snapCount} · ${edge.note}`,
      {
        tokenId,
        symbol: market.symbol,
        meta: feedback,
      },
    );

    openIds.add(tokenId);
    slots--;
    actions.push(`enter:${market.symbol}`);
  }

  return { ok: true, actions };
}

async function takeProfitMoon(
  pos: OpenPos,
  snap: { market: DexMarketSnap; runner: RunnerScoreResult },
  mult: number,
  state: AgentState,
): Promise<void> {
  const sellFrac = 1 - CFG.moonKeepFrac;
  const sellStake = pos.remainingStakeUsd * sellFrac;
  const moonStake = pos.remainingStakeUsd * CFG.moonKeepFrac;
  const proceeds = sellStake * mult;
  const pnl = proceeds - sellStake;
  const trailFloor = mult * (1 - CFG.trailDrawdown);

  const feedback = buildExitFeedback({
    market: snap.market,
    reason: "take_profit_3x",
    reasonDetail: `Banked ${(sellFrac * 100).toFixed(0)}% at ${mult.toFixed(2)}×; keeping ${(CFG.moonKeepFrac * 100).toFixed(0)}% moon bag`,
    multiple: mult,
    peakMultiple: Math.max(pos.peakMultiple || 1, mult),
    learnMult: mult,
    stakeClosedUsd: sellStake,
    proceedsUsd: proceeds,
    pnlUsd: pnl,
    holdMinutes: holdMinutes(pos.entryAt),
    moonBagTaken: true,
    trailFloor,
    hit3x: true,
    event: "take_profit",
  });

  await db.execute(sql`
    UPDATE dex_positions
    SET remaining_stake_usd = ${moonStake},
        moon_bag_taken = true,
        status = 'moon',
        peak_multiple = GREATEST(COALESCE(peak_multiple, 1), ${mult}),
        realized_pnl_usd = COALESCE(realized_pnl_usd, 0) + ${pnl},
        exit_feedback = ${JSON.stringify(feedback)}
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
    `💰 3× BANK $${pos.symbol ?? "?"} · sold ${(sellFrac * 100).toFixed(0)}% @ ${mult.toFixed(2)}× · moon bag left 🌙`,
    { tokenId: pos.tokenId, symbol: pos.symbol, meta: feedback },
  );
}

async function closeRemaining(
  pos: OpenPos,
  snap: { market: DexMarketSnap; runner: RunnerScoreResult },
  mult: number,
  reason: string,
  reasonDetail: string,
  state: AgentState,
): Promise<void> {
  const stake = pos.remainingStakeUsd;
  const proceeds = stake * mult;
  const pnl = proceeds - stake;
  const totalPnl = (pos.realizedPnlUsd || 0) + pnl;
  const learnMult = pos.moonBagTaken
    ? (pos.stakeUsd > 0
      ? ((pos.stakeUsd * (1 - CFG.moonKeepFrac) * CFG.takeProfitMult) + (stake * mult)) / pos.stakeUsd
      : mult)
    : mult;
  const hit3x = learnMult >= CFG.takeProfitMult || pos.moonBagTaken;
  const trailFloor = pos.moonBagTaken
    ? (pos.peakMultiple || mult) * (1 - CFG.trailDrawdown)
    : null;

  const feedback = buildExitFeedback({
    market: snap.market,
    reason,
    reasonDetail,
    multiple: mult,
    peakMultiple: pos.peakMultiple || mult,
    learnMult,
    stakeClosedUsd: stake,
    proceedsUsd: proceeds,
    pnlUsd: pnl,
    holdMinutes: holdMinutes(pos.entryAt),
    moonBagTaken: pos.moonBagTaken,
    trailFloor,
    hit3x,
    event: reason.includes("stop") || reason.includes("dead") ? "stop" : "exit",
  });

  await db.execute(sql`
    UPDATE dex_positions
    SET remaining_stake_usd = 0,
        status = 'closed',
        exit_mc_usd = ${snap.market.liveMcUsd},
        exit_at = NOW(),
        exit_reason = ${reason},
        realized_pnl_usd = ${totalPnl},
        exit_feedback = ${JSON.stringify(feedback)}
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
    `${reason.includes("stop") || reason.includes("dead") ? "🛑" : "✅"} EXIT $${pos.symbol ?? "?"} · ${mult.toFixed(2)}× · ${reason} · ${reasonDetail.slice(0, 80)} · pnl ${pnl >= 0 ? "+" : ""}$${Math.round(pnl)}`,
    { tokenId: pos.tokenId, symbol: pos.symbol, meta: feedback },
  );
}

/** Idempotent tick for in-process loop + external cron wakeups. */
export async function runDexAgentTick(): Promise<{ ok: boolean; actions: string[]; skipped?: string }> {
  if (ticking) return { ok: true, actions: [], skipped: "already_running" };
  ticking = true;
  try {
    return await tick();
  } finally {
    ticking = false;
  }
}

export function startDexAgent(): void {
  setTimeout(() => {
    runDexAgentTick().catch(err => log.error({ err }, "dex agent startup tick failed"));
    setInterval(() => {
      runDexAgentTick().catch(err => log.error({ err }, "dex agent tick failed"));
    }, TICK_MS);
  }, STARTUP_DELAY_MS);

  log.info(
    { tickMs: TICK_MS, takeProfit: CFG.takeProfitMult, moon: CFG.moonKeepFrac },
    "Dex Autopilot scheduled (also wake via GET/POST /api/trader/tick)",
  );
}
