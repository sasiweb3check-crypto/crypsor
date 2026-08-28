/**
 * SNAPSHOTS agent — two independent series:
 *   pulse   every ~2 minutes (fast tape / MC / holders)
 *   confirm every ~5 minutes (same vitals, used to agree or veto a lock)
 *
 * Mega caps skip pulse unless they are in ICU. Suggestions come from
 * slope vs the previous snapshot of the SAME kind, not a mixed pair.
 */
import { pool } from "../core/db";
import {
  capBand, snapshotCadenceMs, snapshotSuggestions, slope,
  type Suggestion,
} from "../scoring/quality";
import { agentNote } from "./log";

const BATCH = 24;
const KINDS = ["pulse", "confirm"] as const;
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
};

async function lastOfKind(tokenId: number, kind: Kind): Promise<{
  at: number;
  mc_usd: number | null;
  liq_usd: number | null;
  holders: number | null;
  score: number | null;
} | null> {
  const r = await pool.query(
    `SELECT at, mc_usd, liq_usd, holders, score
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
  };
}

async function writeKind(row: Row, kind: Kind): Promise<boolean> {
  const band = capBand(row.last_mc);
  if (!band) return false;
  if (band === "mega" && row.phase !== "icu" && kind === "pulse") return false;
  if (band === "mega" && row.phase !== "icu" && kind === "confirm") {
    // mega confirm is slower; cadence helper already stretches it
  }

  const prev = await lastOfKind(row.id, kind);
  const cadence = snapshotCadenceMs(band === "mega" ? "mega" : band, row.phase || "ward", kind);
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

  const tape = s.tape ?? {};
  const reasons = (row.last_reasons ?? {}) as { fails?: string[]; unknowns?: string[] };
  const flags = s.sources?.flags ?? [];
  const suggestions: Suggestion[] = snapshotSuggestions({
    band: band === "mega" ? "mid" : band,
    phase: s.phase || row.phase || "intake",
    score: s.score ?? row.survival_score,
    prevScore: prev?.score ?? null,
    mc: s.mc_usd ?? row.last_mc,
    prevMc: prev?.mc_usd ?? null,
    liq: s.liq_usd ?? row.last_liq,
    prevLiq: prev?.liq_usd ?? null,
    holders: s.holders ?? row.last_holders,
    prevHolders: prev?.holders ?? null,
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

  const mcSlope = slope(s.mc_usd ?? row.last_mc, prev?.mc_usd ?? null);
  const liqSlope = slope(s.liq_usd ?? row.last_liq, prev?.liq_usd ?? null);
  const holderSlope = slope(s.holders ?? row.last_holders, prev?.holders ?? null);
  const headline = suggestions[0]?.title ?? "observed";

  await pool.query(
    `INSERT INTO ward_snapshots (
       token_id, band, kind, mc_usd, liq_usd, holders, top10_pct, score, phase, quality,
       tape_lead, mc_slope, liq_slope, holder_slope, sources, flags, suggestions
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      row.id, band, kind,
      s.mc_usd ?? row.last_mc, s.liq_usd ?? row.last_liq,
      s.holders ?? row.last_holders, s.top10_pct,
      s.score ?? row.survival_score, s.phase || row.phase,
      s.quality ?? row.last_quality,
      (tape.lead as string | undefined) ?? row.tape_lead,
      mcSlope, liqSlope, holderSlope,
      JSON.stringify(s.sources ?? {}),
      JSON.stringify(flags),
      JSON.stringify(suggestions),
    ],
  );
  await pool.query(
    `UPDATE f2_tokens SET last_snapshot_at = NOW(), last_suggestion = $2, cap_band = $3 WHERE id = $1`,
    [row.id, `${kind}: ${headline}`, band],
  );
  const ticker = row.symbol || row.mint.slice(0, 6);
  await agentNote(
    "snapshots",
    suggestions[0]?.severity === "act" ? "ALERT" : kind === "pulse" ? "PULSE" : "CONFIRM",
    `$${ticker} ${kind} ${band} · ${headline}${suggestions.length > 1 ? ` (+${suggestions.length - 1})` : ""}`,
    { tokenId: row.id, mint: row.mint },
  );
  return true;
}

export async function snapshotsTick(): Promise<{ wrote: number; skipped: number }> {
  const due = await pool.query(
    `SELECT id, mint, symbol, phase, last_mc, last_liq, last_holders, last_quality,
            wallet_buys, survival_score, tape_lead, last_reasons
     FROM f2_tokens
     WHERE (source = 'wallet_buy' OR wallet_buys > 0)
       AND COALESCE(phase, 'intake') IN ('intake','ward','icu','recovery','revived')
     ORDER BY CASE COALESCE(phase,'intake') WHEN 'icu' THEN 0 WHEN 'intake' THEN 1 ELSE 2 END,
              last_snapshot_at ASC NULLS FIRST
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

  return { wrote, skipped };
}
