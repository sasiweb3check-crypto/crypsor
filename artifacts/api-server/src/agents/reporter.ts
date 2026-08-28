/** REPORTER — ward census, snapshot report, free-tier prune. */
import { pool } from "../core/db";
import { agentNote } from "./log";
import type { Suggestion } from "../scoring/quality";

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
  try {
    await pool.query(`DELETE FROM ward_source_reads WHERE at < NOW() - INTERVAL '3 days'`);
    await pool.query(
      `DELETE FROM ward_snapshots WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY at DESC) AS rn
           FROM ward_snapshots
         ) x WHERE rn > 80
       )`,
    );
  } catch {
    // tables land on first schema pass
  }

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

  let quality: Record<string, unknown> = {};
  let suggestions: Suggestion[] = [];
  try {
    const src = await pool.query(
      `SELECT source,
              COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE ok)::int AS ok,
              AVG(latency_ms) FILTER (WHERE ok) AS avg_ms
       FROM ward_source_reads
       WHERE at > NOW() - INTERVAL '6 hours'
       GROUP BY source`,
    );
    const bands = await pool.query(
      `SELECT COALESCE(cap_band,'unknown') AS band, COUNT(*)::int AS n,
              AVG(last_quality) AS q
       FROM f2_tokens
       WHERE (source = 'wallet_buy' OR wallet_buys > 0)
         AND COALESCE(phase,'intake') <> 'deceased'
       GROUP BY 1`,
    );
    const snaps = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ward_snapshots WHERE at > NOW() - INTERVAL '6 hours'`,
    );
    quality = {
      sources: src.rows,
      bands: bands.rows,
      snapshots6h: Number(snaps.rows[0]?.n ?? 0),
    };

    const recent = await pool.query(
      `SELECT suggestions FROM ward_snapshots
       WHERE at > NOW() - INTERVAL '3 hours' AND suggestions IS NOT NULL
       ORDER BY at DESC LIMIT 80`,
    );
    const tally = new Map<string, { sugg: Suggestion; n: number }>();
    for (const row of recent.rows as Array<{ suggestions: Suggestion[] | string }>) {
      const list = Array.isArray(row.suggestions)
        ? row.suggestions
        : (typeof row.suggestions === "string" ? JSON.parse(row.suggestions) as Suggestion[] : []);
      for (const s of list) {
        if (!s?.id) continue;
        const prev = tally.get(s.id);
        if (prev) prev.n += 1;
        else tally.set(s.id, { sugg: s, n: 1 });
      }
    }
    suggestions = [...tally.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 6)
      .map(({ sugg, n }) => ({ ...sugg, body: `${sugg.body} (${n} patient${n === 1 ? "" : "s"} in 3h)` }));
  } catch {
    quality = {};
  }

  const bandBits = Array.isArray((quality as { bands?: Array<{ band: string; n: number }> }).bands)
    ? (quality as { bands: Array<{ band: string; n: number }> }).bands
      .map((b) => `${b.band} ${b.n}`)
      .join(" · ")
    : "";
  const detail = [
    `live ${live}`,
    `icu ${counts.icu ?? 0}`,
    `deceased ${dead}`,
    `revived ${counts.revived ?? 0}`,
    survival != null ? `survival ${(survival * 100).toFixed(0)}%` : null,
    `trades24h ${trades24h}`,
    `paper ${paperRow.wins}/${paperRow.judged}`,
    bandBits || null,
    suggestions[0] ? `suggest ${suggestions[0].title}` : null,
  ].filter(Boolean).join(" · ");

  const last = await pool.query("SELECT at FROM ward_reports ORDER BY id DESC LIMIT 1");
  const lastAt = last.rows[0]?.at ? new Date(last.rows[0].at).getTime() : 0;
  if (!lastAt || Date.now() - lastAt > REPORT_EVERY_MS) {
    await pool.query(
      `INSERT INTO ward_reports (census, survival, trades_24h, paper, detail, suggestions, quality)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        JSON.stringify(counts), survival, trades24h, JSON.stringify(paperRow), detail,
        JSON.stringify(suggestions), JSON.stringify(quality),
      ],
    );
    await agentNote("reporter", "REPORT", detail);
  } else {
    await agentNote("reporter", "CENSUS", detail);
  }
  return counts;
}
