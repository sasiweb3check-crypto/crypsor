/**
 * Pro Snapshots
 *
 * Every 5 minutes, takes a lightweight snapshot of all pro-called tokens
 * by reading their current state from `tracked_tokens` (maintained by the
 * existing pipeline — no extra API calls).
 *
 * Also:
 *   • Updates `pro_calls.ath_multiple` with the running max
 *   • Computes and stores the Pro Score + quality label on every cycle
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { computeProScore, deriveRunStatus } from "../lib/pro-scoring";

const log = logger.child({ module: "pro-snapshots" });

const SNAP_INTERVAL_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 40_000;

async function snapshotOnce(): Promise<void> {
  try {
    const rows = await db.execute(sql`
      SELECT
        pc.id                        AS pro_call_id,
        pc.token_id,
        pc.called_mc_usd,
        pc.ath_multiple              AS prev_ath,
        pc.called_intel_score,
        pc.called_kol_count,
        pc.called_smart_count,
        t.market_cap_usd             AS current_mc,
        t.holder_kol_count           AS kol_count,
        t.holder_smart_count         AS smart_count,
        t.intelligence_score         AS intel_score,
        t.liquidity_usd,
        t.sec_is_honeypot,
        t.sec_mint_renounced,
        t.sec_freeze_renounced,
        t.sec_top10_holder_rate,
        t.sec_lp_locked,
        t.sec_rat_trader_amt_rate
      FROM pro_calls pc
      JOIN tracked_tokens t ON t.id = pc.token_id
    `);

    if (rows.rows.length === 0) return;

    type Row = {
      pro_call_id: number; token_id: number;
      called_mc_usd: string | null; prev_ath: number | null;
      called_intel_score: number | null;
      called_kol_count: number | null; called_smart_count: number | null;
      current_mc: string | null; kol_count: number | null;
      smart_count: number | null; intel_score: number | null;
      liquidity_usd: string | null;
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
      const multiple  = calledMc > 0 ? currentMc / calledMc : 1;
      const newAth    = Math.max(r.prev_ath ?? 1, multiple);
      const gainPct   = calledMc > 0 ? ((currentMc - calledMc) / calledMc) * 100 : 0;
      const liquidityUsd = parseFloat(r.liquidity_usd ?? "0") || 0;

      const runStatus = deriveRunStatus(currentMc || null, calledMc || null, newAth);

      // Compute Pro Score
      const { score: proScore, qualityLabel } = computeProScore({
        calledIntelScore:     r.called_intel_score,
        calledKolCount:       r.called_kol_count ?? 0,
        calledSmartCount:     r.called_smart_count ?? 0,
        calledMcUsd:          calledMc || null,
        currentMcUsd:         currentMc || null,
        athMultiple:          newAth,
        gainSinceCall:        gainPct,
        runStatus,
        liquidityUsd:         liquidityUsd || null,
        secIsHoneypot:        r.sec_is_honeypot,
        secMintRenounced:     r.sec_mint_renounced,
        secFreezeRenounced:   r.sec_freeze_renounced,
        secTop10HolderRate:   r.sec_top10_holder_rate,
        secLpLocked:          r.sec_lp_locked,
        secRatTraderAmtRate:  r.sec_rat_trader_amt_rate,
      });

      // Insert snapshot row
      await db.execute(sql`
        INSERT INTO pro_snapshots (pro_call_id, token_id, mc_usd, kol_count, smart_count, intel_score, ath_multiple)
        VALUES (
          ${r.pro_call_id}, ${r.token_id},
          ${r.current_mc ?? null},
          ${r.kol_count ?? 0}, ${r.smart_count ?? 0},
          ${r.intel_score ?? null}, ${multiple}
        )
      `);

      // Update running ATH + pro_score + quality_label
      await db.execute(sql`
        UPDATE pro_calls
        SET
          ath_multiple   = GREATEST(COALESCE(ath_multiple, 1), ${newAth}),
          last_snapshot_at = NOW(),
          pro_score      = ${proScore},
          quality_label  = ${qualityLabel}
        WHERE id = ${r.pro_call_id}
      `);

      snapCount++;
    }

    log.info({ snapCount }, "Pro snapshots written");
  } catch (err) {
    log.error({ err }, "Pro snapshots error");
  }
}

export function startProSnapshots(): void {
  setTimeout(async () => {
    await snapshotOnce();
    setInterval(snapshotOnce, SNAP_INTERVAL_MS);
  }, STARTUP_DELAY_MS);

  log.info({ delayMs: STARTUP_DELAY_MS, intervalMs: SNAP_INTERVAL_MS }, "Pro snapshots scheduled");
}
