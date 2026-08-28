/**
 * Live pass board — SSE payload + REST.
 * Desk only shows names that cleared the gate. Everything else stays in logs.
 */
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { athPct, gainPct, laneOf, rollDays, type DayRoll } from "../scoring/stats";
import { capBand, type CapBand } from "../scoring/quality";
import { isNoiseToken } from "../scoring/noise";
import type { Momentum } from "../scoring/survival";

export type PassCard = {
  id: number;
  token_id: number;
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  passed_at: string;
  pass_mc: number;
  last_mc: number | null;
  peak_mc: number | null;
  gain_x: number | null;
  ath_x: number | null;
  gain_pct: number | null;
  ath_pct: number | null;
  lane: "live" | "archived" | "dead";
  status: string;
  phase: string | null;
  last_liq: number | null;
  wallet_buys: number;
  tape_lead: string | null;
  survival: number | null;
  momentum: Momentum | null;
  band: CapBand | null;
  story: string | null;
};

export type LiveBoard = {
  at: string;
  live: PassCard[];
  archived: PassCard[];
  performers: PassCard[];
  days: DayRoll[];
  census: { tokens: number; passed: number };
  totals: {
    live: number;
    archived: number;
    dead: number;
    passed: number;
    tokens: number;
    avgGainPct: number | null;
    avgAthPct: number | null;
    avgSurvival: number | null;
    hit2x: number;
  };
};

const SELECT = `SELECT tr.id, tr.token_id, tr.entry_mc, tr.called_at, tr.peak_mc, tr.last_mc,
            tr.gain_x, tr.ath_x, tr.gain_pct, tr.ath_pct, tr.status, tr.last_liq,
            t.mint, t.symbol, t.name, t.image, t.wallet_buys, t.phase, t.tape_lead,
            t.survival_score, t.last_momentum, t.last_narrative, t.cap_band
     FROM ward_trades tr
     JOIN f2_tokens t ON t.id = tr.token_id`;

function card(row: Record<string, unknown>): PassCard {
  const passMc = Number(row.entry_mc) || 0;
  const last = row.last_mc != null ? Number(row.last_mc) : null;
  const peak = row.peak_mc != null ? Number(row.peak_mc) : null;
  const g = row.gain_pct != null ? Number(row.gain_pct) : gainPct(last, passMc);
  const a = row.ath_pct != null ? Number(row.ath_pct) : athPct(peak, passMc);
  const status = String(row.status ?? "open");
  const phase = (row.phase as string | null) ?? null;
  return {
    id: Number(row.id),
    token_id: Number(row.token_id),
    mint: String(row.mint),
    symbol: (row.symbol as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    image: (row.image as string | null) ?? null,
    passed_at: new Date(row.called_at as string).toISOString(),
    pass_mc: passMc,
    last_mc: last,
    peak_mc: peak,
    gain_x: row.gain_x != null ? Number(row.gain_x) : (last && passMc ? last / passMc : null),
    ath_x: row.ath_x != null ? Number(row.ath_x) : (peak && passMc ? peak / passMc : null),
    gain_pct: g,
    ath_pct: a,
    lane: laneOf(status, phase),
    status,
    phase,
    last_liq: row.last_liq != null ? Number(row.last_liq) : null,
    wallet_buys: Number(row.wallet_buys ?? 0),
    tape_lead: (row.tape_lead as string | null) ?? null,
    survival: row.survival_score != null ? Number(row.survival_score) : null,
    momentum: (row.last_momentum as Momentum | null) ?? null,
    band: (row.cap_band as CapBand | null) ?? capBand(last),
    story: (row.last_narrative as string | null) ?? null,
  };
}

function uniqueByToken(cards: PassCard[]): PassCard[] {
  const seen = new Set<number>();
  const out: PassCard[] = [];
  for (const c of cards) {
    if (isNoiseToken(c.mint, c.symbol)) continue;
    if (seen.has(c.token_id)) continue;
    seen.add(c.token_id);
    out.push(c);
  }
  return out;
}

export async function rollupDays(): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO ward_day_stats (
         day, passed_n, live_n, archived_n, dead_n,
         avg_gain_pct, avg_ath_pct, hit_2x_n, best_ath_pct, updated_at
       )
       SELECT
         (tr.called_at AT TIME ZONE 'UTC')::date,
         COUNT(*)::int,
         COUNT(*) FILTER (WHERE tr.status IN ('open','trim') AND COALESCE(t.phase,'ward') <> 'deceased')::int,
         COUNT(*) FILTER (WHERE tr.status = 'exit')::int,
         COUNT(*) FILTER (WHERE tr.status = 'dead' OR t.phase = 'deceased')::int,
         AVG(tr.gain_pct),
         AVG(tr.ath_pct),
         COUNT(*) FILTER (WHERE COALESCE(tr.ath_pct,0) >= 100)::int,
         MAX(tr.ath_pct),
         NOW()
       FROM ward_trades tr
       JOIN f2_tokens t ON t.id = tr.token_id
       GROUP BY 1
       ON CONFLICT (day) DO UPDATE SET
         passed_n = EXCLUDED.passed_n,
         live_n = EXCLUDED.live_n,
         archived_n = EXCLUDED.archived_n,
         dead_n = EXCLUDED.dead_n,
         avg_gain_pct = EXCLUDED.avg_gain_pct,
         avg_ath_pct = EXCLUDED.avg_ath_pct,
         hit_2x_n = EXCLUDED.hit_2x_n,
         best_ath_pct = EXCLUDED.best_ath_pct,
         updated_at = NOW()`,
    );
  } catch {
    // table lands on first schema pass
  }
}

export async function buildLiveBoard(): Promise<LiveBoard> {
  const live = await pool.query(
    `${SELECT}
     WHERE tr.status IN ('open','trim') AND COALESCE(t.phase,'ward') <> 'deceased'
     ORDER BY tr.called_at DESC
     LIMIT 80`,
  );
  const archived = await pool.query(
    `${SELECT}
     WHERE tr.status IN ('dead','exit') OR t.phase = 'deceased'
     ORDER BY COALESCE(tr.closed_at, tr.called_at) DESC
     LIMIT 80`,
  );
  const dayRows = await pool.query(
    `SELECT (tr.called_at AT TIME ZONE 'UTC')::date::text AS day,
            tr.status, t.phase, tr.gain_pct, tr.ath_pct
     FROM ward_trades tr
     JOIN f2_tokens t ON t.id = tr.token_id
     WHERE tr.called_at > NOW() - INTERVAL '21 days'`,
  );
  let days: DayRoll[] = rollDays(dayRows.rows as Array<{
    day: string; status: string; phase: string | null; gain_pct: number | null; ath_pct: number | null;
  }>);
  try {
    const stored = await pool.query(
      `SELECT day::text, passed_n, live_n, archived_n, dead_n,
              avg_gain_pct, avg_ath_pct, hit_2x_n, best_ath_pct
       FROM ward_day_stats
       ORDER BY day DESC
       LIMIT 21`,
    );
    if (stored.rows.length) {
      days = stored.rows.map((r: {
        day: string; passed_n: number; live_n: number; archived_n: number; dead_n: number;
        avg_gain_pct: number | null; avg_ath_pct: number | null; hit_2x_n: number; best_ath_pct: number | null;
      }) => ({
        day: String(r.day).slice(0, 10),
        passed: Number(r.passed_n),
        live: Number(r.live_n),
        archived: Number(r.archived_n),
        dead: Number(r.dead_n),
        avgGainPct: r.avg_gain_pct != null ? Number(r.avg_gain_pct) : null,
        avgAthPct: r.avg_ath_pct != null ? Number(r.avg_ath_pct) : null,
        hit2x: Number(r.hit_2x_n),
        bestAthPct: r.best_ath_pct != null ? Number(r.best_ath_pct) : null,
      }));
    }
  } catch {
    // use rolled days
  }

  const liveCards = uniqueByToken(live.rows.map((r) => card(r as Record<string, unknown>)));
  const archCards = uniqueByToken(archived.rows.map((r) => card(r as Record<string, unknown>)));
  const allPct = [...liveCards, ...archCards];
  const gains = allPct.map((c) => c.gain_pct).filter((n): n is number => n != null);
  const aths = allPct.map((c) => c.ath_pct).filter((n): n is number => n != null);
  const survs = allPct.map((c) => c.survival).filter((n): n is number => n != null);
  const performers = [...liveCards]
    .sort((a, b) => (b.ath_pct ?? -999) - (a.ath_pct ?? -999))
    .slice(0, 8);

  let tokens = 0;
  let passedN = liveCards.length + archCards.length;
  try {
    const cen = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM f2_tokens WHERE source = 'wallet_buy' OR wallet_buys > 0) AS tokens,
         (SELECT COUNT(*)::int FROM ward_trades) AS passed`,
    );
    tokens = Number(cen.rows[0]?.tokens ?? 0);
    passedN = Number(cen.rows[0]?.passed ?? passedN);
  } catch {
    // first boot
  }

  return {
    at: new Date().toISOString(),
    live: liveCards,
    archived: archCards,
    performers,
    days,
    census: { tokens, passed: passedN },
    totals: {
      live: liveCards.length,
      archived: archCards.filter((c) => c.lane === "archived").length,
      dead: archCards.filter((c) => c.lane === "dead").length,
      passed: passedN,
      tokens,
      avgGainPct: gains.length ? gains.reduce((s, n) => s + n, 0) / gains.length : null,
      avgAthPct: aths.length ? aths.reduce((s, n) => s + n, 0) / aths.length : null,
      avgSurvival: survs.length ? survs.reduce((s, n) => s + n, 0) / survs.length : null,
      hit2x: aths.filter((n) => n >= 100).length,
    },
  };
}

export async function emitLiveStats(): Promise<LiveBoard | null> {
  try {
    const board = await buildLiveBoard();
    emitSse("stats:live", board);
    return board;
  } catch {
    return null;
  }
}

/** Freeze a fresh print onto the pass row so the board is never a stale cache. */
export async function syncPassPrint(
  tokenId: number,
  lastMc: number | null,
  lastLiq: number | null,
): Promise<void> {
  if (lastMc == null || lastMc <= 0) return;
  await pool.query(
    `UPDATE ward_trades SET
       last_mc = $2,
       last_liq = COALESCE($3, last_liq),
       peak_mc = GREATEST(COALESCE(peak_mc, 0), $2),
       peak_at = CASE WHEN $2 > COALESCE(peak_mc, 0) THEN NOW() ELSE peak_at END,
       gain_x = CASE WHEN entry_mc > 0 THEN $2 / entry_mc ELSE gain_x END,
       ath_x = CASE WHEN entry_mc > 0 THEN GREATEST(COALESCE(peak_mc, 0), $2) / entry_mc ELSE ath_x END,
       gain_pct = CASE WHEN entry_mc > 0 THEN (($2 / entry_mc) - 1) * 100 ELSE gain_pct END,
       ath_pct = CASE WHEN entry_mc > 0 THEN ((GREATEST(COALESCE(peak_mc, 0), $2) / entry_mc) - 1) * 100 ELSE ath_pct END
     WHERE token_id = $1`,
    [tokenId, lastMc, lastLiq],
  );
}

export async function passesOnDay(day: string): Promise<PassCard[]> {
  const r = await pool.query(
    `${SELECT}
     WHERE (tr.called_at AT TIME ZONE 'UTC')::date = $1::date
     ORDER BY tr.called_at DESC
     LIMIT 80`,
    [day],
  );
  return uniqueByToken(r.rows.map((row) => card(row as Record<string, unknown>)));
}
