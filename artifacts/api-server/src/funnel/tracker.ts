/**
 * Stage 2 — TRACKING (survivors watched across multiple scans).
 *
 * Each scan records the full reading into f2_scans (the evidence journal
 * that later refines the filters), evaluates the tracking gate, and:
 *   - pass_streak reaches PROMOTE_PASSES → stage=deepdive
 *   - fail_streak reaches KILL_FAIL_STREAK / too old / MC floor → killed
 *
 * Market data: Dexscreener batch for graduated tokens, pump.fun for bonding.
 * Holder intel: GMGN (rate-limited — intel refreshes roughly every other
 * scan per token; readings carry the last known values forward).
 */
import { pool } from "../core/db";
import { logger } from "../core/log";
import { emitSse } from "../core/bus";
import { pairsForMints } from "../sources/dexscreener";
import { coin as pumpCoin, virtualLiqUsd } from "../sources/pumpfun";
import { tokenIntel, type TokenIntel } from "../sources/gmgn";
import { T, trackingFailures } from "./filters";
import { runDeepDive } from "./deepdive";

const log = logger.child({ module: "tracker" });

const BATCH = 14;               // tokens per tick
const INTEL_BUDGET = 5;         // GMGN intel fetches per tick (3 calls each)
const intelCache = new Map<string, { intel: TokenIntel; at: number }>();
const INTEL_TTL = 120_000;

type TrackRow = {
  id: number;
  mint: string;
  symbol: string | null;
  source: string;
  graduated: boolean;
  wallet_buys: number;
  pass_streak: number;
  fail_streak: number;
  scans_total: number;
  created_ts: Date | null;
  discovered_at: Date;
};

async function lastScan(tokenId: number): Promise<{ holders: number | null } | null> {
  const r = await pool.query(
    "SELECT holders FROM f2_scans WHERE token_id = $1 ORDER BY at DESC LIMIT 1",
    [tokenId],
  );
  return r.rows[0] ? { holders: r.rows[0].holders as number | null } : null;
}

async function getIntel(mint: string, budget: { left: number }): Promise<TokenIntel | null> {
  const hit = intelCache.get(mint);
  if (hit && Date.now() - hit.at < INTEL_TTL) return hit.intel;
  if (budget.left <= 0) return hit?.intel ?? null;
  budget.left -= 1;
  const intel = await tokenIntel(mint);
  if (intel) intelCache.set(mint, { intel, at: Date.now() });
  if (intelCache.size > 400) {
    const oldest = [...intelCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 80);
    for (const [k] of oldest) intelCache.delete(k);
  }
  return intel ?? hit?.intel ?? null;
}

export async function trackerTick(): Promise<{ scanned: number; promoted: number; killed: number }> {
  const due = await pool.query(
    `SELECT id, mint, symbol, source, graduated, wallet_buys, pass_streak,
            fail_streak, scans_total, created_ts, discovered_at
     FROM f2_tokens
     WHERE stage = 'tracking'
       AND (last_scan_at IS NULL OR last_scan_at < NOW() - INTERVAL '35 seconds')
     ORDER BY wallet_buys DESC, last_scan_at ASC NULLS FIRST
     LIMIT ${BATCH}`,
  );
  const rows = due.rows as TrackRow[];
  if (!rows.length) return { scanned: 0, promoted: 0, killed: 0 };

  const pairs = await pairsForMints(rows.map((r) => r.mint));
  const budget = { left: INTEL_BUDGET };
  let promoted = 0;
  let killed = 0;

  for (const t of rows) {
    try {
      const pair = pairs.get(t.mint) ?? null;
      let mc = pair?.marketCap ?? pair?.fdv ?? null;
      let liq = pair?.liquidity?.usd ?? null;
      let price = pair?.priceUsd != null ? parseFloat(pair.priceUsd) : null;
      let graduated = t.graduated || pair != null;

      // Bonding tokens: pump.fun fallback for market state
      if (mc == null) {
        const pc = await pumpCoin(t.mint);
        if (pc?.usd_market_cap) {
          mc = pc.usd_market_cap;
          liq = liq ?? virtualLiqUsd(pc);
          price = price ?? (pc.usd_market_cap / 1e9);
          graduated = Boolean(pc.complete);
        }
      }

      const intel = await getIntel(t.mint, budget);
      const prev = await lastScan(t.id);

      const reading = {
        mcUsd: mc,
        liqUsd: liq ?? intel?.liqUsd ?? null,
        holders: intel?.holderCount ?? null,
        prevHolders: prev?.holders ?? null,
        top10Pct: intel?.top10Pct ?? null,
        buys5m: pair?.txns?.m5?.buys ?? null,
        sells5m: pair?.txns?.m5?.sells ?? null,
        vol5m: pair?.volume?.m5 ?? null,
        bundlerHoldPct: intel?.bundlerHoldPct ?? null,
        sniperHoldPct: intel?.sniperHoldPct ?? null,
        botHoldPct: intel?.botHoldPct ?? null,
        graduated,
        source: t.source,
      };
      const fails = trackingFailures(reading);
      const pass = fails.length === 0;

      await pool.query(
        `INSERT INTO f2_scans (token_id, mc_usd, liq_usd, price_usd, holders, top10_pct,
           buys_5m, sells_5m, vol_5m, bundler_pct, sniper_pct, bot_pct,
           smart_count, kol_count, pass, fail_reasons)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [t.id, reading.mcUsd, reading.liqUsd, price, reading.holders, reading.top10Pct,
          reading.buys5m, reading.sells5m, reading.vol5m,
          reading.bundlerHoldPct, reading.sniperHoldPct, reading.botHoldPct,
          intel?.smartCount ?? null, intel?.kolCount ?? null,
          pass, JSON.stringify(fails)],
      );

      const passStreak = pass ? t.pass_streak + 1 : 0;
      const failStreak = pass ? 0 : t.fail_streak + 1;

      // Kill checks
      const ageH = (Date.now() - new Date(t.created_ts ?? t.discovered_at).getTime()) / 3600_000;
      let killReason: string | null = null;
      if (failStreak >= T.KILL_FAIL_STREAK) killReason = `failed_${failStreak}_scans:${fails[0] ?? ""}`;
      else if (ageH > T.KILL_AGE_H) killReason = "aged_out";
      else if (mc != null && mc < T.KILL_MC_FLOOR && t.wallet_buys === 0) killReason = "mc_collapsed";

      if (killReason) {
        await pool.query(
          `UPDATE f2_tokens SET stage='killed', kill_reason=$2, pass_streak=$3, fail_streak=$4,
             scans_total=scans_total+1, last_scan_at=NOW() WHERE id=$1`,
          [t.id, killReason, passStreak, failStreak],
        );
        killed += 1;
        emitSse("funnel:activity", {
          kind: "killed", mint: t.mint, symbol: t.symbol, reason: killReason,
          at: new Date().toISOString(),
        });
        continue;
      }

      const promote = passStreak >= T.PROMOTE_PASSES;
      // Backfill identity for wallet-buy discoveries (Helius gives only the mint)
      const sym = t.symbol ?? pair?.baseToken?.symbol ?? null;
      const nm = pair?.baseToken?.name ?? null;
      await pool.query(
        `UPDATE f2_tokens SET
           stage = $2, pass_streak = $3, fail_streak = $4,
           scans_total = scans_total + 1,
           scans_passed = scans_passed + $5,
           graduated = $6,
           symbol = COALESCE(symbol, $7),
           name = COALESCE(name, $8),
           last_scan_at = NOW()
         WHERE id = $1`,
        [t.id, promote ? "deepdive" : "tracking", passStreak, failStreak, pass ? 1 : 0, graduated, sym, nm],
      );

      if (promote) {
        promoted += 1;
        emitSse("funnel:activity", {
          kind: "promoted", mint: t.mint, symbol: t.symbol,
          at: new Date().toISOString(),
        });
        // Deep dive immediately — the window is now
        void runDeepDive(t.id).catch((err) => log.warn({ err, id: t.id }, "deepdive failed"));
      }
    } catch (err) {
      log.warn({ err, mint: t.mint.slice(0, 8) }, "scan failed");
      await pool.query("UPDATE f2_tokens SET last_scan_at = NOW() WHERE id = $1", [t.id]);
    }
  }

  return { scanned: rows.length, promoted, killed };
}
