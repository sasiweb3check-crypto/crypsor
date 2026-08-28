/**
 * SNAPSHOTS — judgment after a pass, not a lock bot.
 *
 *   pulse    every 10 minutes
 *   confirm  every 15 minutes
 *   hour     every 1 hour
 *
 * Each print reads previous memory, writes a story, and updates survival /
 * momentum from the continued series. Missing prints are never sloped.
 */
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import {
  capBand, snapshotCadenceMs, snapshotSuggestions, slope,
  type Suggestion,
} from "../scoring/quality";
import {
  emptyMemory, fillOf, parseMemory, remember,
  type AgentMemory, type Fill,
} from "../scoring/memory";
import { tellStory } from "../scoring/narrative";
import { judgeSeries, type Momentum } from "../scoring/survival";
import { agentNote } from "./log";
import { emitLiveStats } from "./stats";

const BATCH = 16;
const KINDS = ["pulse", "confirm", "hour"] as const;
type Kind = (typeof KINDS)[number];

type Row = {
  id: number;
  mint: string;
  symbol: string | null;
  phase: string | null;
  last_mc: number | null;
  last_liq: number | null;
  last_holders: number | null;
  last_quality: number | null;
  wallet_buys: number;
  survival_score: number | null;
  tape_lead: string | null;
  last_reasons: unknown;
  last_narrative: string | null;
};

type PrevSnap = {
  at: number;
  mc_usd: number | null;
  liq_usd: number | null;
  holders: number | null;
  score: number | null;
  mc_slope: number | null;
  fill: { mc: Fill; liq: Fill; holders: Fill } | null;
  tape_lead: string | null;
};

function asFill(raw: unknown): { mc: Fill; liq: Fill; holders: Fill } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const ok = (v: unknown): v is Fill => v === "live" || v === "stale" || v === "missing";
  if (!ok(o.mc) || !ok(o.liq) || !ok(o.holders)) return null;
  return { mc: o.mc, liq: o.liq, holders: o.holders };
}

async function lastOfKind(tokenId: number, kind: Kind): Promise<PrevSnap | null> {
  const r = await pool.query(
    `SELECT at, mc_usd, liq_usd, holders, score, filled, tape_lead, mc_slope
     FROM ward_snapshots WHERE token_id = $1 AND kind = $2
     ORDER BY at DESC LIMIT 1`,
    [tokenId, kind],
  );
  if (!r.rows[0]) return null;
  return {
    at: new Date(r.rows[0].at as string).getTime(),
    mc_usd: r.rows[0].mc_usd,
    liq_usd: r.rows[0].liq_usd,
    holders: r.rows[0].holders,
    score: r.rows[0].score,
    mc_slope: r.rows[0].mc_slope ?? null,
    fill: asFill(r.rows[0].filled),
    tape_lead: r.rows[0].tape_lead ?? null,
  };
}

async function loadMemory(tokenId: number): Promise<AgentMemory> {
  try {
    const r = await pool.query(
      `SELECT caution, pulse, confirm, hour FROM ward_memory WHERE token_id = $1`,
      [tokenId],
    );
    if (!r.rows[0]) return emptyMemory();
    return parseMemory(r.rows[0]);
  } catch {
    return emptyMemory();
  }
}

async function saveMemory(tokenId: number, mem: AgentMemory, narrative: string): Promise<void> {
  await pool.query(
    `INSERT INTO ward_memory (token_id, caution, pulse, confirm, hour, narrative, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, NOW())
     ON CONFLICT (token_id) DO UPDATE SET
       caution = EXCLUDED.caution,
       pulse = EXCLUDED.pulse,
       confirm = EXCLUDED.confirm,
       hour = EXCLUDED.hour,
       narrative = EXCLUDED.narrative,
       updated_at = NOW()`,
    [
      tokenId,
      JSON.stringify(mem.caution),
      JSON.stringify(mem.pulse),
      JSON.stringify(mem.confirm),
      JSON.stringify(mem.hour),
      narrative,
    ],
  );
  await pool.query(`UPDATE f2_tokens SET last_narrative = $2 WHERE id = $1`, [tokenId, narrative]);
}

async function writeSurvival(tokenId: number): Promise<{ survival: number; momentum: Momentum } | null> {
  const r = await pool.query(
    `SELECT kind, mc_usd, mc_slope, liq_slope, holder_slope, incomplete, score
     FROM ward_snapshots WHERE token_id = $1 ORDER BY at DESC LIMIT 12`,
    [tokenId],
  );
  const judged = judgeSeries(r.rows as Array<{
    kind: string; mc_usd: number | null; mc_slope: number | null;
    liq_slope: number | null; holder_slope: number | null; incomplete: boolean | null; score: number | null;
  }>);
  await pool.query(
    `UPDATE f2_tokens SET survival_score = $2, last_momentum = $3 WHERE id = $1`,
    [tokenId, judged.survival, judged.momentum],
  );
  return judged;
}

async function writeKind(row: Row, kind: Kind): Promise<boolean> {
  const band = capBand(row.last_mc) ?? "low";
  const prev = await lastOfKind(row.id, kind);
  const cadence = snapshotCadenceMs(band, row.phase || "ward", kind);
  if (prev && Date.now() - prev.at < cadence) return false;

  const scan = await pool.query(
    `SELECT mc_usd, liq_usd, holders, top10_pct, score, phase, tape, quality, sources
     FROM f2_scans WHERE token_id = $1 ORDER BY at DESC LIMIT 1`,
    [row.id],
  );
  const s = scan.rows[0] as {
    mc_usd: number | null; liq_usd: number | null; holders: number | null;
    top10_pct: number | null; score: number | null; phase: string | null;
    tape: Record<string, unknown> | null; quality: number | null; sources: { flags?: string[] } | null;
  } | undefined;
  if (!s) return false;

  const fill = {
    mc: fillOf(s.mc_usd, row.last_mc),
    liq: fillOf(s.liq_usd, row.last_liq),
    holders: fillOf(s.holders, row.last_holders),
  };
  const displayMc = s.mc_usd ?? row.last_mc;
  const displayLiq = s.liq_usd ?? row.last_liq;
  const displayHolders = s.holders ?? row.last_holders;

  const prevLiveMc = prev?.fill?.mc === "live" ? prev.mc_usd : null;
  const prevLiveLiq = prev?.fill?.liq === "live" ? prev.liq_usd : null;
  const prevLiveHold = prev?.fill?.holders === "live" ? prev.holders : null;
  const mcSlope = fill.mc === "live" ? slope(s.mc_usd, prevLiveMc) : null;
  const liqSlope = fill.liq === "live" ? slope(s.liq_usd, prevLiveLiq) : null;
  const holderSlope = fill.holders === "live" ? slope(s.holders, prevLiveHold) : null;

  const tape = s.tape ?? {};
  const reasons = (row.last_reasons ?? {}) as { fails?: string[]; unknowns?: string[] };
  const flags = [...(s.sources?.flags ?? [])];
  if (fill.mc === "stale") flags.push("stale_mc");
  if (fill.mc === "missing") flags.push("missing_mc");
  if (fill.liq === "stale") flags.push("stale_liq");
  if (fill.liq === "missing") flags.push("missing_liq");
  if (fill.holders === "stale") flags.push("stale_holders");
  if (fill.holders === "missing") flags.push("missing_holders");

  const suggestions: Suggestion[] = snapshotSuggestions({
    band: band === "mega" ? "mid" : band,
    phase: s.phase || row.phase || "intake",
    score: s.score ?? row.survival_score,
    prevScore: prev?.score ?? null,
    mc: fill.mc === "live" ? s.mc_usd : displayMc,
    prevMc: prevLiveMc,
    liq: fill.liq === "live" ? s.liq_usd : displayLiq,
    prevLiq: prevLiveLiq,
    holders: fill.holders === "live" ? s.holders : displayHolders,
    prevHolders: prevLiveHold,
    top10Pct: s.top10_pct,
    tapeLead: (tape.lead as string | undefined) ?? row.tape_lead,
    chase: Boolean(tape.chase) || (reasons.fails ?? []).includes("chase"),
    tradeOk: Boolean(tape.tradeOk),
    dead: Boolean(tape.dead),
    quality: s.quality ?? row.last_quality,
    flags,
    walletBuys: row.wallet_buys,
    unknowns: reasons.unknowns ?? [],
  });

  const dump = (mcSlope ?? 0) < -0.12;
  const exodus = (holderSlope ?? 0) < -0.08;
  const disagree = flags.includes("mc_disagree") || flags.includes("liq_disagree");
  let mem = await loadMemory(row.id);
  mem = remember(mem, {
    kind,
    fill,
    dump: fill.mc === "live" && dump,
    exodus: fill.holders === "live" && exodus,
    disagree,
    quality: s.quality ?? row.last_quality,
  });

  const locked = (await pool.query(
    "SELECT 1 FROM ward_trades WHERE token_id = $1 AND status IN ('open','trim') LIMIT 1",
    [row.id],
  )).rows.length > 0;
  const otherKind: Kind = kind === "pulse" ? "confirm" : kind === "confirm" ? "hour" : "pulse";
  const other = await lastOfKind(row.id, otherKind);
  const ticker = row.symbol || row.mint.slice(0, 6);
  const series = await pool.query(
    `SELECT kind, mc_usd, mc_slope, liq_slope, holder_slope, incomplete, score
     FROM ward_snapshots WHERE token_id = $1 ORDER BY at DESC LIMIT 12`,
    [row.id],
  );
  const judged = judgeSeries(series.rows as Array<{
    kind: string; mc_usd: number | null; mc_slope: number | null;
    liq_slope: number | null; holder_slope: number | null; incomplete: boolean | null; score: number | null;
  }>);
  const narrative = tellStory({
    symbol: ticker,
    kind,
    phase: s.phase || row.phase || "intake",
    tapeLead: (tape.lead as string | undefined) ?? row.tape_lead,
    mc: displayMc,
    mcSlope,
    liq: displayLiq,
    liqSlope,
    holders: displayHolders,
    holderSlope,
    quality: s.quality ?? row.last_quality,
    fill,
    other: other
      ? { kind: otherKind, mc: other.mc_usd, mcSlope: other.mc_slope, tapeLead: other.tape_lead }
      : null,
    memory: mem,
    walletBuys: row.wallet_buys,
    locked,
    survival: judged.survival,
    momentum: judged.momentum,
    prevStory: row.last_narrative,
  });
  const headline = suggestions[0]?.title ?? (fill.mc === "live" ? "observed" : "incomplete print");
  const incomplete = fill.mc !== "live" || fill.liq !== "live" || fill.holders !== "live";

  await pool.query(
    `INSERT INTO ward_snapshots (
       token_id, band, kind, mc_usd, liq_usd, holders, top10_pct, score, phase, quality,
       tape_lead, mc_slope, liq_slope, holder_slope, sources, flags, suggestions,
       narrative, incomplete, filled
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      row.id, band, kind,
      displayMc, displayLiq, displayHolders, s.top10_pct,
      judged.survival, s.phase || row.phase,
      s.quality ?? row.last_quality,
      (tape.lead as string | undefined) ?? row.tape_lead,
      mcSlope, liqSlope, holderSlope,
      JSON.stringify(s.sources ?? {}),
      JSON.stringify(flags),
      JSON.stringify(suggestions),
      narrative, incomplete, JSON.stringify(fill),
    ],
  );
  await pool.query(
    `UPDATE f2_tokens SET last_snapshot_at = NOW(), last_suggestion = $2, cap_band = $3 WHERE id = $1`,
    [row.id, `${kind}: ${headline}`, band],
  );
  try {
    await saveMemory(row.id, mem, narrative);
    await writeSurvival(row.id);
  } catch {
    // ward_memory lands on first schema pass
  }
  await agentNote(
    "snapshots",
    kind === "hour" ? "HOUR" : kind === "pulse" ? "PULSE" : "CONFIRM",
    `$${ticker} ${kind} ${incomplete ? "incomplete" : band} · survival ${judged.survival} · ${headline}`,
    { tokenId: row.id, mint: row.mint, quiet: true },
  );
  return true;
}

export async function snapshotsTick(): Promise<{ wrote: number; skipped: number }> {
  const due = await pool.query(
    `SELECT t.id, t.mint, t.symbol, t.phase, t.last_mc, t.last_liq, t.last_holders, t.last_quality,
            t.wallet_buys, t.survival_score, t.tape_lead, t.last_reasons, t.last_narrative
     FROM f2_tokens t
     LEFT JOIN ward_trades tr ON tr.token_id = t.id AND tr.status IN ('open','trim')
     WHERE (t.source = 'wallet_buy' OR t.wallet_buys > 0)
       AND COALESCE(t.phase, 'intake') IN ('intake','ward','icu','recovery','revived')
     ORDER BY CASE WHEN tr.id IS NOT NULL THEN 0 ELSE 1 END,
              t.last_snapshot_at ASC NULLS FIRST
     LIMIT ${BATCH}`,
  );
  let wrote = 0;
  let skipped = 0;

  for (const row of due.rows as Row[]) {
    for (const kind of KINDS) {
      try {
        const ok = await writeKind(row, kind);
        if (ok) wrote += 1;
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
  }

  if (wrote) {
    emitSse("snapshot:tick", { wrote, skipped });
    await emitLiveStats();
  }
  return { wrote, skipped };
}
