/**
 * Pass lock — only a buying call becomes a pass on the stats board.
 * Stalking and refusals stay in quiet logs, not on the desk.
 */
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { cacheBust } from "../core/cache";
import { agentNote } from "./log";
import { lockTrade } from "./book";
import { raiseAlert, tradeTelegram } from "./alerts";
import { emitLiveStats } from "./stats";
import { isNoiseToken } from "../scoring/noise";
import type { Call, Check, QualityGrade, TapeLead } from "../scoring/omo";

export async function considerEntry(opts: {
  tokenId: number;
  mint: string;
  symbol: string;
  phase: string;
  call: Call;
  thesis: string;
  checks: Check[];
  refusedOn: string[];
  quality: QualityGrade;
  qualityNote: string | null;
  score: number;
  tapeLead: TapeLead;
  mc: number;
  liq: number | null;
  walletBuys: number;
}): Promise<"lock" | "watch" | "skip"> {
  if (opts.call !== "buying") return "skip";
  if (isNoiseToken(opts.mint, opts.symbol)) return "skip";

  const already = await pool.query(
    `SELECT id, status FROM ward_trades WHERE token_id = $1`,
    [opts.tokenId],
  );
  if (already.rows[0]?.status === "open" || already.rows[0]?.status === "trim") return "skip";

  if (already.rows.length) {
    await pool.query(
      `UPDATE ward_trades SET
         status = 'open', closed_at = NULL, archived_at = NULL,
         last_mc = $2, peak_mc = GREATEST(peak_mc, $2)
       WHERE token_id = $1`,
      [opts.tokenId, opts.mc],
    );
    await agentNote("omo", "DID", `$${opts.symbol} revived on the book at $${Math.round(opts.mc)}`, {
      tokenId: opts.tokenId, mint: opts.mint,
    });
    emitSse("pass:new", { tokenId: opts.tokenId, symbol: opts.symbol, mc: opts.mc, revived: true });
    cacheBust();
    await emitLiveStats();
    return "lock";
  }

  const fired = await raiseAlert({
    tokenId: opts.tokenId,
    kind: "trade",
    title: `PASS $${opts.symbol}`,
    body: `Passed at $${Math.round(opts.mc)} · ${opts.thesis}`,
    payload: {
      mint: opts.mint, symbol: opts.symbol, score: opts.score,
      mc: opts.mc, liq: opts.liq, tape: opts.tapeLead,
      holds: opts.checks.filter((c) => c.hold === true).map((c) => c.text),
      wallets: opts.walletBuys, phase: opts.phase, call: opts.call,
    },
    telegram: true,
  });
  if (!fired) return "skip";

  const alertRow = await pool.query(
    `SELECT id FROM ward_alerts WHERE token_id = $1 AND kind = 'trade' ORDER BY id DESC LIMIT 1`,
    [opts.tokenId],
  );
  await lockTrade({
    tokenId: opts.tokenId, mint: opts.mint, symbol: opts.symbol,
    alertId: alertRow.rows[0]?.id ?? null,
    entryMc: opts.mc, entryLiq: opts.liq,
    entryHolders: null, entryScore: opts.score,
  });
  await tradeTelegram({
    symbol: opts.symbol,
    mint: opts.mint,
    score: opts.score,
    phase: opts.phase,
    mc: opts.mc,
    liq: opts.liq,
    holders: null,
    wallets: opts.walletBuys,
    tape: opts.tapeLead,
    holds: opts.checks.filter((c) => c.hold === true).map((c) => c.text),
    fails: opts.checks.filter((c) => c.hold === false).map((c) => c.text),
  });
  await pool.query(
    `INSERT INTO f2_calls (token_id, alert_mc, peak_mc, last_mc, safe, deep, telegram_sent, journal_until)
     VALUES ($1,$2,$2,$2, true, $3, true, NOW() + INTERVAL '24 hours')
     ON CONFLICT (token_id) DO NOTHING`,
    [opts.tokenId, opts.mc, JSON.stringify({ call: opts.call, checks: opts.checks, thesis: opts.thesis })],
  );
  await agentNote("omo", "DID", `$${opts.symbol} passed at $${Math.round(opts.mc)} — ${opts.thesis}`, {
    tokenId: opts.tokenId, mint: opts.mint,
  });
  emitSse("pass:new", { tokenId: opts.tokenId, symbol: opts.symbol, mc: opts.mc, at: new Date().toISOString() });
  cacheBust();
  await emitLiveStats();
  return "lock";
}
