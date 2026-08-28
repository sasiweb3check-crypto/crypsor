/**
 * BACKTEST — judge every locked TRADE against ATH since entry.
 * Win = ATH ≥ 2× entry. Nudge weights from what actually survived.
 */
import { pool } from "../core/db";
import { getWeights, setWeights } from "../scoring/ward";
import { agentNote } from "./log";

export async function backtestTick(): Promise<{ judged: number; wins: number }> {
  const rows = await pool.query(
    `SELECT tr.id, tr.token_id, tr.entry_mc, tr.peak_mc, tr.last_mc, tr.ath_x, tr.gain_x,
            tr.called_at, tr.judged, t.phase
     FROM ward_trades tr
     JOIN f2_tokens t ON t.id = tr.token_id
     WHERE tr.called_at < NOW() - INTERVAL '2 hours'`,
  );

  let wins = 0;
  let judged = 0;
  const failCount: Record<string, { dead: number; live: number }> = {};

  for (const r of rows.rows as Array<{
    id: number; token_id: number; entry_mc: number; peak_mc: number | null;
    last_mc: number | null; ath_x: number | null; judged: boolean; phase: string;
  }>) {
    const entry = Number(r.entry_mc ?? 0);
    const peak = Number(r.peak_mc ?? r.last_mc ?? 0);
    const athX = entry > 0 ? peak / entry : Number(r.ath_x ?? 0);
    const win = athX >= 2;
    judged += 1;
    if (win) wins += 1;

    const scan = await pool.query(
      `SELECT fail_reasons FROM f2_scans WHERE token_id = $1 ORDER BY at DESC LIMIT 1`,
      [r.token_id],
    );
    const fails = Array.isArray(scan.rows[0]?.fail_reasons) ? scan.rows[0].fail_reasons as string[] : [];
    for (const f of fails) {
      failCount[f] ??= { dead: 0, live: 0 };
      if (r.phase === "deceased" || !win) failCount[f].dead += 1;
      else failCount[f].live += 1;
    }

    if (!r.judged) {
      await pool.query(
        `UPDATE ward_trades SET judged = true, extra = COALESCE(extra,'{}'::jsonb) || $2::jsonb WHERE id = $1`,
        [r.id, JSON.stringify({ judged_ath: athX, judged_win: win, judged_at: new Date().toISOString() })],
      );
    }
  }

  const n = judged;
  if (n >= 4) {
    const w = getWeights();
    const wr = wins / n;
    const tapeDead = (failCount.sell_led_tape?.dead ?? 0) + (failCount.tape_two_sided?.dead ?? 0);
    const tapeLive = (failCount.sell_led_tape?.live ?? 0) + (failCount.tape_two_sided?.live ?? 0);
    if (tapeDead > tapeLive) w.tape = (w.tape ?? 1) + 0.03;
    if (wr < 0.25) w.timing = (w.timing ?? 1) + 0.03;
    if ((failCount.liq_drain?.dead ?? 0) > (failCount.liq_drain?.live ?? 0)) {
      w.liquidity = (w.liquidity ?? 1) + 0.03;
    }
    setWeights(w);
    for (const [factor, weight] of Object.entries(getWeights())) {
      await pool.query(
        `INSERT INTO ward_weights (factor, weight, note) VALUES ($1,$2,$3)
         ON CONFLICT (factor) DO UPDATE SET weight = EXCLUDED.weight, updated_at = NOW(), note = EXCLUDED.note`,
        [factor, weight, `n=${n} wins=${wins} wr=${wr.toFixed(2)}`],
      );
    }
  }

  const avg = await pool.query(
    `SELECT AVG(ath_x) AS ath, AVG(gain_x) AS gain, COUNT(*)::int AS n
     FROM ward_trades WHERE ath_x IS NOT NULL`,
  );
  const a = avg.rows[0] ?? {};
  await agentNote(
    "backtest",
    "JUDGE",
    `paper ${wins}/${n} hit 2× · avg ATH ${a.ath != null ? Number(a.ath).toFixed(2) : "—"}× · now ${a.gain != null ? Number(a.gain).toFixed(2) : "—"}×`,
  );
  return { judged: n, wins };
}

export async function loadWeights(): Promise<void> {
  const r = await pool.query("SELECT factor, weight FROM ward_weights");
  if (!r.rows.length) return;
  const w: Record<string, number> = {};
  for (const row of r.rows as Array<{ factor: string; weight: number }>) {
    w[row.factor] = Number(row.weight);
  }
  setWeights(w);
}
