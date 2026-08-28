/**
 * BOOK — locked TRADE positions. Entry MC is frozen on first alert.
 * Snapshots drive the exit plan. Alerts fire only when the plan changes.
 */
import { pool } from "../core/db";
import { planExit } from "../scoring/exit";
import { agentNote } from "./log";
import { raiseAlert } from "./alerts";

export async function lockTrade(opts: {
  tokenId: number;
  mint: string;
  symbol: string;
  alertId?: number | null;
  entryMc: number;
  entryLiq: number | null;
  entryHolders: number | null;
  entryScore: number | null;
}): Promise<boolean> {
  if (!opts.entryMc || opts.entryMc <= 0) return false;
  const ins = await pool.query(
    `INSERT INTO ward_trades (
       token_id, alert_id, entry_mc, entry_liq, entry_holders, entry_score,
       peak_mc, last_mc, last_liq, last_holders, status, exit_action, exit_title, extra
     ) VALUES ($1,$2,$3,$4,$5,$6,$3,$3,$4,$5,'open','hold','Hold the lock',$7)
     ON CONFLICT (token_id) DO NOTHING
     RETURNING id`,
    [
      opts.tokenId, opts.alertId ?? null, opts.entryMc, opts.entryLiq,
      opts.entryHolders, opts.entryScore,
      JSON.stringify({ mint: opts.mint, symbol: opts.symbol }),
    ],
  );
  return Boolean(ins.rows[0]);
}

export async function seedTradesFromAlerts(): Promise<number> {
  const r = await pool.query(
    `INSERT INTO ward_trades (
       token_id, alert_id, entry_mc, entry_liq, entry_holders, entry_score,
       called_at, peak_mc, last_mc, last_liq, last_holders, status, extra
     )
     SELECT DISTINCT ON (a.token_id)
       a.token_id, a.id,
       COALESCE(NULLIF((a.payload->>'mc')::real, 0), t.last_mc, t.admission_mc, 0),
       NULLIF((a.payload->>'liq')::real, 0),
       NULLIF((a.payload->>'holders')::real, 0)::int,
       NULLIF((a.payload->>'score')::real, 0)::int,
       a.at,
       GREATEST(t.peak_mc, t.last_mc, COALESCE(NULLIF((a.payload->>'mc')::real, 0), 0)),
       t.last_mc,
       t.last_liq,
       t.last_holders,
       CASE WHEN t.phase = 'deceased' THEN 'dead' ELSE 'open' END,
       jsonb_build_object('mint', t.mint, 'symbol', t.symbol, 'seeded', true)
     FROM ward_alerts a
     JOIN f2_tokens t ON t.id = a.token_id
     WHERE a.kind = 'trade'
       AND COALESCE(NULLIF((a.payload->>'mc')::real, 0), t.last_mc, 0) > 0
     ORDER BY a.token_id, a.at ASC
     ON CONFLICT (token_id) DO NOTHING`,
  );
  return r.rowCount ?? 0;
}

export async function bookTick(): Promise<{ open: number; changed: number }> {
  await seedTradesFromAlerts();
  const due = await pool.query(
    `SELECT tr.id, tr.token_id, tr.entry_mc, tr.peak_mc, tr.status, tr.exit_action, tr.exit_title,
            tr.called_at, t.mint, t.symbol, t.phase, t.last_mc, t.last_liq, t.last_holders, t.peak_mc AS token_peak,
            t.tape_lead, t.last_reasons
     FROM ward_trades tr
     JOIN f2_tokens t ON t.id = tr.token_id
     WHERE tr.status IN ('open','trim')
     ORDER BY tr.called_at DESC
     LIMIT 40`,
  );
  let changed = 0;

  for (const row of due.rows as Array<{
    id: number; token_id: number; entry_mc: number; peak_mc: number | null;
    status: string; exit_action: string | null; exit_title: string | null;
    called_at: string;
    mint: string; symbol: string | null; phase: string | null;
    last_mc: number | null; last_liq: number | null; last_holders: number | null;
    token_peak: number | null; tape_lead: string | null; last_reasons: unknown;
  }>) {
    const lastMc = row.last_mc;
    const peak = Math.max(row.peak_mc ?? 0, row.token_peak ?? 0, lastMc ?? 0) || row.entry_mc;
    const reasons = (row.last_reasons ?? {}) as {
      fails?: string[];
      inputs?: { chg6h?: number; vol6h?: number; buys1h?: number; sells1h?: number };
    };
    const inputs = reasons.inputs ?? {};
    const dead = row.phase === "deceased" || (reasons.fails ?? []).some((f) => /rug|dead|thin/i.test(f));
    const holdDays = Math.max(0, (Date.now() - new Date(row.called_at).getTime()) / 86_400_000);
    const plan = planExit({
      entryMc: row.entry_mc,
      lastMc,
      peakMc: peak,
      phase: row.phase || "ward",
      tapeLead: row.tape_lead,
      dead,
      liqUsd: row.last_liq,
      liqSlope: null,
      holderSlope: null,
      chg6h: inputs.chg6h ?? null,
      vol6h: inputs.vol6h ?? null,
      buys: inputs.buys1h ?? null,
      sells: inputs.sells1h ?? null,
      holdDays,
      trimsTaken: row.status === "trim" ? 1 : 0,
    });

    const gainX = plan.gainX;
    const athX = plan.athX;
    let status = row.status;
    if (plan.action === "exit" && dead) status = "dead";
    else if (plan.action === "exit") status = "exit";
    else if (plan.action === "trim") status = "trim";
    else status = "open";

    const flipped = plan.action !== (row.exit_action ?? "hold") || plan.title !== (row.exit_title ?? "");
    await pool.query(
      `UPDATE ward_trades SET
         peak_mc = $2, peak_at = CASE WHEN $2 > COALESCE(peak_mc,0) THEN NOW() ELSE peak_at END,
         last_mc = $3, last_liq = $4, last_holders = $5,
         gain_x = $6, ath_x = $7,
         status = $8, exit_action = $9, exit_take_pct = $10, exit_title = $11, exit_body = $12,
         closed_at = CASE WHEN $8 IN ('dead','exit') AND closed_at IS NULL THEN NOW() ELSE closed_at END,
         close_mc = CASE WHEN $8 IN ('dead','exit') THEN $3 ELSE close_mc END
       WHERE id = $1`,
      [
        row.id, peak, lastMc, row.last_liq, row.last_holders,
        gainX, athX, status, plan.action, plan.takePct, plan.title, plan.body,
      ],
    );

    if (!flipped) continue;
    changed += 1;
    const ticker = row.symbol || row.mint.slice(0, 6);
    if (plan.action !== "hold") {
      await raiseAlert({
        tokenId: row.token_id,
        kind: plan.action === "trim" ? "trim" : "exit",
        title: `${plan.action === "trim" ? "TRIM" : "EXIT"} $${ticker}`,
        body: `${plan.title}. ${plan.body} Now ${gainX?.toFixed(2) ?? "—"}× · ATH ${athX?.toFixed(2) ?? "—"}×.`,
        payload: {
          mint: row.mint, symbol: ticker, entry: row.entry_mc, last: lastMc, peak,
          gainX, athX, action: plan.action, takePct: plan.takePct,
        },
        telegram: true,
      });
    }
    await agentNote("book", plan.action.toUpperCase(), `$${ticker} ${plan.title} · ${gainX?.toFixed(2) ?? "—"}×`, {
      tokenId: row.token_id, mint: row.mint,
    });
  }

  return { open: due.rows.length, changed };
}
