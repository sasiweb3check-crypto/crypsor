/**
 * WATCHLIST — tokens that look interesting but are not locked yet.
 * Agents debate; we only freeze entry MC after agreement + a satisfying print.
 */
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { cacheBust } from "../core/cache";
import { debateEntry, type DebateInput, type DebateResult } from "../scoring/debate";
import { cautionLevel, parseMemory } from "../scoring/memory";
import { agentNote } from "./log";
import { lockTrade } from "./book";
import { raiseAlert, tradeTelegram } from "./alerts";
import type { Reading, Verdict } from "../scoring/ward";

export type WatchRow = {
  token_id: number;
  status: string;
  yes_votes: number;
  no_votes: number;
  hold_votes: number;
  agreed: boolean;
  entry_ok: boolean;
  headline: string | null;
  votes: unknown;
  last_mc: number | null;
  last_liq: number | null;
  last_score: number | null;
  seen_at: string;
  updated_at: string;
};

async function debateInputs(tokenId: number, reading: Reading, verdict: Verdict, phase: string): Promise<DebateInput> {
  let quality: number | null = null;
  let flags: string[] = [];
  try {
    const q = await pool.query(
      `SELECT quality, sources FROM f2_scans
       WHERE token_id = $1 AND (quality IS NOT NULL OR sources IS NOT NULL)
       ORDER BY at DESC LIMIT 1`,
      [tokenId],
    );
    quality = q.rows[0]?.quality ?? null;
    flags = (q.rows[0]?.sources?.flags as string[] | undefined) ?? [];
  } catch {
    quality = null;
  }

  let pulseMcSlope: number | null = null;
  let confirmMcSlope: number | null = null;
  let pulseHolderSlope: number | null = null;
  let confirmHolderSlope: number | null = null;
  let pulseTape: string | null = null;
  let confirmTape: string | null = null;
  let incompletePulse = false;
  let incompleteConfirm = false;
  try {
    const snaps = await pool.query(
      `SELECT DISTINCT ON (kind) kind, mc_slope, holder_slope, tape_lead, incomplete, flags
       FROM ward_snapshots
       WHERE token_id = $1 AND kind IN ('pulse','confirm')
       ORDER BY kind, at DESC`,
      [tokenId],
    );
    for (const s of snaps.rows as Array<{
      kind: string; mc_slope: number | null; holder_slope: number | null; tape_lead: string | null;
      incomplete: boolean | null; flags: string[] | null;
    }>) {
      const stale = Boolean(s.incomplete) || (s.flags ?? []).some((f) => f.startsWith("stale_") || f.startsWith("missing_"));
      if (s.kind === "pulse") {
        pulseMcSlope = stale ? null : s.mc_slope;
        pulseHolderSlope = stale ? null : s.holder_slope;
        pulseTape = s.tape_lead;
        incompletePulse = stale;
      }
      if (s.kind === "confirm") {
        confirmMcSlope = stale ? null : s.mc_slope;
        confirmHolderSlope = stale ? null : s.holder_slope;
        confirmTape = s.tape_lead;
        incompleteConfirm = stale;
      }
    }
  } catch {
    // snapshots table / kind column may land on first schema pass
  }

  let memoryLevel: DebateInput["memoryLevel"] = "clear";
  let memoryDumps = 0;
  let memoryMissingHolders = 0;
  try {
    const memRow = await pool.query(
      `SELECT caution, pulse, confirm FROM ward_memory WHERE token_id = $1`,
      [tokenId],
    );
    if (memRow.rows[0]) {
      const mem = parseMemory(memRow.rows[0]);
      memoryLevel = cautionLevel(mem);
      memoryDumps = mem.caution.dumps;
      memoryMissingHolders = mem.caution.missingHolders;
    }
  } catch {
    // ward_memory lands on first schema pass
  }

  return {
    score: verdict.score,
    tradeOk: verdict.tradeOk,
    chase: verdict.chase,
    dead: verdict.dead,
    tapeLead: verdict.tapeLead,
    mcUsd: reading.mcUsd,
    liqUsd: reading.liqUsd,
    holders: reading.holders,
    top10Pct: reading.top10Pct,
    botHoldPct: reading.botHoldPct,
    bundlerHoldPct: reading.bundlerHoldPct,
    quality,
    flags,
    unknowns: verdict.unknowns,
    walletBuys: reading.walletBuys,
    phase,
    pulseMcSlope,
    confirmMcSlope,
    pulseHolderSlope,
    confirmHolderSlope,
    pulseTape,
    confirmTape,
    memoryLevel,
    memoryDumps,
    memoryMissingHolders,
    incompletePulse,
    incompleteConfirm,
  };
}

async function upsertWatch(tokenId: number, debate: DebateResult, mc: number | null, liq: number | null, score: number): Promise<void> {
  const status = debate.action === "lock" ? "locked" : "watching";
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
      tokenId, status, debate.yes, debate.no, debate.hold, debate.agreed, debate.entryOk,
      debate.headline, JSON.stringify(debate.votes), mc, liq, score,
    ],
  );
}

export async function considerEntry(opts: {
  tokenId: number;
  mint: string;
  symbol: string;
  phase: string;
  reading: Reading;
  verdict: Verdict;
  mc: number;
  liq: number | null;
}): Promise<"lock" | "watch" | "skip"> {
  const already = await pool.query("SELECT id FROM ward_trades WHERE token_id = $1", [opts.tokenId]);
  if (already.rows.length) return "skip";

  const debate = debateEntry(await debateInputs(opts.tokenId, opts.reading, opts.verdict, opts.phase));

  if (debate.action === "pass") return "skip";

  await upsertWatch(opts.tokenId, debate, opts.mc, opts.liq, opts.verdict.score);
  emitSse("watch:update", { tokenId: opts.tokenId, action: debate.action, headline: debate.headline });
  cacheBust();

  if (debate.action === "watch") {
    await raiseAlert({
      tokenId: opts.tokenId,
      kind: "watch",
      title: `WATCH $${opts.symbol}`,
      body: debate.headline,
      payload: {
        mint: opts.mint, symbol: opts.symbol, mc: opts.mc, liq: opts.liq,
        score: opts.verdict.score, votes: debate.votes, entryOk: debate.entryOk,
        entryWhy: debate.entryWhy, agreed: debate.agreed,
      },
      telegram: false,
    });
    await agentNote("watch", "WATCH", `$${opts.symbol} ${debate.headline}`, {
      tokenId: opts.tokenId, mint: opts.mint,
    });
    return "watch";
  }

  const fired = await raiseAlert({
    tokenId: opts.tokenId,
    kind: "trade",
    title: `TRADE $${opts.symbol}`,
    body: `Locked at $${Math.round(opts.mc)}. ${debate.headline}. ${opts.verdict.holds.slice(0, 2).join("; ")}.`,
    payload: {
      mint: opts.mint, symbol: opts.symbol, score: opts.verdict.score,
      mc: opts.mc, liq: opts.liq, holders: opts.reading.holders,
      tape: opts.verdict.tapeLead, holds: opts.verdict.holds, fails: opts.verdict.fails,
      wallets: opts.reading.walletBuys, phase: opts.phase, votes: debate.votes,
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
    entryHolders: opts.reading.holders, entryScore: opts.verdict.score,
  });
  await tradeTelegram({
    symbol: opts.symbol,
    mint: opts.mint,
    score: opts.verdict.score,
    phase: opts.phase,
    mc: opts.mc,
    liq: opts.liq,
    holders: opts.reading.holders,
    wallets: opts.reading.walletBuys,
    tape: opts.verdict.tapeLead,
    holds: opts.verdict.holds,
    fails: opts.verdict.fails,
    factors: opts.verdict.factors,
    m5: opts.reading.m5,
    h1: opts.reading.h1,
    h6: opts.reading.h6,
    top10: opts.reading.top10Pct,
    bundlers: opts.reading.bundlerHoldPct,
    bots: opts.reading.botHoldPct,
  });
  await pool.query(
    `INSERT INTO f2_calls (token_id, alert_mc, peak_mc, last_mc, safe, deep, telegram_sent, journal_until)
     VALUES ($1,$2,$2,$2, $3, $4, true, NOW() + INTERVAL '24 hours')
     ON CONFLICT (token_id) DO NOTHING`,
    [opts.tokenId, opts.mc, opts.verdict.score >= 80, JSON.stringify(opts.verdict)],
  );
  await agentNote("alerts", "TRADE", `$${opts.symbol} locked at $${Math.round(opts.mc)} — ${debate.headline}`, {
    tokenId: opts.tokenId, mint: opts.mint,
  });
  emitSse("desk:update", { tokenId: opts.tokenId, kind: "lock" });
  cacheBust();
  return "lock";
}
