/** REPORTER — ward census + prune stale deceased journals (free-tier disk). */
import { pool } from "../core/db";
import { agentNote } from "./log";

export async function reporterTick(): Promise<Record<string, number>> {
  const census = await pool.query(
    `SELECT COALESCE(phase,'intake') AS phase, COUNT(*)::int AS n
     FROM f2_tokens
     WHERE source = 'wallet_buy' OR wallet_buys > 0
     GROUP BY 1`,
  );
  const counts: Record<string, number> = {};
  for (const r of census.rows as Array<{ phase: string; n: number }>) counts[r.phase] = r.n;

  await pool.query(
    `DELETE FROM f2_journal WHERE at < NOW() - INTERVAL '3 days'`,
  );
  await pool.query(
    `DELETE FROM ward_agent_log WHERE at < NOW() - INTERVAL '3 days'`,
  );
  await pool.query(
    `DELETE FROM f2_scans WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY at DESC) AS rn
         FROM f2_scans
       ) x WHERE rn > 80
     )`,
  );
  await pool.query(
    `DELETE FROM ward_alerts WHERE at < NOW() - INTERVAL '14 days'`,
  );

  const live = (counts.ward ?? 0) + (counts.icu ?? 0) + (counts.intake ?? 0)
    + (counts.recovery ?? 0) + (counts.revived ?? 0);
  await agentNote(
    "reporter",
    "CENSUS",
    `live ${live} · icu ${counts.icu ?? 0} · deceased ${counts.deceased ?? 0} · revived ${counts.revived ?? 0}`,
  );
  return counts;
}
