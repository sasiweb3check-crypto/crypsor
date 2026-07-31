/**
 * Pro Snapshots
 *
 * Hot path (every 30s): pro calls younger than 6h — memecoin survival window
 * Full path (every 2 min): all pro_calls
 *
 * Each cycle:
 *   • Writes enriched pro_snapshots (survival, pro score, age, run status)
 *   • Updates ath_multiple + milestones
 *   • Recomputes Pro Score v2 + survival_score
 *   • Surfaces quality tokens immediately (COALESCE surfaced_at)
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { computeProScore, deriveRunStatus } from "../lib/pro-scoring";
import { convictionFromPayload } from "../lib/gmgn-pro-verify";

const log = logger.child({ module: "pro-snapshots" });

const HOT_INTERVAL_MS  = 30_000;
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
        pc.ath_multiple              AS prev_ath,
        pc.called_intel_score,
        pc.called_kol_count,
        pc.called_smart_count,
        pc.called_holder_velocity,
        pc.called_mc_growth,
        pc.called_volume_intensity,
        pc.verified_wallets,
        pc.hit_2x,   pc.hit_3x,   pc.hit_5x,   pc.hit_10x,   pc.hit_100x,
        t.market_cap_usd             AS current_mc,
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
      called_mc_usd: string | null; prev_ath: number | null;
      called_intel_score: number | null;
      called_kol_count: number | null; called_smart_count: number | null;
      called_holder_velocity: number | null;
      called_mc_growth: number | null; called_volume_intensity: number | null;
      verified_wallets: unknown;
      hit_2x: boolean | null; hit_3x: boolean | null; hit_5x: boolean | null;
      hit_10x: boolean | null; hit_100x: boolean | null;
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

    let snapCount = 0;
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

      const runStatus = deriveRunStatus(currentMc || null, calledMc || null, newAth);

      let conviction = null as ReturnType<typeof convictionFromPayload>;
      if (r.verified_wallets) {
        try {
          const raw = typeof r.verified_wallets === "string"
            ? JSON.parse(String(r.verified_wallets))
            : r.verified_wallets;
          conviction = convictionFromPayload(raw);
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
        secRatTraderAmtRate:  r.sec_rat_trader_amt_rate,
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

      await db.execute(sql`
        INSERT INTO pro_snapshots (
          pro_call_id, token_id, mc_usd, kol_count, smart_count, intel_score, ath_multiple,
          survival_score, pro_score, quality_label, gain_pct, run_status,
          holder_velocity_score, age_hours,
          holder_count, mc_growth_score, volume_intensity_score, liquidity_usd,
          kol_delta, smart_delta
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
          ${kolDelta}, ${smartDelta}
        )
      `);

      const surfacingNow = (qualityLabel === "good" || qualityLabel === "very_good");
      const surfacedClause = surfacingNow
        ? sql`, surfaced_at = COALESCE(surfaced_at, NOW()), surfaced_mc_usd = COALESCE(surfaced_mc_usd, ${String(r.current_mc ?? "0")})`
        : sql``;

      await db.execute(sql`
        UPDATE pro_calls
        SET
          ath_multiple     = GREATEST(COALESCE(ath_multiple, 1), ${newAth}),
          last_snapshot_at = NOW(),
          pro_score        = ${proScore},
          survival_score   = ${survivalScore},
          last_survival_at = NOW(),
          entry_tier       = ${entryTier},
          score_version    = 'v2',
          quality_label    = CASE
            WHEN ${runStatus} = 'DEAD' AND ${newAth} < 2 THEN ${qualityLabel}
            WHEN quality_label = 'very_good'                        THEN 'very_good'
            WHEN quality_label = 'good' AND ${qualityLabel} = 'very_good' THEN 'very_good'
            WHEN quality_label = 'good' AND ${qualityLabel} = 'below' THEN 'good'
            WHEN quality_label = 'good'                             THEN 'good'
            ELSE ${qualityLabel}
          END
          ${surfacedClause}
          ${sql.join(milestoneParts, sql``)}
        WHERE id = ${r.pro_call_id}
      `);

      snapCount++;
    }

    log.info({ snapCount, mode }, "Pro snapshots written");
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
    "Pro snapshots scheduled (hot 30s <6h / full 2m + survival v2)",
  );
}
