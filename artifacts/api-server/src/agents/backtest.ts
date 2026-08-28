/**
 * BACKTEST / self-improve — paper outcomes on TRADE alerts.
 * Win = peak MC ≥ 2× alert MC within 24h (hospital: the patient lived).
 * Nudge factor weights toward what actually predicted survival.
 */
import { pool } from "../core/db";
import { getWeights, setWeights } from "../scoring/ward";
import { agentNote } from "./log";

export async function backtestTick(): Promise<{ judged: number; wins: number }> {
  const rows = await pool.query(
    `SELECT a.id, a.token_id, a.payload, a.at,
            t.peak_mc, t.admission_mc, t.last_mc, t.phase
     FROM ward_alerts a
     JOIN f2_tokens t ON t.id = a.token_id
     WHERE a.kind = 'trade'
       AND a.at < NOW() - INTERVAL '2 hours'
       AND a.at > NOW() - INTERVAL '7 days'`,
  );

  let wins = 0;
  const n = rows.rows.length;
  const failCount: Record<string, { dead: number; live: number }> = {};

  for (const r of rows.rows as Array<{
    payload: { mc?: number; fails?: string[] } | string | null;
    peak_mc: number | null;
    last_mc: number | null;
    phase: string;
  }>) {
    const payload = typeof r.payload === "string"
      ? JSON.parse(r.payload) as { mc?: number; fails?: string[] }
      : (r.payload ?? {});
    const entry = Number(payload.mc ?? 0);
    const peak = Number(r.peak_mc ?? r.last_mc ?? 0);
    const win = entry > 0 && peak >= entry * 2;
    if (win) wins += 1;
    for (const f of payload.fails ?? []) {
      failCount[f] ??= { dead: 0, live: 0 };
      if (r.phase === "deceased" || !win) failCount[f].dead += 1;
      else failCount[f].live += 1;
    }
  }

  if (n >= 8) {
    const w = getWeights();
    const wr = wins / n;
    // If tape-related fails predicted death, trust tape more.
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

  await agentNote("backtest", "JUDGE", `paper ${wins}/${n} two-x after TRADE`);
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
