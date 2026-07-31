/**
 * Pro Scanner
 *
 * Identifies tokens that qualify for the Pro Caller tier and registers them
 * in `pro_calls` (one record per token, never duplicated).
 *
 * On-time path (Jul 2026 fix):
 *   Median detect→call was ~25 min and call→surface ~25h because intel + scanner
 *   + snapshots all ran on 5-minute clocks. Now:
 *     • intel:scored event → immediate scan for that token
 *     • 60s backup scanner cycle
 *     • On INSERT: compute Pro Score v2 + set quality_label + surfaced_at NOW
 *       (do not wait for the snapshot worker to make the token visible)
 *
 * Qualification tracks
 * ────────────────────
 *  VERY STRONG  (scanner_label = 'very_strong')
 *    Track A: intelligence_score >= 80 + KOL/Smart >= 1 + MC >= $5K
 *    Track B: intelligence_score >= 75 + KOL >= 2  + MC >= $5K
 *
 *  STRONG       (scanner_label = 'strong')
 *    Track C: intelligence_score >= 80 + KOL = 0   + MC >= $5K
 *             Auto-upgraded once KOL/Smart arrives.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus, type IntelScoredEvent } from "./event-bus";
import { pipelineQueue } from "../lib/job-queue";
import {
  computeProScore,
  deriveRunStatus,
  type EntryTier,
} from "../lib/pro-scoring";

const log = logger.child({ module: "pro-scanner" });

const SCAN_INTERVAL_MS = 60_000;       // was 5 min — backup catch-up
const STARTUP_DELAY_MS = 12_000;

const MIN_INTEL = 80;
const MIN_INTEL_STRONG_KOL = 75;
const MIN_KOL_STRONG = 2;
const MIN_MC = 5_000;

// ── Step 0: backfill KOL/smart counts in intel log ───────────────────────────

async function backfillKolSmartCounts(): Promise<void> {
  try {
    const result = await db.execute(sql`
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
        AND l.intelligence_score >= ${MIN_INTEL}
    `);
    const updated = Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
    if (updated > 0) {
      log.info({ updated }, "KOL/smart backfill: intel log entries updated");
    }
  } catch (err) {
    log.warn({ err }, "KOL/smart backfill error (non-fatal)");
  }
}

// ── Immediate Pro Score v2 + surface for newly inserted / unscored calls ─────

async function scoreAndSurfacePending(tokenId?: number): Promise<number> {
  try {
    const rows = await db.execute(sql`
      SELECT
        pc.id AS pro_call_id,
        pc.token_id,
        pc.called_at,
        pc.called_mc_usd,
        pc.called_intel_score,
        pc.called_kol_count,
        pc.called_smart_count,
        pc.called_holder_velocity,
        pc.called_mc_growth,
        pc.called_volume_intensity,
        pc.ath_multiple,
        pc.quality_label,
        pc.surfaced_at,
        t.market_cap_usd AS current_mc,
        t.ath_market_cap_usd AS ath_mc_usd,
        t.liquidity_usd,
        t.holder_velocity_score,
        t.sec_is_honeypot,
        t.sec_mint_renounced,
        t.sec_freeze_renounced,
        t.sec_top10_holder_rate,
        t.sec_lp_locked,
        t.sec_rat_trader_amt_rate
      FROM pro_calls pc
      JOIN tracked_tokens t ON t.id = pc.token_id
      WHERE (pc.pro_score IS NULL OR pc.score_version IS DISTINCT FROM 'v2'
             OR pc.quality_label IS NULL OR pc.surfaced_at IS NULL)
        ${tokenId ? sql`AND pc.token_id = ${tokenId}` : sql``}
      ORDER BY pc.called_at DESC
      LIMIT ${tokenId ? 1 : 80}
    `);

    let n = 0;
    for (const r of rows.rows as Array<Record<string, unknown>>) {
      const calledMc = parseFloat(String(r.called_mc_usd ?? "0")) || 0;
      const currentMc = parseFloat(String(r.current_mc ?? "0")) || 0;
      const athMc = parseFloat(String(r.ath_mc_usd ?? "0")) || currentMc;
      const prevAth = Number(r.ath_multiple ?? 1) || 1;
      const athFromPipeline = calledMc > 0 ? athMc / calledMc : 1;
      const athMultiple = Math.max(prevAth, calledMc > 0 ? currentMc / calledMc : 1, athFromPipeline);
      const gainPct = calledMc > 0 ? ((currentMc - calledMc) / calledMc) * 100 : 0;
      const ageHours = r.called_at
        ? (Date.now() - new Date(String(r.called_at)).getTime()) / 3_600_000
        : 0;
      const runStatus = deriveRunStatus(currentMc || null, calledMc || null, athMultiple);

      const result = computeProScore({
        calledIntelScore: Number(r.called_intel_score ?? 60),
        calledKolCount: Number(r.called_kol_count ?? 0),
        calledSmartCount: Number(r.called_smart_count ?? 0),
        calledMcUsd: calledMc || null,
        calledHolderVelocity: r.called_holder_velocity != null ? Number(r.called_holder_velocity) : null,
        calledMcGrowth: r.called_mc_growth != null ? Number(r.called_mc_growth) : null,
        calledVolumeIntensity: r.called_volume_intensity != null ? Number(r.called_volume_intensity) : null,
        currentMcUsd: currentMc || null,
        athMultiple,
        gainSinceCall: gainPct,
        runStatus,
        liquidityUsd: parseFloat(String(r.liquidity_usd ?? "0")) || null,
        ageHoursSinceCall: ageHours,
        holderVelocityScore: r.holder_velocity_score != null ? Number(r.holder_velocity_score) : null,
        secIsHoneypot: r.sec_is_honeypot as boolean | null,
        secMintRenounced: r.sec_mint_renounced as boolean | null,
        secFreezeRenounced: r.sec_freeze_renounced as boolean | null,
        secTop10HolderRate: r.sec_top10_holder_rate != null ? Number(r.sec_top10_holder_rate) : null,
        secLpLocked: r.sec_lp_locked as boolean | null,
        secRatTraderAmtRate: r.sec_rat_trader_amt_rate != null ? Number(r.sec_rat_trader_amt_rate) : null,
      });

      const qualityLabel = result.qualityLabel;
      const surfacingNow = qualityLabel === "good" || qualityLabel === "very_good";
      const entryTier: EntryTier = result.entryTier;

      await db.execute(sql`
        UPDATE pro_calls
        SET
          ath_multiple = GREATEST(COALESCE(ath_multiple, 1), ${athMultiple}),
          pro_score = ${result.score},
          survival_score = ${result.survivalScore},
          last_survival_at = NOW(),
          entry_tier = ${entryTier},
          score_version = 'v2',
          quality_label = CASE
            WHEN ${runStatus} = 'DEAD' AND ${athMultiple} < 2 THEN ${qualityLabel}
            WHEN quality_label = 'very_good' THEN 'very_good'
            WHEN quality_label = 'good' AND ${qualityLabel} = 'very_good' THEN 'very_good'
            WHEN quality_label = 'good' AND ${qualityLabel} = 'below' THEN 'good'
            WHEN quality_label = 'good' THEN 'good'
            ELSE ${qualityLabel}
          END,
          surfaced_at = CASE
            WHEN ${surfacingNow} THEN COALESCE(surfaced_at, NOW())
            ELSE surfaced_at
          END,
          surfaced_mc_usd = CASE
            WHEN ${surfacingNow} THEN COALESCE(surfaced_mc_usd, ${String(currentMc || calledMc || 0)})
            ELSE surfaced_mc_usd
          END
        WHERE id = ${Number(r.pro_call_id)}
      `);
      n++;
    }
    return n;
  } catch (err) {
    log.warn({ err }, "scoreAndSurfacePending error (non-fatal)");
    return 0;
  }
}

async function insertVeryStrong(onlyTokenId?: number): Promise<number> {
  try {
    const result = await db.execute(sql`
      INSERT INTO pro_calls (
        token_id,
        called_at,
        called_mc_usd,
        called_intel_score,
        called_kol_count,
        called_smart_count,
        called_kol_smart_score,
        called_holder_velocity,
        called_mc_growth,
        called_volume_intensity,
        scanner_label,
        score_version
      )
      SELECT DISTINCT ON (l.token_id)
        l.token_id,
        l.computed_at                    AS called_at,
        l.market_cap_usd                 AS called_mc_usd,
        l.intelligence_score             AS called_intel_score,
        l.holder_kol_count               AS called_kol_count,
        l.holder_smart_count             AS called_smart_count,
        l.kol_smart_score                AS called_kol_smart_score,
        l.holder_velocity_score          AS called_holder_velocity,
        l.mc_growth_score                AS called_mc_growth,
        l.volume_intensity_score         AS called_volume_intensity,
        'very_strong'                    AS scanner_label,
        'v2'                             AS score_version
      FROM token_intel_log l
      WHERE (
        (
          l.intelligence_score        >= ${MIN_INTEL}
          AND (l.holder_kol_count >= 1 OR l.holder_smart_count >= 1)
        )
        OR
        (
          l.intelligence_score        >= ${MIN_INTEL_STRONG_KOL}
          AND l.holder_kol_count      >= ${MIN_KOL_STRONG}
        )
      )
        AND l.market_cap_usd::numeric   >= ${MIN_MC}
        AND l.market_cap_usd::numeric   <= 500000
        AND l.status_after IN ('new', 'active', 'watch')
        AND NOT EXISTS (
          SELECT 1 FROM pro_calls pc WHERE pc.token_id = l.token_id
        )
        ${onlyTokenId ? sql`AND l.token_id = ${onlyTokenId}` : sql``}
      ORDER BY l.token_id, l.computed_at ASC
      ON CONFLICT (token_id) DO NOTHING
    `);
    return Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
  } catch (err) {
    log.error({ err }, "Pro scanner: very_strong INSERT error");
    return 0;
  }
}

async function upgradeStrongToVeryStrong(): Promise<number> {
  try {
    const result = await db.execute(sql`
      UPDATE pro_calls pc
      SET
        scanner_label      = 'very_strong',
        called_kol_count   = GREATEST(pc.called_kol_count,   t.holder_kol_count),
        called_smart_count = GREATEST(pc.called_smart_count, t.holder_smart_count)
      FROM tracked_tokens t
      WHERE pc.token_id = t.id
        AND pc.scanner_label = 'strong'
        AND (t.holder_kol_count >= 1 OR t.holder_smart_count >= 1)
    `);
    return Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
  } catch (err) {
    log.warn({ err }, "Pro scanner: strong→very_strong upgrade error (non-fatal)");
    return 0;
  }
}

async function insertStrong(onlyTokenId?: number): Promise<number> {
  try {
    const result = await db.execute(sql`
      INSERT INTO pro_calls (
        token_id,
        called_at,
        called_mc_usd,
        called_intel_score,
        called_kol_count,
        called_smart_count,
        called_kol_smart_score,
        called_holder_velocity,
        called_mc_growth,
        called_volume_intensity,
        scanner_label,
        score_version
      )
      SELECT DISTINCT ON (l.token_id)
        l.token_id,
        l.computed_at                    AS called_at,
        l.market_cap_usd                 AS called_mc_usd,
        l.intelligence_score             AS called_intel_score,
        COALESCE(l.holder_kol_count, 0)  AS called_kol_count,
        COALESCE(l.holder_smart_count,0) AS called_smart_count,
        l.kol_smart_score                AS called_kol_smart_score,
        l.holder_velocity_score          AS called_holder_velocity,
        l.mc_growth_score                AS called_mc_growth,
        l.volume_intensity_score         AS called_volume_intensity,
        'strong'                         AS scanner_label,
        'v2'                             AS score_version
      FROM token_intel_log l
      WHERE l.intelligence_score        >= ${MIN_INTEL}
        AND (l.holder_kol_count  IS NULL OR l.holder_kol_count  = 0)
        AND (l.holder_smart_count IS NULL OR l.holder_smart_count = 0)
        AND l.market_cap_usd::numeric   >= ${MIN_MC}
        AND l.market_cap_usd::numeric   <= 500000
        AND l.status_after IN ('new', 'active', 'watch')
        AND NOT EXISTS (
          SELECT 1 FROM pro_calls pc WHERE pc.token_id = l.token_id
        )
        ${onlyTokenId ? sql`AND l.token_id = ${onlyTokenId}` : sql``}
      ORDER BY l.token_id, l.computed_at ASC
      ON CONFLICT (token_id) DO NOTHING
    `);
    return Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
  } catch (err) {
    log.error({ err }, "Pro scanner: strong INSERT error");
    return 0;
  }
}

async function scanOnce(onlyTokenId?: number): Promise<void> {
  if (!onlyTokenId) {
    await backfillKolSmartCounts();
  }

  const veryStrongInserted = await insertVeryStrong(onlyTokenId);
  const upgraded = await upgradeStrongToVeryStrong();
  const strongInserted = await insertStrong(onlyTokenId);
  const scored = await scoreAndSurfacePending(onlyTokenId);

  if (veryStrongInserted > 0 || upgraded > 0 || strongInserted > 0 || scored > 0) {
    log.info(
      { veryStrongInserted, upgraded, strongInserted, scored, onlyTokenId: onlyTokenId ?? null },
      "Pro scanner cycle complete",
    );
  }
}

export function startProScanner(): void {
  pipelineQueue.register<{ tokenId?: number }>("pro", async (data) => {
    await scanOnce(data.tokenId);
  });

  // Event-driven: react within seconds when intel crosses the gate
  eventBus.on("intel:scored", (e: IntelScoredEvent) => {
    if (e.intelligenceScore < MIN_INTEL_STRONG_KOL) return;
    const mc = e.marketCapUsd ? parseFloat(e.marketCapUsd) : 0;
    if (mc > 0 && mc < MIN_MC) return;
    pipelineQueue.enqueue(
      "pro",
      { tokenId: e.tokenId },
      { priority: 12, dedupKey: `pro:${e.tokenId}`, delayMs: 200 },
    );
  });

  setTimeout(async () => {
    await scanOnce();
    setInterval(() => {
      pipelineQueue.enqueue("pro", {}, { priority: 5, dedupKey: "pro:full-cycle" });
    }, SCAN_INTERVAL_MS);
  }, STARTUP_DELAY_MS);

  log.info(
    { delayMs: STARTUP_DELAY_MS, intervalMs: SCAN_INTERVAL_MS },
    "Pro scanner scheduled (event-driven + 60s backup | immediate v2 score+surface on call)",
  );
}
