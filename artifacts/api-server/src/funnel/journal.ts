/**
 * Stage 4 — JOURNAL (every 30s per called token for 24h).
 *
 * Full snapshot: price, mcap, liquidity, holders, bot rate, smart money,
 * whales. Powers:
 *   1. the vault dashboard (alert MC → peak MC → peak X, win rate)
 *   2. filter refinement (what separates runners from losers)
 *   3. future backtests with realistic slippage from on-chain flow
 */
import { pool } from "../core/db";
import { logger } from "../core/log";
import { emitSse } from "../core/bus";
import { pairsForMints } from "../sources/dexscreener";
import { coin as pumpCoin, virtualLiqUsd } from "../sources/pumpfun";
import { tokenIntel, type TokenIntel } from "../sources/gmgn";

const log = logger.child({ module: "journal" });

const INTEL_EVERY_N = 4;           // GMGN intel every ~4th journal tick per token
const intelTick = new Map<number, number>();
const lastIntel = new Map<number, TokenIntel>();

type ActiveCall = {
  call_id: number;
  token_id: number;
  mint: string;
  peak_mc: number;
};

export async function journalTick(): Promise<{ journaled: number }> {
  const active = await pool.query(
    `SELECT c.id AS call_id, c.token_id, t.mint, c.peak_mc
     FROM f2_calls c JOIN f2_tokens t ON t.id = c.token_id
     WHERE c.journal_until > NOW()
       AND (c.last_seen_at IS NULL OR c.last_seen_at < NOW() - INTERVAL '25 seconds')
     ORDER BY c.called_at DESC
     LIMIT 20`,
  );
  const rows = active.rows as ActiveCall[];
  if (!rows.length) return { journaled: 0 };

  const pairs = await pairsForMints(rows.map((r) => r.mint));
  let journaled = 0;

  for (const c of rows) {
    try {
      const pair = pairs.get(c.mint) ?? null;
      let mc = pair?.marketCap ?? pair?.fdv ?? null;
      let liq = pair?.liquidity?.usd ?? null;
      let price = pair?.priceUsd != null ? parseFloat(pair.priceUsd) : null;
      if (mc == null) {
        const pc = await pumpCoin(c.mint);
        if (pc?.usd_market_cap) {
          mc = pc.usd_market_cap;
          liq = liq ?? virtualLiqUsd(pc);
          price = price ?? pc.usd_market_cap / 1e9;
        }
      }
      if (mc == null || mc <= 0) {
        await pool.query("UPDATE f2_calls SET last_seen_at = NOW() WHERE id = $1", [c.call_id]);
        continue;
      }

      // Holder/bot intel on a slower cadence (GMGN quota)
      const n = (intelTick.get(c.call_id) ?? 0) + 1;
      intelTick.set(c.call_id, n);
      let intel = lastIntel.get(c.call_id) ?? null;
      if (n % INTEL_EVERY_N === 1) {
        const fresh = await tokenIntel(c.mint);
        if (fresh) {
          intel = fresh;
          lastIntel.set(c.call_id, fresh);
        }
      }

      await pool.query(
        `INSERT INTO f2_journal (call_id, price_usd, mc_usd, liq_usd, holders, bot_pct,
           smart_count, whale_pct, buys_5m, sells_5m, vol_5m)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [c.call_id, price, mc, liq,
          intel?.holderCount ?? null, intel?.botHoldPct ?? null,
          intel?.smartCount ?? null, intel?.whaleHoldPct ?? null,
          pair?.txns?.m5?.buys ?? null, pair?.txns?.m5?.sells ?? null,
          pair?.volume?.m5 ?? null],
      );

      const newPeak = Math.max(Number(c.peak_mc ?? 0), mc);
      await pool.query(
        `UPDATE f2_calls SET last_mc = $2, last_seen_at = NOW(),
           peak_mc = $3, peak_at = CASE WHEN $3 > peak_mc THEN NOW() ELSE peak_at END
         WHERE id = $1`,
        [c.call_id, mc, newPeak],
      );
      journaled += 1;
    } catch (err) {
      log.warn({ err, mint: c.mint.slice(0, 8) }, "journal snapshot failed");
    }
  }

  if (journaled) emitSse("journal:tick", { count: journaled, at: new Date().toISOString() });
  return { journaled };
}

/** Prune journal + scans older than 7 days (free-tier DB hygiene). */
export async function pruneOld(): Promise<void> {
  try {
    await pool.query("DELETE FROM f2_journal WHERE at < NOW() - INTERVAL '7 days'");
    await pool.query("DELETE FROM f2_scans WHERE at < NOW() - INTERVAL '7 days'");
    await pool.query(
      "DELETE FROM f2_tokens WHERE stage = 'killed' AND discovered_at < NOW() - INTERVAL '7 days' AND wallet_buys = 0",
    );
  } catch (err) {
    log.warn({ err }, "prune failed");
  }
}
