/**
 * VITALS + WARD agents — DexScreener tape (omo 5m/1h/6h) + pump.fun bonding
 * fallback. Scores every living patient, writes the chart, moves phase.
 */
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { pairsForMints, type DexPair } from "../sources/dexscreener";
import { coin as pumpCoin, virtualLiqUsd } from "../sources/pumpfun";
import { judge, nextPhase, type Phase, type Reading, type TapeWindow } from "../scoring/ward";
import { agentNote } from "./log";
import { raiseAlert, tradeTelegram } from "./alerts";

const BATCH = 16;

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
};

function windowFrom(p: DexPair | undefined, key: "m5" | "h1" | "h6"): TapeWindow {
  const tx = p?.txns?.[key];
  return {
    buys: tx?.buys ?? null,
    sells: tx?.sells ?? null,
    volUsd: p?.volume?.[key] ?? null,
    changePct: p?.priceChange?.[key] ?? null,
  };
}

function emptyTape(): TapeWindow {
  return { buys: null, sells: null, volUsd: null, changePct: null };
}

export async function vitalsTick(): Promise<{ scanned: number; trades: number; deaths: number }> {
  const due = await pool.query(
    `SELECT id, mint, symbol, name, phase, wallet_buys, scans_total,
            admission_mc, mc_at_discovery, peak_mc, last_mc, last_liq, last_holders, graduated
     FROM f2_tokens
     WHERE (source = 'wallet_buy' OR wallet_buys > 0)
       AND (
         COALESCE(phase, 'intake') NOT IN ('deceased')
         OR (phase = 'deceased' AND deceased_at > NOW() - INTERVAL '6 hours')
       )
     ORDER BY CASE COALESCE(phase,'intake')
                WHEN 'icu' THEN 0 WHEN 'intake' THEN 1 WHEN 'recovery' THEN 2
                WHEN 'revived' THEN 3 ELSE 4 END,
              last_scan_at ASC NULLS FIRST
     LIMIT ${BATCH}`,
  );
  const rows = due.rows as Row[];
  if (!rows.length) return { scanned: 0, trades: 0, deaths: 0 };

  const pairs = await pairsForMints(rows.map((r) => r.mint));
  let trades = 0;
  let deaths = 0;

  for (const row of rows) {
    const pair = pairs.get(row.mint);
    let mc = pair?.marketCap ?? pair?.fdv ?? null;
    let liq = pair?.liquidity?.usd ?? null;
    let price = pair?.priceUsd ? Number(pair.priceUsd) : null;
    let graduated = row.graduated || Boolean(pair && pair.dexId && pair.dexId !== "pumpfun");

    if (mc == null || liq == null) {
      const p = await pumpCoin(row.mint);
      if (p) {
        mc = mc ?? p.usd_market_cap ?? null;
        liq = liq ?? virtualLiqUsd(p);
        graduated = Boolean(p.complete);
        if (!row.symbol && p.symbol) {
          await pool.query("UPDATE f2_tokens SET symbol = COALESCE(symbol,$2), name = COALESCE(name,$3), image = COALESCE(image,$4) WHERE id = $1",
            [row.id, p.symbol, p.name ?? null, p.image_uri ?? null]);
        }
      }
    }

    const last = await pool.query(
      "SELECT holders FROM f2_scans WHERE token_id = $1 ORDER BY at DESC LIMIT 1",
      [row.id],
    );
    const prevHolders = (last.rows[0]?.holders as number | null) ?? row.last_holders;

    const reading: Reading = {
      mcUsd: mc,
      liqUsd: liq,
      priceUsd: Number.isFinite(price) ? price : null,
      holders: row.last_holders,
      prevHolders,
      prevLiq: row.last_liq,
      top10Pct: null,
      bundlerHoldPct: null,
      sniperHoldPct: null,
      botHoldPct: null,
      smartCount: null,
      kolCount: null,
      whaleHoldPct: null,
      m5: windowFrom(pair, "m5"),
      h1: windowFrom(pair, "h1"),
      h6: windowFrom(pair, "h6"),
      admissionMc: row.admission_mc ?? row.mc_at_discovery,
      walletBuys: row.wallet_buys,
      graduated,
      scansTotal: row.scans_total,
    };

    // carry last intel from previous scan if present
    const intel = await pool.query(
      `SELECT top10_pct, bundler_pct, sniper_pct, bot_pct, smart_count, kol_count, holders, whale_pct
       FROM f2_scans WHERE token_id = $1 AND (top10_pct IS NOT NULL OR holders IS NOT NULL)
       ORDER BY at DESC LIMIT 1`,
      [row.id],
    );
    if (intel.rows[0]) {
      const i = intel.rows[0];
      reading.top10Pct = i.top10_pct;
      reading.bundlerHoldPct = i.bundler_pct;
      reading.sniperHoldPct = i.sniper_pct;
      reading.botHoldPct = i.bot_pct;
      reading.smartCount = i.smart_count;
      reading.kolCount = i.kol_count;
      reading.whaleHoldPct = i.whale_pct;
      reading.holders = i.holders ?? reading.holders;
    }

    const verdict = judge(reading);
    const phase = nextPhase((row.phase as Phase) || "intake", verdict, row.scans_total);
    const peak = Math.max(row.peak_mc ?? 0, mc ?? 0) || null;

    await pool.query(
      `INSERT INTO f2_scans (
         token_id, mc_usd, liq_usd, price_usd, holders, top10_pct,
         buys_5m, sells_5m, vol_5m, bundler_pct, sniper_pct, bot_pct,
         smart_count, kol_count, whale_pct, pass, fail_reasons, tape, score, phase
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
       )`,
      [
        row.id, mc, liq, reading.priceUsd, reading.holders, reading.top10Pct,
        reading.m5.buys, reading.m5.sells, reading.m5.volUsd,
        reading.bundlerHoldPct, reading.sniperHoldPct, reading.botHoldPct,
        reading.smartCount, reading.kolCount, reading.whaleHoldPct,
        verdict.fails.length === 0, JSON.stringify(verdict.fails),
        JSON.stringify({
          lead: verdict.tapeLead,
          holds: verdict.holds,
          fails: verdict.fails,
          unknowns: verdict.unknowns,
          factors: verdict.factors,
          m5: reading.m5,
          h1: reading.h1,
          h6: reading.h6,
          chase: verdict.chase,
          dead: verdict.dead,
          tradeOk: verdict.tradeOk,
        }),
        verdict.score, phase,
      ],
    );

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
         stage = CASE WHEN $10 = 'deceased' THEN 'killed' ELSE 'tracking' END,
         kill_reason = CASE WHEN $10 = 'deceased' THEN $7 ELSE kill_reason END,
         deceased_at = CASE WHEN $10 = 'deceased' AND phase IS DISTINCT FROM 'deceased' THEN NOW() ELSE deceased_at END,
         revived_at = CASE WHEN $10 = 'revived' AND phase IS DISTINCT FROM 'revived' THEN NOW() ELSE revived_at END,
         graduated = $11,
         admission_mc = COALESCE(admission_mc, $3)
       WHERE id = $1`,
      [
        row.id, verdict.fails.length === 0, mc, liq, reading.holders,
        verdict.score, verdict.fails[0] ?? verdict.holds[0] ?? "observed",
        JSON.stringify({ holds: verdict.holds, fails: verdict.fails, unknowns: verdict.unknowns }),
        verdict.tapeLead, phase, graduated,
      ],
    );

    const ticker = row.symbol || row.mint.slice(0, 6);
    const prev = row.phase || "intake";

    if (phase !== prev) {
      await agentNote("ward", "PHASE", `$${ticker} ${prev} → ${phase} (score ${verdict.score})`, {
        tokenId: row.id, mint: row.mint,
      });
      if (phase === "icu") {
        await raiseAlert({
          tokenId: row.id, kind: "critical",
          title: `ICU $${ticker}`,
          body: `Score ${verdict.score}. ${verdict.fails.slice(0, 3).join("; ") || "vitals slipping"}.`,
          payload: { mint: row.mint, score: verdict.score, fails: verdict.fails },
          telegram: true,
        });
      }
      if (phase === "deceased") {
        deaths += 1;
        await raiseAlert({
          tokenId: row.id, kind: "deceased",
          title: `DECEASED $${ticker}`,
          body: `Score ${verdict.score}. ${verdict.fails[0] ?? "vitals flatlined"}. Peak MC $${Math.round(peak ?? 0)}.`,
          payload: { mint: row.mint, score: verdict.score },
          telegram: true,
        });
      }
      if (phase === "revived") {
        await raiseAlert({
          tokenId: row.id, kind: "revived",
          title: `REVIVED $${ticker}`,
          body: `Buyers back. Score ${verdict.score}. MC ${mc != null ? `$${Math.round(mc)}` : "—"}.`,
          payload: { mint: row.mint, score: verdict.score },
          telegram: true,
        });
      }
    }

    if (verdict.tradeOk && prev !== "deceased") {
      const fired = await raiseAlert({
        tokenId: row.id, kind: "trade",
        title: `TRADE $${ticker}`,
        body: `Score ${verdict.score}. ${verdict.holds.slice(0, 2).join("; ")}. MC ${mc != null ? `$${Math.round(mc)}` : "—"} · ${row.wallet_buys} wallets.`,
        payload: {
          mint: row.mint, symbol: ticker, score: verdict.score, mc, liq,
          holders: reading.holders, tape: verdict.tapeLead, holds: verdict.holds,
          fails: verdict.fails, factors: verdict.factors,
          m5: reading.m5, h1: reading.h1, h6: reading.h6,
          top10: reading.top10Pct, bundlers: reading.bundlerHoldPct,
          bots: reading.botHoldPct, wallets: row.wallet_buys, phase,
        },
        telegram: false,
      });
      if (fired) {
        trades += 1;
        await tradeTelegram({
          symbol: ticker,
          mint: row.mint,
          score: verdict.score,
          phase,
          mc, liq,
          holders: reading.holders,
          wallets: row.wallet_buys,
          tape: verdict.tapeLead,
          holds: verdict.holds,
          fails: verdict.fails,
          factors: verdict.factors,
          m5: reading.m5,
          h1: reading.h1,
          h6: reading.h6,
          top10: reading.top10Pct,
          bundlers: reading.bundlerHoldPct,
          bots: reading.botHoldPct,
        });
        await pool.query(
          `INSERT INTO f2_calls (token_id, alert_mc, peak_mc, last_mc, safe, deep, telegram_sent, journal_until)
           VALUES ($1,$2,$2,$2, $3, $4, true, NOW() + INTERVAL '24 hours')
           ON CONFLICT (token_id) DO NOTHING`,
          [row.id, mc ?? 0, verdict.score >= 80, JSON.stringify(verdict)],
        );
        await agentNote("alerts", "TRADE", `$${ticker} trade gate — score ${verdict.score}`, {
          tokenId: row.id, mint: row.mint,
        });
      }
    }

    emitSse("vitals:tick", { id: row.id, phase, score: verdict.score });
  }

  return { scanned: rows.length, trades, deaths };
}
