/**
 * Pro Snapshots — momentum-based
 *
 * Tickers still run on a short schedule, but rows are written only when MC
 * moves (or sparse heartbeats). Low-MC flats are not force-sampled hourly.
 *
 * Each write:
 *   • pro_snapshots row + ATH / milestones
 *   • Pro Score v2 + Runner Score / phase (entry product)
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { computeProScore, deriveRunStatus } from "../lib/pro-scoring";
import { convictionFromPayload, qualitySignalsFromPayload } from "../lib/gmgn-pro-verify";
import { invalidateProCaches } from "../lib/pro-cache";
import {
  buildRunnerTransition,
  computeRunnerScore,
  MIN_ENTRY_OBSERVATION_SNAPS,
  shouldWriteMomentumSnap,
  type RunnerPhase,
} from "../lib/runner-score";
import { opsLog } from "../lib/ops-log";

const log = logger.child({ module: "pro-snapshots" });

const HOT_INTERVAL_MS  = 20_000;
const FULL_INTERVAL_MS = 2 * 60_000;
const STARTUP_DELAY_MS = 20_000;

const MILESTONES = [
  { mult: 2,   hitCol: "hit_2x",   atCol: "hit_2x_at"   },
  { mult: 3,   hitCol: "hit_3x",   atCol: "hit_3x_at"   },
  { mult: 5,   hitCol: "hit_5x",   atCol: "hit_5x_at"   },
  { mult: 10,  hitCol: "hit_10x",  atCol: "hit_10x_at"  },
  { mult: 100, hitCol: "hit_100x", atCol: "hit_100x_at" },
] as const;

type Mode = "hot" | "full";

async function snapshotOnce(mode: Mode): Promise<void> {
  try {
    const ageFilter = mode === "hot"
      ? sql`AND pc.called_at >= NOW() - INTERVAL '6 hours'`
      : sql``;

    const rows = await db.execute(sql`
      SELECT
        pc.id                        AS pro_call_id,
        pc.token_id,
        pc.called_at,
        pc.called_mc_usd,
        pc.quality_label             AS prev_quality,
        pc.ath_multiple              AS prev_ath,
        pc.called_intel_score,
        pc.called_kol_count,
        pc.called_smart_count,
        pc.called_holder_velocity,
        pc.called_mc_growth,
        pc.called_volume_intensity,
        pc.verified_wallets,
        pc.hit_2x,   pc.hit_3x,   pc.hit_5x,   pc.hit_10x,   pc.hit_100x,
        pc.last_snapshot_at,
        pc.last_snap_mc_usd,
        pc.runner_phase              AS prev_runner_phase,
        pc.runner_score              AS prev_runner_score,
        COALESCE(pc.observation_snap_count, 0) AS observation_snap_count,
        (
          SELECT COUNT(*)::int FROM pro_snapshots ps WHERE ps.pro_call_id = pc.id
        )                            AS snap_count,
        t.market_cap_usd             AS current_mc,
        t.symbol,
        t.ath_market_cap_usd         AS ath_mc_usd,
        t.holder_kol_count           AS kol_count,
        t.holder_smart_count         AS smart_count,
        t.intelligence_score         AS intel_score,
        t.holder_velocity_score,
        t.liquidity_usd,
        t.holder_count,
        t.mc_growth_score,
        t.volume_intensity_score,
        t.sec_is_honeypot,
        t.sec_mint_renounced,
        t.sec_freeze_renounced,
        t.sec_top10_holder_rate,
        t.sec_lp_locked,
        t.sec_rat_trader_amt_rate
      FROM pro_calls pc
      JOIN tracked_tokens t ON t.id = pc.token_id
      WHERE TRUE ${ageFilter}
    `);

    if (rows.rows.length === 0) return;

    type Row = {
      pro_call_id: number; token_id: number; called_at: string | Date;
      called_mc_usd: string | null; prev_quality: string | null; prev_ath: number | null;
      called_intel_score: number | null;
      called_kol_count: number | null; called_smart_count: number | null;
      called_holder_velocity: number | null;
      called_mc_growth: number | null; called_volume_intensity: number | null;
      verified_wallets: unknown;
      hit_2x: boolean | null; hit_3x: boolean | null; hit_5x: boolean | null;
      hit_10x: boolean | null; hit_100x: boolean | null;
      last_snapshot_at: string | Date | null;
      last_snap_mc_usd: string | null;
      prev_runner_phase: string | null;
      prev_runner_score: number | null;
      observation_snap_count: number | null;
      snap_count: number | null;
      symbol: string | null;
      current_mc: string | null; ath_mc_usd: string | null; kol_count: number | null;
      smart_count: number | null; intel_score: number | null;
      holder_velocity_score: number | null;
      liquidity_usd: string | null;
      holder_count: number | null;
      mc_growth_score: number | null;
      volume_intensity_score: number | null;
      sec_is_honeypot: boolean | null;
      sec_mint_renounced: boolean | null;
      sec_freeze_renounced: boolean | null;
      sec_top10_holder_rate: number | null;
      sec_lp_locked: boolean | null;
      sec_rat_trader_amt_rate: number | null;
    };

    let writtenSnaps = 0;
    let skippedFlat = 0;
    let phaseTransitions = 0;
    let qualityChanged = false;
    for (const r of rows.rows as Row[]) {
      const calledMc  = parseFloat(r.called_mc_usd ?? "0") || 0;
      const currentMc = parseFloat(r.current_mc ?? "0") || 0;
      const athMcUsd  = parseFloat(r.ath_mc_usd  ?? "0") || currentMc;
      const multiple  = calledMc > 0 ? currentMc / calledMc : 1;
      const athFromPipeline = calledMc > 0 ? athMcUsd / calledMc : 1;
      const newAth    = Math.max(r.prev_ath ?? 1, multiple, athFromPipeline);
      const gainPct   = calledMc > 0 ? ((currentMc - calledMc) / calledMc) * 100 : 0;
      const liquidityUsd = parseFloat(r.liquidity_usd ?? "0") || 0;
      const ageHours = r.called_at
        ? (Date.now() - new Date(r.called_at).getTime()) / 3_600_000
        : 0;
      const ageMinutes = ageHours * 60;
      const lastSnapMc = parseFloat(r.last_snap_mc_usd ?? "") || calledMc || currentMc;
      const signedDelta = lastSnapMc > 0 ? (currentMc - lastSnapMc) / lastSnapMc : null;
      const mcDeltaPct = signedDelta != null ? Math.abs(signedDelta) : 1;
      const lastSnapAgeSec = r.last_snapshot_at
        ? (Date.now() - new Date(r.last_snapshot_at).getTime()) / 1000
        : null;
      const prevPhase = (r.prev_runner_phase as RunnerPhase | null) ?? "radar";
      const prevScore = r.prev_runner_score != null ? Number(r.prev_runner_score) : null;
      const obsSnapCount = Math.max(
        Number(r.snap_count ?? 0) || 0,
        Number(r.observation_snap_count ?? 0) || 0,
      );
      const velocity = calledMc > 0 && currentMc > 0 ? currentMc / calledMc : 1;

      // Score first (cheap) so phase changes can force a snap write with full factors
      const runnerPreview = computeRunnerScore({
        calledIntelScore: r.called_intel_score,
        calledSmartCount: r.called_smart_count ?? 0,
        calledKolCount: r.called_kol_count ?? 0,
        calledMcUsd: calledMc || null,
        currentMcUsd: currentMc || null,
        athMultiple: newAth,
        gainPct,
        ageMinutes,
        velocity,
        snapDeltaPct: signedDelta,
        liveSmart: r.smart_count ?? 0,
        liveKol: r.kol_count ?? 0,
        secIsHoneypot: r.sec_is_honeypot,
        secMintRenounced: r.sec_mint_renounced,
        secFreezeRenounced: r.sec_freeze_renounced,
        holderVelocityScore: r.holder_velocity_score,
        volumeIntensityScore: r.volume_intensity_score,
        prevPhase,
        prevScore,
        snapCount: obsSnapCount,
      });

      const scoreDelta = prevScore != null ? runnerPreview.score - prevScore : null;
      const observing =
        runnerPreview.rawPhase === "entry"
        || runnerPreview.rawPhase === "heating"
        || velocity >= 1.1
        || (runnerPreview.score >= 55 && obsSnapCount < MIN_ENTRY_OBSERVATION_SNAPS);
      if (!shouldWriteMomentumSnap({
        lastSnapAgeSec,
        mcDeltaPct,
        ageMinutes,
        phase: runnerPreview.phase,
        mode,
        force: runnerPreview.phaseChanged,
        scoreDelta,
        snapCount: obsSnapCount,
        observing,
      })) {
        skippedFlat++;
        continue;
      }

      const runStatus = deriveRunStatus(currentMc || null, calledMc || null, newAth);

      let conviction = null as ReturnType<typeof convictionFromPayload>;
      let quality = null as ReturnType<typeof qualitySignalsFromPayload> | null;
      if (r.verified_wallets) {
        try {
          const raw = typeof r.verified_wallets === "string"
            ? JSON.parse(String(r.verified_wallets))
            : r.verified_wallets;
          conviction = convictionFromPayload(raw);
          quality = qualitySignalsFromPayload(raw);
        } catch { /* ignore */ }
      }

      const { score: proScore, qualityLabel, survivalScore, entryTier } = computeProScore({
        calledIntelScore:     r.called_intel_score,
        calledKolCount:       r.called_kol_count ?? 0,
        calledSmartCount:     r.called_smart_count ?? 0,
        calledMcUsd:          calledMc || null,
        calledHolderVelocity: r.called_holder_velocity,
        calledMcGrowth:       r.called_mc_growth,
        calledVolumeIntensity: r.called_volume_intensity,
        smartHoldRate:        conviction?.smart.holdRate ?? null,
        kolHoldRate:          conviction?.kol.holdRate ?? null,
        smartPaperHands:      conviction?.smart.paperHands ?? null,
        diamondHands:         (conviction?.smart.diamondHands ?? 0) + (conviction?.kol.diamondHands ?? 0),
        smartKolSupplyPct:    (conviction?.smart.supplyPctHeld ?? 0) + (conviction?.kol.supplyPctHeld ?? 0),
        currentMcUsd:         currentMc || null,
        athMultiple:          newAth,
        gainSinceCall:        gainPct,
        runStatus,
        liquidityUsd:         liquidityUsd || null,
        ageHoursSinceCall:    ageHours,
        holderVelocityScore:  r.holder_velocity_score,
        secIsHoneypot:        r.sec_is_honeypot,
        secMintRenounced:     r.sec_mint_renounced,
        secFreezeRenounced:   r.sec_freeze_renounced,
        secTop10HolderRate:   r.sec_top10_holder_rate,
        secLpLocked:          r.sec_lp_locked,
        secRatTraderAmtRate:  r.sec_rat_trader_amt_rate ?? quality?.ratPct ?? null,
        bundlerPct:           quality?.bundlerPct ?? null,
        sniperHoldRate:       quality?.sniperHoldRate ?? null,
        freshWalletRate:      quality?.freshWalletRate ?? null,
        botDegenRate:         quality?.botDegenRate ?? null,
        entrapmentPct:        quality?.entrapmentPct ?? null,
      });

      const kolDelta = (r.kol_count ?? 0) - (r.called_kol_count ?? 0);
      const smartDelta = (r.smart_count ?? 0) - (r.called_smart_count ?? 0);

      const existingFlags: Record<string, boolean | null> = {
        hit_2x:   r.hit_2x,
        hit_3x:   r.hit_3x,
        hit_5x:   r.hit_5x,
        hit_10x:  r.hit_10x,
        hit_100x: r.hit_100x,
      };

      // Prefer first real MC cross from price history; fall back to NOW().
      const firstCrossAt = new Map<number, Date | null>();
      if (calledMc > 0) {
        for (const m of MILESTONES) {
          if (existingFlags[m.hitCol] || newAth < m.mult) continue;
          const threshold = calledMc * m.mult;
          try {
            const cross = await db.execute(sql`
              SELECT snapshot_at
              FROM token_price_snapshots
              WHERE token_id = ${r.token_id}
                AND NULLIF(market_cap_usd, '')::numeric >= ${threshold}
                AND snapshot_at >= ${r.called_at}
              ORDER BY snapshot_at ASC
              LIMIT 1
            `);
            const at = (cross.rows[0] as { snapshot_at?: string | Date } | undefined)?.snapshot_at;
            firstCrossAt.set(m.mult, at ? new Date(at) : null);
          } catch {
            firstCrossAt.set(m.mult, null);
          }
        }
      }

      const milestoneParts: ReturnType<typeof sql>[] = [];
      for (const m of MILESTONES) {
        if (!existingFlags[m.hitCol] && newAth >= m.mult) {
          const at = firstCrossAt.get(m.mult);
          if (at) {
            milestoneParts.push(sql`, ${sql.raw(m.hitCol)} = true, ${sql.raw(m.atCol)} = ${at}`);
          } else {
            milestoneParts.push(sql`, ${sql.raw(m.hitCol)} = true, ${sql.raw(m.atCol)} = NOW()`);
          }
        }
      }

      // Recompute with conviction hold-rate now that verified wallets are parsed
      const runner = computeRunnerScore({
        calledIntelScore: r.called_intel_score,
        calledSmartCount: r.called_smart_count ?? 0,
        calledKolCount: r.called_kol_count ?? 0,
        calledMcUsd: calledMc || null,
        currentMcUsd: currentMc || null,
        athMultiple: newAth,
        gainPct,
        ageMinutes,
        velocity,
        snapDeltaPct: signedDelta,
        liveSmart: r.smart_count ?? 0,
        liveKol: r.kol_count ?? 0,
        secIsHoneypot: r.sec_is_honeypot,
        secMintRenounced: r.sec_mint_renounced,
        secFreezeRenounced: r.sec_freeze_renounced,
        holderVelocityScore: r.holder_velocity_score,
        volumeIntensityScore: r.volume_intensity_score,
        smartHoldRate: conviction?.smart.holdRate ?? null,
        prevPhase,
        prevScore,
        snapCount: obsSnapCount,
      });

      await db.execute(sql`
        INSERT INTO pro_snapshots (
          pro_call_id, token_id, mc_usd, kol_count, smart_count, intel_score, ath_multiple,
          survival_score, pro_score, quality_label, gain_pct, run_status,
          holder_velocity_score, age_hours,
          holder_count, mc_growth_score, volume_intensity_score, liquidity_usd,
          kol_delta, smart_delta,
          runner_score, runner_phase, velocity, phase_changed
        )
        VALUES (
          ${r.pro_call_id}, ${r.token_id},
          ${r.current_mc ?? null},
          ${r.kol_count ?? 0}, ${r.smart_count ?? 0},
          ${r.intel_score ?? null}, ${multiple},
          ${survivalScore}, ${proScore}, ${qualityLabel}, ${gainPct}, ${runStatus},
          ${r.holder_velocity_score ?? null}, ${ageHours},
          ${r.holder_count ?? null},
          ${r.mc_growth_score ?? null},
          ${r.volume_intensity_score ?? null},
          ${r.liquidity_usd ?? null},
          ${kolDelta}, ${smartDelta},
          ${runner.score}, ${runner.phase}, ${runner.signals.velocity},
          ${runner.phaseChanged ? 1 : 0}
        )
      `);

      // Sticky desk: once surfaced, never demote quality off the feed.
      // Honeypot is the only snapshot-time eviction. DEAD/crash → outcome UI.
      let nextQuality: string = qualityLabel;
      if (r.sec_is_honeypot === true) {
        nextQuality = "below";
      } else if (r.prev_quality === "very_good" || r.prev_quality === "good") {
        nextQuality = r.prev_quality;
      } else if (qualityLabel === "below") {
        nextQuality = "below";
      }

      const surfacingNow = nextQuality === "good" || nextQuality === "very_good";
      const surfacedClause = surfacingNow
        ? sql`, surfaced_at = COALESCE(surfaced_at, NOW()), surfaced_mc_usd = COALESCE(surfaced_mc_usd, ${String(r.current_mc ?? "0")})`
        : sql``;

      const phaseOk = new Set(["radar", "heating", "entry", "fading", "dead"]);
      const phase = phaseOk.has(runner.phase) ? runner.phase : "radar";
      try {
        await db.execute(sql`
          UPDATE pro_calls
          SET
            ath_multiple     = GREATEST(COALESCE(ath_multiple, 1), ${newAth}),
            last_snapshot_at = NOW(),
            last_snap_mc_usd = ${String(currentMc || 0)},
            pro_score        = ${proScore},
            survival_score   = ${survivalScore},
            last_survival_at = NOW(),
            entry_tier       = ${entryTier},
            score_version    = 'v2',
            runner_score     = ${runner.score},
            runner_phase     = ${phase},
            observation_snap_count = ${obsSnapCount + 1},
            quality_label    = CASE
              WHEN ${r.sec_is_honeypot === true} THEN 'below'
              WHEN surfaced_at IS NOT NULL THEN
                CASE
                  WHEN quality_label IN ('good', 'very_good') THEN quality_label
                  ELSE 'good'
                END
              ELSE ${nextQuality}
            END
            ${surfacedClause}
            ${sql.join(milestoneParts, sql``)}
          WHERE id = ${r.pro_call_id}
        `);
      } catch (updErr) {
        log.warn({ err: updErr, proCallId: r.pro_call_id, phase }, "pro_calls snap update failed");
        continue;
      }

      const transition = buildRunnerTransition(prevPhase, runner, {
        mcUsd: currentMc || null,
        calledMcUsd: calledMc || null,
        athMultiple: newAth,
        smart: r.smart_count ?? 0,
        kol: r.kol_count ?? 0,
        intel: r.called_intel_score,
      });
      if (transition) {
        phaseTransitions++;
        opsLog(
          "runner",
          transition.to === "entry" ? "info" : transition.to === "dead" ? "warn" : "info",
          `${r.symbol ?? "?"} · ${transition.from}→${transition.to} · MC $${Math.round(transition.mcUsd ?? 0)} · vel ${transition.velocity}× · score ${transition.score}`,
          {
            proCallId: r.pro_call_id,
            tokenId: r.token_id,
            from: transition.from,
            to: transition.to,
            score: transition.score,
            mcUsd: transition.mcUsd,
            calledMcUsd: transition.calledMcUsd,
            velocity: transition.velocity,
            gainPct: transition.gainPct,
            athMultiple: transition.athMultiple,
            smart: transition.smart,
            kol: transition.kol,
            intel: transition.intel,
            snapCount: transition.snapCount,
            reasons: transition.reasons,
            blockers: transition.blockers,
          },
        );
      }

      if (String(r.prev_quality ?? "") !== "good" && String(r.prev_quality ?? "") !== "very_good") {
        qualityChanged = true;
      }
      writtenSnaps++;
    }

    // Always refresh feed after hot snaps (scores/ATH move); also on quality flips.
    if (writtenSnaps > 0 && (mode === "hot" || qualityChanged)) {
      await invalidateProCaches();
    }

    log.info(
      { snapCount: writtenSnaps, skippedFlat, phaseTransitions, mode },
      "Pro snapshots written (momentum)",
    );
  } catch (err) {
    log.error({ err, mode }, "Pro snapshots error");
  }
}

export function startProSnapshots(): void {
  setTimeout(async () => {
    await snapshotOnce("full");

    setInterval(() => {
      snapshotOnce("hot").catch(err => log.error({ err }, "hot snapshot failed"));
    }, HOT_INTERVAL_MS);

    setInterval(() => {
      snapshotOnce("full").catch(err => log.error({ err }, "full snapshot failed"));
    }, FULL_INTERVAL_MS);
  }, STARTUP_DELAY_MS);

  log.info(
    { hotMs: HOT_INTERVAL_MS, fullMs: FULL_INTERVAL_MS, delayMs: STARTUP_DELAY_MS },
    "Pro snapshots scheduled (momentum writes / hot tick 20s <6h)",
  );
}
