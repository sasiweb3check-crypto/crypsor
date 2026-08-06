/**
 * Stage 3 — DEEP DIVE (one shot per promoted token).
 *
 * Fresh GMGN intel + security/creator read → the deepDive gate.
 * Pass → f2_calls row (the ALERT) + Telegram + journaling begins.
 * Fail → killed with the reason recorded (journal fuel).
 */
import { pool } from "../core/db";
import { logger } from "../core/log";
import { emitSse } from "../core/bus";
import { esc, sendTelegram } from "../core/telegram";
import { tokenIntel, tokenSecurity } from "../sources/gmgn";
import { coin as pumpCoin } from "../sources/pumpfun";
import { pairsForMints } from "../sources/dexscreener";
import { deepDive, T } from "./filters";

const log = logger.child({ module: "deepdive" });

const fmtUsd = (v: number | null | undefined) =>
  v == null ? "?" : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`;

export async function runDeepDive(tokenId: number): Promise<void> {
  const tr = await pool.query(
    "SELECT id, mint, symbol, name, wallet_buys, stage FROM f2_tokens WHERE id = $1",
    [tokenId],
  );
  const t = tr.rows[0] as { id: number; mint: string; symbol: string | null; name: string | null; wallet_buys: number; stage: string } | undefined;
  if (!t || t.stage !== "deepdive") return;

  const [intel, sec] = await Promise.all([tokenIntel(t.mint), tokenSecurity(t.mint)]);

  const result = deepDive({
    rugRatio: sec.rugRatio,
    honeypot: sec.honeypot,
    top10Pct: intel?.top10Pct ?? (sec.top10Rate != null ? (sec.top10Rate > 1 ? sec.top10Rate : sec.top10Rate * 100) : null),
    bundlerHoldPct: intel?.bundlerHoldPct ?? null,
    smartCount: intel?.smartCount ?? null,
    kolCount: intel?.kolCount ?? null,
    walletBuys: Number(t.wallet_buys ?? 0),
    securityFetched: sec.fetched,
  });

  if (!result.pass) {
    await pool.query(
      "UPDATE f2_tokens SET stage='killed', kill_reason=$2 WHERE id=$1",
      [t.id, `deepdive:${result.reasons[0] ?? "fail"}`],
    );
    emitSse("funnel:activity", {
      kind: "killed", mint: t.mint, symbol: t.symbol,
      reason: `deepdive:${result.reasons.join(",")}`, at: new Date().toISOString(),
    });
    return;
  }

  // Current MC for the alert anchor
  let mc: number | null = null;
  const pairs = await pairsForMints([t.mint]);
  mc = pairs.get(t.mint)?.marketCap ?? pairs.get(t.mint)?.fdv ?? null;
  if (mc == null) {
    const pc = await pumpCoin(t.mint);
    mc = pc?.usd_market_cap ?? null;
  }
  if (mc == null || mc <= 0) {
    await pool.query(
      "UPDATE f2_tokens SET stage='killed', kill_reason='no_market_data_at_call' WHERE id=$1",
      [t.id],
    );
    return;
  }

  const deep = {
    ...result,
    intel: intel ? {
      holders: intel.holderCount, top10: intel.top10Pct,
      smart: intel.smartCount, kol: intel.kolCount,
      smartHold: intel.smartHoldPct, kolHold: intel.kolHoldPct,
      bundlerHold: intel.bundlerHoldPct, sniperHold: intel.sniperHoldPct,
    } : null,
    security: { rugRatio: sec.rugRatio, honeypot: sec.honeypot, creatorTokens: sec.creatorTokens },
  };

  const ins = await pool.query(
    `INSERT INTO f2_calls (token_id, alert_mc, peak_mc, last_mc, safe, deep, journal_until, peak_at, last_seen_at)
     VALUES ($1,$2,$2,$2,$3,$4,NOW() + INTERVAL '${T.JOURNAL_HOURS} hours',NOW(),NOW())
     ON CONFLICT (token_id) DO NOTHING
     RETURNING id`,
    [t.id, mc, result.safe, JSON.stringify(deep)],
  );
  if (!ins.rows.length) return;
  const callId = Number(ins.rows[0].id);

  await pool.query("UPDATE f2_tokens SET stage='called' WHERE id=$1", [t.id]);

  const sym = t.symbol || t.name || t.mint.slice(0, 6);
  const tgText = [
    `*${esc(result.safe ? "SAFE SIGNAL" : "SIGNAL")}*`,
    `$${esc(sym)} · MC ${esc(fmtUsd(mc))}`,
    esc(result.reasons.join(" · ")),
    `[GMGN](${esc(`https://gmgn.ai/sol/token/${t.mint}`)}) · [pump](${esc(`https://pump.fun/coin/${t.mint}`)})`,
  ].join("\n");
  const sent = await sendTelegram(tgText);
  if (sent) {
    await pool.query("UPDATE f2_calls SET telegram_sent = true WHERE id = $1", [callId]);
  }

  emitSse("call:new", {
    callId, tokenId: t.id, mint: t.mint, symbol: t.symbol,
    alertMc: mc, safe: result.safe, at: new Date().toISOString(),
  });
  log.info({ mint: t.mint.slice(0, 8), sym, mc, safe: result.safe }, "CALL fired");
}
