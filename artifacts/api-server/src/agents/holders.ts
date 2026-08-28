/** HOLDER QUALITY agent — GMGN intel, rate-limited for free-tier. */
import { pool } from "../core/db";
import { tokenIntel } from "../sources/gmgn";
import { agentNote } from "./log";

const BUDGET = 4;

export async function holdersTick(): Promise<{ refreshed: number }> {
  const due = await pool.query(
    `SELECT id, mint, symbol, last_scan_at
     FROM f2_tokens
     WHERE COALESCE(phase, 'intake') IN ('intake','ward','icu','recovery','revived')
     ORDER BY CASE COALESCE(phase,'intake') WHEN 'icu' THEN 0 WHEN 'intake' THEN 1 ELSE 2 END,
              last_scan_at ASC NULLS FIRST
     LIMIT ${BUDGET}`,
  );
  let refreshed = 0;
  for (const row of due.rows as Array<{ id: number; mint: string; symbol: string | null }>) {
    const intel = await tokenIntel(row.mint);
    if (!intel) continue;
    await pool.query(
      `UPDATE f2_tokens SET last_holders = COALESCE($2, last_holders) WHERE id = $1`,
      [row.id, intel.holderCount],
    );
    await pool.query(
      `UPDATE f2_scans SET
         holders = COALESCE($2, holders),
         top10_pct = COALESCE($3, top10_pct),
         bundler_pct = COALESCE($4, bundler_pct),
         sniper_pct = COALESCE($5, sniper_pct),
         bot_pct = COALESCE($6, bot_pct),
         smart_count = COALESCE($7, smart_count),
         kol_count = COALESCE($8, kol_count),
         whale_pct = COALESCE($9, whale_pct)
       WHERE id = (SELECT id FROM f2_scans WHERE token_id = $1 ORDER BY at DESC LIMIT 1)`,
      [
        row.id, intel.holderCount, intel.top10Pct, intel.bundlerHoldPct,
        intel.sniperHoldPct, intel.botHoldPct, intel.smartCount, intel.kolCount,
        intel.whaleHoldPct,
      ],
    );
    refreshed += 1;
    const ticker = row.symbol || row.mint.slice(0, 6);
    await agentNote(
      "holders",
      "READ",
      `$${ticker} holders ${intel.holderCount ?? "—"} · top10 ${intel.top10Pct?.toFixed(0) ?? "—"}% · smart ${intel.smartCount ?? 0}`,
      { tokenId: row.id, mint: row.mint },
    );
  }
  return { refreshed };
}
