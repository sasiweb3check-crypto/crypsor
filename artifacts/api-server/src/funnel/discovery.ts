/**
 * Stage 1 — DISCOVERY (every ~30s while warm).
 *
 * Sources:
 *   pump_live   pump.fun currently-live (actively trading bonding tokens)
 *   pump_new    pump.fun newest launches
 *   wallet_buy  tracked wallets' buys via Helius (human alpha; bypasses
 *               baseline MC/age cuts — if a tracked wallet bought, we track)
 *
 * Baseline filters cut the universe fast; survivors enter stage=tracking.
 */
import { pool } from "../core/db";
import { logger } from "../core/log";
import { emitSse } from "../core/bus";
import { currentlyLive, newestCoins, type PumpCoin } from "../sources/pumpfun";
import { recentBuys } from "../sources/helius";
import { T } from "./filters";

const log = logger.child({ module: "discovery" });

let walletCursor = 0;

async function upsertToken(opts: {
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  source: string;
  createdTs: number | null;
  mc: number | null;
  graduated: boolean;
  walletBuy?: boolean;
}): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO f2_tokens (mint, symbol, name, image, source, created_ts, mc_at_discovery, graduated, wallet_buys)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (mint) DO UPDATE SET
       wallet_buys = CASE WHEN $9 > 0 AND f2_tokens.wallet_buys < 8
                          THEN f2_tokens.wallet_buys + $9 ELSE f2_tokens.wallet_buys END,
       symbol = COALESCE(f2_tokens.symbol, EXCLUDED.symbol),
       name = COALESCE(f2_tokens.name, EXCLUDED.name),
       image = COALESCE(f2_tokens.image, EXCLUDED.image),
       stage = CASE WHEN f2_tokens.stage = 'killed' AND $9 > 0
                    THEN 'tracking' ELSE f2_tokens.stage END
     RETURNING (xmax = 0) AS inserted`,
    [opts.mint, opts.symbol, opts.name, opts.image, opts.source,
      opts.createdTs ? new Date(opts.createdTs) : null, opts.mc, opts.graduated,
      opts.walletBuy ? 1 : 0],
  );
  return Boolean(r.rows[0]?.inserted);
}

function baselinePass(c: PumpCoin): string | null {
  const mc = c.usd_market_cap ?? 0;
  if (mc < T.MC_MIN) return "mc_too_small";
  if (mc > T.MC_MAX) return "mc_too_big";
  if (c.created_timestamp && Date.now() - c.created_timestamp > T.AGE_MAX_H * 3600_000) {
    return "too_old";
  }
  if (!c.symbol && !c.name) return "no_identity";
  return null;
}

export async function discoveryTick(): Promise<{ seen: number; entered: number }> {
  let seen = 0;
  let entered = 0;

  // ── pump.fun feeds ──
  const [live, fresh] = await Promise.all([currentlyLive(48), newestCoins(24)]);
  const coins = new Map<string, { c: PumpCoin; source: string }>();
  for (const c of live) if (c.mint) coins.set(c.mint, { c, source: "pump_live" });
  for (const c of fresh) if (c.mint && !coins.has(c.mint)) coins.set(c.mint, { c, source: "pump_new" });

  for (const { c, source } of coins.values()) {
    seen += 1;
    if (baselinePass(c) != null) continue;
    const isNew = await upsertToken({
      mint: c.mint,
      symbol: c.symbol ?? null,
      name: c.name ?? null,
      image: c.image_uri ?? null,
      source,
      createdTs: c.created_timestamp ?? null,
      mc: c.usd_market_cap ?? null,
      graduated: Boolean(c.complete),
    });
    if (isNew) {
      entered += 1;
      emitSse("funnel:activity", {
        kind: "discovered", mint: c.mint, symbol: c.symbol, source,
        mc: c.usd_market_cap, at: new Date().toISOString(),
      });
    }
  }

  // ── tracked wallet buys (2 wallets per tick, round-robin — Helius quota) ──
  try {
    const wallets = await pool.query(
      "SELECT address FROM walletdatasource WHERE chain = 'solana' ORDER BY id",
    );
    const list = wallets.rows.map((r) => String(r.address));
    if (list.length) {
      const batch = [list[walletCursor % list.length], list[(walletCursor + 1) % list.length]]
        .filter((v, i, a) => a.indexOf(v) === i);
      walletCursor += 2;
      for (const w of batch) {
        const buys = await recentBuys(w, 20);
        for (const b of buys) {
          if (Date.now() - b.ts > 6 * 3600_000) continue; // only fresh buys
          seen += 1;
          const isNew = await upsertToken({
            mint: b.mint, symbol: null, name: null, image: null,
            source: "wallet_buy", createdTs: null, mc: null,
            graduated: false, walletBuy: true,
          });
          if (isNew) {
            entered += 1;
            emitSse("funnel:activity", {
              kind: "wallet_buy", mint: b.mint, wallet: b.wallet.slice(0, 6),
              at: new Date().toISOString(),
            });
          }
        }
      }
    }
  } catch (err) {
    log.warn({ err }, "wallet buy discovery failed");
  }

  if (entered > 0) log.info({ seen, entered }, "discovery tick");
  return { seen, entered };
}
