/**
 * Watch / lock — omo gate only.
 * Buying locks. Stalking sits on the board. Pass is a refusal.
 * No agent debate, no dual-snapshot vote.
 */
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { cacheBust } from "../core/cache";
import { agentNote } from "./log";
import { lockTrade } from "./book";
import { raiseAlert, tradeTelegram } from "./alerts";
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
  const already = await pool.query("SELECT id FROM ward_trades WHERE token_id = $1", [opts.tokenId]);
  if (already.rows.length) return "skip";
  if (opts.call === "pass") return "skip";

  const votes = opts.checks.slice(0, 7).map((c) => ({
    agent: c.hold === true ? "hold" : c.hold === false ? "fail" : "unread",
    vote: c.hold === true ? "yes" : c.hold === false ? "no" : "hold",
    reason: c.text,
  }));
  const yes = votes.filter((v) => v.vote === "yes").length;
  const no = votes.filter((v) => v.vote === "no").length;
  const hold = votes.filter((v) => v.vote === "hold").length;
  const status = opts.call === "buying" ? "locked" : "watching";
  const headline = opts.qualityNote
    ? `${opts.thesis} · ${opts.qualityNote}`
    : opts.thesis;

  await pool.query(
    `INSERT INTO ward_watch (
       token_id, status, yes_votes, no_votes, hold_votes, agreed, entry_ok,
       headline, votes, last_mc, last_liq, last_score, seen_at, updated_at, locked_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW(), NOW(), CASE WHEN $2 = 'locked' THEN NOW() ELSE NULL END)
     ON CONFLICT (token_id) DO UPDATE SET
       status = CASE WHEN ward_watch.status = 'locked' THEN 'locked' ELSE EXCLUDED.status END,
       yes_votes = EXCLUDED.yes_votes,
       no_votes = EXCLUDED.no_votes,
       hold_votes = EXCLUDED.hold_votes,
       agreed = EXCLUDED.agreed,
       entry_ok = EXCLUDED.entry_ok,
       headline = EXCLUDED.headline,
       votes = EXCLUDED.votes,
       last_mc = EXCLUDED.last_mc,
       last_liq = EXCLUDED.last_liq,
       last_score = EXCLUDED.last_score,
       updated_at = NOW(),
       locked_at = CASE
         WHEN ward_watch.status = 'locked' THEN ward_watch.locked_at
         WHEN EXCLUDED.status = 'locked' THEN NOW()
         ELSE ward_watch.locked_at
       END`,
    [
      opts.tokenId, status, yes, no, hold, opts.call === "buying", opts.call === "buying",
      headline, JSON.stringify(votes), opts.mc, opts.liq, opts.score,
    ],
  );
  emitSse("watch:update", { tokenId: opts.tokenId, action: opts.call, headline });
  cacheBust();

  if (opts.call === "stalking") {
    await raiseAlert({
      tokenId: opts.tokenId,
      kind: "watch",
      title: `STALK $${opts.symbol}`,
      body: headline,
      payload: {
        mint: opts.mint, symbol: opts.symbol, mc: opts.mc, liq: opts.liq,
        call: opts.call, checks: opts.checks, quality: opts.quality,
      },
      telegram: false,
    });
    await agentNote("omo", "READ", `$${opts.symbol} stalking — ${opts.thesis}`, {
      tokenId: opts.tokenId, mint: opts.mint,
    });
    return "watch";
  }

  const fired = await raiseAlert({
    tokenId: opts.tokenId,
    kind: "trade",
    title: `BUY $${opts.symbol}`,
    body: `Locked at $${Math.round(opts.mc)}. ${opts.thesis}`,
    payload: {
      mint: opts.mint, symbol: opts.symbol, score: opts.score,
      mc: opts.mc, liq: opts.liq, tape: opts.tapeLead,
      holds: opts.checks.filter((c) => c.hold === true).map((c) => c.text),
      fails: opts.checks.filter((c) => c.hold === false).map((c) => c.text),
      wallets: opts.walletBuys, phase: opts.phase, call: opts.call, quality: opts.quality,
    },
    telegram: false,
  });
  if (!fired) return "watch";

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
  await agentNote("omo", "DID", `$${opts.symbol} locked at $${Math.round(opts.mc)} — ${opts.thesis}`, {
    tokenId: opts.tokenId, mint: opts.mint,
  });
  emitSse("desk:update", { tokenId: opts.tokenId, kind: "lock" });
  cacheBust();
  return "lock";
}
