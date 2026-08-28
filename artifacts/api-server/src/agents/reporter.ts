/** REPORTER — ward census, written report, free-tier prune. */
import { pool } from "../core/db";
import { agentNote } from "./log";

const REPORT_EVERY_MS = 90 * 60_000;

export async function reporterTick(): Promise<Record<string, number>> {
  const census = await pool.query(
    `SELECT COALESCE(phase,'intake') AS phase, COUNT(*)::int AS n
     FROM f2_tokens
     WHERE source = 'wallet_buy' OR wallet_buys > 0
     GROUP BY 1`,
  );
  const counts: Record<string, number> = {};
  for (const r of census.rows as Array<{ phase: string; n: number }>) counts[r.phase] = r.n;

  await pool.query(`DELETE FROM f2_journal WHERE at < NOW() - INTERVAL '3 days'`);
  await pool.query(`DELETE FROM ward_agent_log WHERE at < NOW() - INTERVAL '3 days'`);
  await pool.query(
    `DELETE FROM f2_scans WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY at DESC) AS rn
         FROM f2_scans
       ) x WHERE rn > 80
     )`,
  );
  await pool.query(`DELETE FROM ward_alerts WHERE at < NOW() - INTERVAL '14 days'`);
  await pool.query(`DELETE FROM ward_reports WHERE at < NOW() - INTERVAL '14 days'`);

  const live = (counts.ward ?? 0) + (counts.icu ?? 0) + (counts.intake ?? 0)
    + (counts.recovery ?? 0) + (counts.revived ?? 0);
  const dead = counts.deceased ?? 0;
  const survival = live + dead > 0 ? live / (live + dead) : null;

  const trades = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ward_alerts
     WHERE kind = 'trade' AND at > NOW() - INTERVAL '24 hours'`,
  );
  const paper = await pool.query(
    `SELECT
       COUNT(*)::int AS judged,
       COUNT(*) FILTER (
         WHERE t.peak_mc >= NULLIF((a.payload->>'mc')::real, 0) * 2
       )::int AS wins
     FROM ward_alerts a
     JOIN f2_tokens t ON t.id = a.token_id
     WHERE a.kind = 'trade'
       AND a.at < NOW() - INTERVAL '2 hours'
       AND a.at > NOW() - INTERVAL '7 days'`,
  );
  const trades24h = Number(trades.rows[0]?.n ?? 0);
  const paperRow = paper.rows[0] ?? { judged: 0, wins: 0 };
  const detail = [
    `live ${live}`,
    `icu ${counts.icu ?? 0}`,
    `deceased ${dead}`,
    `revived ${counts.revived ?? 0}`,
    survival != null ? `survival ${(survival * 100).toFixed(0)}%` : null,
    `trades24h ${trades24h}`,
    `paper ${paperRow.wins}/${paperRow.judged}`,
  ].filter(Boolean).join(" · ");

  const last = await pool.query("SELECT at FROM ward_reports ORDER BY id DESC LIMIT 1");
  const lastAt = last.rows[0]?.at ? new Date(last.rows[0].at).getTime() : 0;
  if (!lastAt || Date.now() - lastAt > REPORT_EVERY_MS) {
    await pool.query(
      `INSERT INTO ward_reports (census, survival, trades_24h, paper, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [JSON.stringify(counts), survival, trades24h, JSON.stringify(paperRow), detail],
    );
    await agentNote("reporter", "REPORT", detail);
  } else {
    await agentNote("reporter", "CENSUS", detail);
  }
  return counts;
}
