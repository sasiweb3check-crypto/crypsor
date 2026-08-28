/**
 * READ + GATE tick — omo decision loop.
 *
 *   Held passes and wallet-buy names first
 *   Then public-tape waiting room (Dex boosts, pump movers, CoinGecko)
 *   pump.fun /coins/{mint} if Dex is blank
 *   Second pass only on names a wallet actually bought (pace Dex)
 *
 * Public tape can suggest. A pass still needs a tracked-wallet swap.
 */
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import {
  ageHoursOf, hasSite, imageOf, pairsForMints, researchToken, socialsOf, type DexPair,
} from "../sources/dexscreener";
import { pumpVitals } from "../sources/pumpfun";
import { httpsImage } from "../scoring/image";
import {
  decide, isFakeChart, money, newbornFaded,
  nextPhase, tapeOf, type OmoCandidate, type Phase, type TokenResearch,
} from "../scoring/omo";
import { agentNote } from "./log";
import { raiseAlert } from "./alerts";
import { considerEntry } from "./watch";
import { emitLiveStats, syncPassPrint } from "./stats";
import { isNoiseToken } from "../scoring/noise";
import { hotness } from "../scoring/hotness";

const HOT = 12;
const ARCHIVE = 3;
const PUBLIC = ["public_tape", "dex_boost", "pump_mover", "gecko", "pump_live"];

type Row = {
  id: number;
  mint: string;
  symbol: string | null;
  name: string | null;
  phase: string | null;
  wallet_buys: number;
  scans_total: number;
  admission_mc: number | null;
  mc_at_discovery: number | null;
  peak_mc: number | null;
  last_mc: number | null;
  last_liq: number | null;
  last_holders: number | null;
  graduated: boolean;
  archive?: boolean;
};

function n(v: number | null | undefined): number {
  return Number.isFinite(v) ? Number(v) : 0;
}

async function alreadyHeld(tokenId: number): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM ward_trades WHERE token_id = $1 AND status IN ('open','trim') LIMIT 1`,
    [tokenId],
  );
  return r.rows.length > 0;
}

function candidateFromDex(pair: DexPair, row: Row, held: boolean): OmoCandidate {
  const liq = n(pair.liquidity?.usd);
  const mc = n(pair.marketCap ?? pair.fdv);
  const fdv = n(pair.fdv ?? pair.marketCap);
  const buys1h = n(pair.txns?.h1?.buys);
  const sells1h = n(pair.txns?.h1?.sells);
  const vol1h = n(pair.volume?.h1);
  const vol5m = n(pair.volume?.m5);
  const vol6h = n(pair.volume?.h6);
  const vol24h = n(pair.volume?.h24);
  const chg1h = n(pair.priceChange?.h1);
  const chg6h = n(pair.priceChange?.h6);
  const chg24h = n(pair.priceChange?.h24);
  const ageHours = ageHoursOf(pair);
  const raw = {
    vol1h, vol5m, vol6h, vol24h, buys1h, sells1h, chg1h, chg6h, chg24h,
    liquidityUsd: liq, fdv, ageHours,
  };
  return {
    symbol: (pair.baseToken?.symbol || row.symbol || row.mint.slice(0, 6)).replace(/^\$/, ""),
    name: pair.baseToken?.name || row.name || row.symbol || "unknown",
    mint: row.mint,
    priceUsd: Number(pair.priceUsd) || 0,
    liquidityUsd: liq,
    mcUsd: mc,
    fdv,
    vol24h, vol1h, vol5m, vol6h,
    chg5m: n(pair.priceChange?.m5),
    chg1h, chg6h, chg24h,
    buys1h, sells1h,
    buys5m: n(pair.txns?.m5?.buys),
    sells5m: n(pair.txns?.m5?.sells),
    buys6h: n(pair.txns?.h6?.buys),
    sells6h: n(pair.txns?.h6?.sells),
    ageHours,
    socials: socialsOf(pair),
    hasSite: hasSite(pair),
    walletBuys: row.wallet_buys,
    held,
    fakeChart: isFakeChart(raw),
    newbornFaded: newbornFaded(raw),
    source: "dex",
    flags: [],
  };
}

async function candidateFromPump(row: Row, held: boolean): Promise<OmoCandidate | null> {
  const p = await pumpVitals(row.mint);
  if (!p) return null;
  await persistImage(row.id, httpsImage(p.coin.image_uri));
  const mc = n(p.mcUsd);
  const liq = n(p.liqUsd);
  const socials: string[] = [];
  if (p.coin.twitter) socials.push("twitter");
  if (p.coin.telegram) socials.push("telegram");
  const created = p.coin.created_timestamp ?? 0;
  const ageHours = created ? Math.max(0, (Date.now() - created) / 3_600_000) : 0;
  return {
    symbol: (p.coin.symbol || row.symbol || row.mint.slice(0, 6)).replace(/^\$/, ""),
    name: p.coin.name || row.name || "unknown",
    mint: row.mint,
    priceUsd: 0,
    liquidityUsd: liq,
    mcUsd: mc,
    fdv: mc,
    vol24h: 0, vol1h: 0, vol5m: 0, vol6h: 0,
    chg5m: 0, chg1h: 0, chg6h: 0, chg24h: 0,
    buys1h: 0, sells1h: 0, buys5m: 0, sells5m: 0, buys6h: 0, sells6h: 0,
    ageHours,
    socials,
    hasSite: Boolean(p.coin.website),
    walletBuys: row.wallet_buys,
    held,
    fakeChart: false,
    newbornFaded: false,
    source: "pump",
    flags: ["dex_missing", "using_pump_fallback", "missing_tape"],
  };
}

async function recordSource(
  tokenId: number,
  source: string,
  ok: boolean,
  mc: number | null,
  liq: number | null,
  extra: Record<string, unknown>,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO ward_source_reads (token_id, source, ok, mc_usd, liq_usd, extra)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tokenId, source, ok, mc, liq, JSON.stringify(extra)],
    );
  } catch {
    // table lands on first schema pass
  }
}

async function persistImage(tokenId: number, url: string | null): Promise<void> {
  if (!url) return;
  await pool.query(
    `UPDATE f2_tokens SET image = $2
     WHERE id = $1 AND (image IS NULL OR image = '' OR image NOT LIKE 'https://%')`,
    [tokenId, url],
  );
}

export async function vitalsTick(): Promise<{ scanned: number; trades: number; deaths: number; refused: number }> {
  const due = await pool.query(
    `SELECT t.id, t.mint, t.symbol, t.name, t.phase, t.wallet_buys, t.scans_total,
            t.admission_mc, t.mc_at_discovery, t.peak_mc, t.last_mc, t.last_liq, t.last_holders, t.graduated
     FROM f2_tokens t
     LEFT JOIN ward_trades tr ON tr.token_id = t.id AND tr.status IN ('open','trim')
     WHERE COALESCE(t.phase, 'intake') <> 'deceased'
       AND (
         tr.id IS NOT NULL
         OR t.source = 'wallet_buy'
         OR t.wallet_buys > 0
         OR t.source = ANY($1::text[])
       )
     ORDER BY CASE
                WHEN tr.id IS NOT NULL THEN 0
                WHEN t.source = 'wallet_buy' OR t.wallet_buys > 0 THEN 1
                WHEN t.last_scan_at IS NULL THEN 2
                ELSE 3
              END,
              t.last_scan_at ASC NULLS FIRST
     LIMIT ${HOT}`,
    [PUBLIC],
  );
  return scanRows(due.rows as Row[], false);
}

/** Random archived/dead passes — check if momentum came back. Not a full rescan. */
export async function archiveTick(): Promise<{ scanned: number; revived: number }> {
  const due = await pool.query(
    `SELECT t.id, t.mint, t.symbol, t.name, t.phase, t.wallet_buys, t.scans_total,
            t.admission_mc, t.mc_at_discovery, t.peak_mc, t.last_mc, t.last_liq, t.last_holders, t.graduated
     FROM f2_tokens t
     JOIN ward_trades tr ON tr.token_id = t.id
     WHERE tr.status IN ('dead','exit') OR t.phase = 'deceased'
     ORDER BY random()
     LIMIT ${ARCHIVE}`,
  );
  const rows = (due.rows as Row[]).map((r) => ({ ...r, archive: true }));
  const out = await scanRows(rows, true);
  return { scanned: out.scanned, revived: out.trades };
}

async function scanRows(
  rows: Row[],
  archive: boolean,
): Promise<{ scanned: number; trades: number; deaths: number; refused: number }> {
  if (!rows.length) return { scanned: 0, trades: 0, deaths: 0, refused: 0 };

  const pairs = await pairsForMints(rows.map((r) => r.mint));
  let trades = 0;
  let deaths = 0;
  let refused = 0;

  for (const row of rows) {
    const held = await alreadyHeld(row.id);
    const pair = pairs.get(row.mint);
    let candidate: OmoCandidate | null = pair ? candidateFromDex(pair, row, held) : null;
    let research: TokenResearch | null = null;

    await recordSource(
      row.id, "dex", Boolean(pair),
      pair ? (pair.marketCap ?? pair.fdv ?? null) : null,
      pair?.liquidity?.usd ?? null,
      pair ? { dexId: pair.dexId, url: pair.url } : { reason: "no solana pair" },
    );
    await persistImage(row.id, imageOf(pair));

    if (!candidate) {
      candidate = await candidateFromPump(row, held);
      await recordSource(
        row.id, "pump", Boolean(candidate),
        candidate?.mcUsd || null, candidate?.liquidityUsd || null,
        { fallback: true },
      );
      if (candidate) {
        await agentNote("omo", "READ", `Dex blank for $${candidate.symbol} — pump.fun callback, data quality is less`, {
          tokenId: row.id, mint: row.mint, quiet: true,
        });
      }
    } else if ((!candidate.socials.length && !candidate.hasSite) || candidate.mcUsd <= 0) {
      const pump = await candidateFromPump(row, held);
      await recordSource(
        row.id, "pump", Boolean(pump),
        pump?.mcUsd || null, pump?.liquidityUsd || null,
        { callback: true },
      );
      if (pump) {
        if (!candidate.socials.length) candidate.socials = pump.socials;
        if (!candidate.hasSite) candidate.hasSite = pump.hasSite;
        if (candidate.mcUsd <= 0 && pump.mcUsd > 0) candidate.mcUsd = pump.mcUsd;
        if (candidate.liquidityUsd <= 0 && pump.liquidityUsd > 0) candidate.liquidityUsd = pump.liquidityUsd;
        candidate.source = "mixed";
        candidate.flags = [...candidate.flags, "pump_callback"];
      }
    }

    if (!candidate) {
      await agentNote("omo", "READ", `Dex and pump.fun both blank for ${row.mint.slice(0, 6)}… — no outside story gets added`, {
        tokenId: row.id, mint: row.mint, quiet: true,
      });
      await pool.query(
        `UPDATE f2_tokens SET last_scan_at = NOW(), last_verdict = 'unread',
           last_reasons = $2, last_quality = 0
         WHERE id = $1`,
        [row.id, JSON.stringify({
          call: "pass",
          quality: "thin",
          qualityNote: "DexScreener and pump.fun both missed. Data quality is less. Will not invent a tape.",
          refusedOn: ["tape unread"],
          checks: [{ text: "no public pair — could not be verified", hold: null }],
        })],
      );
      refused += 1;
      continue;
    }

    if (pair && row.wallet_buys >= 1) {
      research = await researchToken(row.mint, candidate.symbol);
      await agentNote(
        "omo",
        "READ",
        research
          ? `second pass $${candidate.symbol} 6h vol ${money(research.vol6h)}`
          : `second pass $${candidate.symbol} empty`,
        { tokenId: row.id, mint: row.mint, quiet: true },
      );
    }

    const d = decide(candidate, research ?? undefined);
    const phase = held
      ? ((row.phase as Phase) || "ward")
      : nextPhase((row.phase as Phase) || "intake", d);
    const ticker = candidate.symbol;
    const mc = candidate.mcUsd || null;
    const liq = candidate.liquidityUsd || null;
    const graduated = row.graduated || Boolean(pair && pair.dexId && pair.dexId !== "pumpfun");

    const reasons = {
      call: d.call,
      holds: d.checks.filter((c) => c.hold === true).map((c) => c.text),
      fails: d.checks.filter((c) => c.hold === false).map((c) => c.text),
      unknowns: d.checks.filter((c) => c.hold === null).map((c) => c.text),
      refusedOn: d.refusedOn,
      rules: d.rules,
      checks: d.checks,
      quality: d.quality,
      qualityNote: d.qualityNote,
      thesis: d.thesis,
      source: candidate.source,
      flags: candidate.flags,
      inputs: {
        mcUsd: candidate.mcUsd,
        liquidityUsd: candidate.liquidityUsd,
        vol1h: candidate.vol1h,
        vol6h: research?.vol6h ?? candidate.vol6h,
        buys1h: candidate.buys1h,
        sells1h: candidate.sells1h,
        chg1h: candidate.chg1h,
        chg6h: research?.chg6h ?? candidate.chg6h,
        ageHours: candidate.ageHours,
      },
    };

    await pool.query(
      `INSERT INTO f2_scans (
         token_id, mc_usd, liq_usd, price_usd, holders, top10_pct,
         buys_5m, sells_5m, vol_5m, pass, fail_reasons, tape, score, phase, quality, sources
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       )`,
      [
        row.id, mc, liq, candidate.priceUsd || null, row.last_holders, null,
        candidate.buys5m || null, candidate.sells5m || null, candidate.vol5m || null,
        d.tradeOk, JSON.stringify(d.refusedOn),
        JSON.stringify({
          lead: d.tapeLead,
          call: d.call,
          holds: reasons.holds,
          fails: reasons.fails,
          unknowns: reasons.unknowns,
          checks: d.checks,
          rules: d.rules,
          m5: tapeOf(candidate.buys5m, candidate.sells5m, candidate.vol5m, candidate.chg5m),
          h1: tapeOf(candidate.buys1h, candidate.sells1h, candidate.vol1h, candidate.chg1h),
          h6: tapeOf(candidate.buys6h, candidate.sells6h, candidate.vol6h, candidate.chg6h),
          chase: d.chase,
          dead: d.dead,
          tradeOk: d.tradeOk,
          quality: d.quality,
          thesis: d.thesis,
        }),
        d.score, phase,
        d.quality === "live" ? 80 : d.quality === "fallback" ? 40 : 15,
        JSON.stringify({ used: { mc: candidate.source, liq: candidate.source }, flags: candidate.flags }),
      ],
    );

    const heat = phase === "deceased" || d.dead
      ? 0
      : hotness({
          mcUsd: mc ?? 0,
          liqUsd: liq ?? 0,
          vol1h: candidate.vol1h,
          vol5m: candidate.vol5m,
          buys1h: candidate.buys1h,
          sells1h: candidate.sells1h,
          chg1h: candidate.chg1h,
          chg6h: research?.chg6h ?? candidate.chg6h,
          tapeLead: d.tapeLead,
          socials: candidate.socials.length,
          walletBuys: candidate.walletBuys,
          quality: d.quality === "live" ? 80 : d.quality === "fallback" ? 40 : 15,
          survival: d.score,
          ageHours: candidate.ageHours,
          chase: d.chase,
          dead: d.dead,
        });

    await pool.query(
      `UPDATE f2_tokens SET
         scans_total = scans_total + 1,
         scans_passed = scans_passed + CASE WHEN $2 THEN 1 ELSE 0 END,
         pass_streak = CASE WHEN $2 THEN pass_streak + 1 ELSE 0 END,
         fail_streak = CASE WHEN $2 THEN 0 ELSE fail_streak + 1 END,
         last_scan_at = NOW(),
         last_mc = $3, last_liq = $4, last_holders = $5,
         peak_mc = COALESCE(GREATEST(peak_mc, $3), $3),
         survival_score = $6,
         last_verdict = $7,
         last_reasons = $8,
         tape_lead = $9,
         phase = $10,
         stage = CASE
           WHEN $10 = 'deceased' THEN 'killed'
           WHEN $11 THEN 'called'
           ELSE 'tracking' END,
         kill_reason = CASE WHEN $10 = 'deceased' THEN $7 ELSE kill_reason END,
         deceased_at = CASE WHEN $10 = 'deceased' AND phase IS DISTINCT FROM 'deceased' THEN NOW() ELSE deceased_at END,
         revived_at = CASE WHEN $10 = 'revived' AND phase IS DISTINCT FROM 'revived' THEN NOW() ELSE revived_at END,
         graduated = $12,
         admission_mc = COALESCE(admission_mc, $3),
         last_quality = $13,
         last_suggestion = $14,
         symbol = COALESCE(symbol, $15),
         name = COALESCE(name, $16),
         hotness = $17
       WHERE id = $1`,
      [
        row.id, d.tradeOk, mc, liq, row.last_holders,
        d.score, d.call, JSON.stringify(reasons), d.tapeLead, phase, d.tradeOk, graduated,
        d.quality === "live" ? 80 : d.quality === "fallback" ? 40 : 15,
        d.thesis, candidate.symbol, candidate.name, heat,
      ],
    );

    const prev = row.phase || "intake";
    if (d.call === "pass" || d.call === "stalking") {
      await agentNote(
        "omo",
        d.call === "pass" ? "REFUSED" : "READ",
        d.call === "pass"
          ? `refused ${ticker} — ${d.refusedOn.slice(0, 2).join(", ") || d.thesis}`
          : `stalk $${ticker}`,
        { tokenId: row.id, mint: row.mint, quiet: true },
      );
      if (d.call === "pass") refused += 1;
    }

    if (phase !== prev && !held) {
      await agentNote("ward", "PHASE", `$${ticker} ${prev} → ${phase} (${d.call})`, {
        tokenId: row.id, mint: row.mint, quiet: true,
      });
      const isPassBook = archive || held;
      if (phase === "deceased" && isPassBook) {
        deaths += 1;
        await raiseAlert({
          tokenId: row.id, kind: "deceased",
          title: `DEAD $${ticker}`,
          body: `${d.thesis} Peak ${money(row.peak_mc ?? mc ?? 0)}.`,
          payload: { mint: row.mint, call: d.call },
          telegram: false,
        });
      } else if (phase === "deceased") {
        deaths += 1;
      }
    }

    if (mc != null && mc > 0) {
      await syncPassPrint(row.id, mc, liq);
    }

    if (mc != null && mc > 0 && d.call === "buying" && !d.dead && !held && !isNoiseToken(row.mint, ticker)) {
      const outcome = await considerEntry({
        tokenId: row.id, mint: row.mint, symbol: ticker, phase,
        call: d.call, thesis: d.thesis, checks: d.checks, refusedOn: d.refusedOn,
        quality: d.quality, qualityNote: d.qualityNote, score: d.score,
        tapeLead: d.tapeLead, mc, liq, walletBuys: candidate.walletBuys,
      });
      if (outcome === "lock") trades += 1;
    }
  }

  emitSse(archive ? "archive:tick" : "vitals:tick", { scanned: rows.length, trades, deaths, refused });
  await emitLiveStats();
  return { scanned: rows.length, trades, deaths, refused };
}
