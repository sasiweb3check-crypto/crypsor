/**
 * ATH Backfill Script
 *
 * For every pro_call, fetches GMGN 5-minute klines from called_at → now,
 * finds the highest MC candle (price × 1B for pump.fun tokens), and updates
 * pro_calls.ath_multiple with the correct value.
 *
 * Run:  npx tsx src/scripts/backfill-ath.ts
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { gmgnFetch, nextProxy } from "../lib/gmgn-client";

const SOL_SUPPLY = 1_000_000_000; // pump.fun token total supply

// Delay between GMGN requests to avoid 429s
const DELAY_MS = 1_200;

interface ProCallRow {
  id: number;
  token_id: number;
  address: string;
  chain: string;
  called_mc_usd: string;
  ath_multiple: number;
  called_at: Date;
  symbol: string;
  current_mc: string | null;
}

interface Candle {
  open: string;
  close: string;
  high: string;
  low: string;
  time: number | string; // ms
  volume: string;
}

async function fetchKlines(
  address: string,
  fromUnixSec: number,
  toUnixSec: number,
): Promise<Candle[]> {
  const url =
    `https://gmgn.ai/defi/quotation/v1/tokens/kline/sol/${address}` +
    `?resolution=5m&from=${fromUnixSec}&to=${toUnixSec}`;

  const res = await gmgnFetch(url, nextProxy());
  if (!res.ok) return [];

  // Response shape: { data: Candle[] } or { bars: Candle[] }
  const raw = res.data as Record<string, unknown>;
  const candles = (raw?.data ?? raw?.bars ?? []) as Candle[];
  return Array.isArray(candles) ? candles : [];
}

function priceToMc(price: string | number): number {
  const p = typeof price === "string" ? parseFloat(price) : price;
  if (!isFinite(p) || p <= 0) return 0;
  return p * SOL_SUPPLY;
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("Loading pro_calls…");

  const rows = await db.execute<ProCallRow>(sql`
    SELECT
      pc.id,
      pc.token_id,
      pc.called_mc_usd,
      pc.ath_multiple,
      pc.called_at,
      t.address,
      t.chain,
      t.symbol,
      t.market_cap_usd AS current_mc
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    ORDER BY pc.called_at DESC
  `);

  const calls = rows.rows;
  console.log(`Found ${calls.length} pro_calls to backfill\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  const nowSec = Math.floor(Date.now() / 1000);

  for (const call of calls) {
    const calledMc = parseFloat(call.called_mc_usd ?? "0") || 0;
    if (calledMc <= 0) {
      console.log(`[${call.symbol ?? call.id}] skip — no called_mc_usd`);
      skipped++;
      continue;
    }

    const calledAtSec = Math.floor(new Date(call.called_at).getTime() / 1000);

    // Also grab current MC from tracked_tokens as a data point
    const currentMcRaw = parseFloat(call.current_mc ?? "0") || 0;
    const currentRatio = currentMcRaw > 0 ? currentMcRaw / calledMc : 0;

    let klineAthMc = 0;
    let klineCount = 0;

    try {
      // Only fetch klines for SOL chain (all pump.fun tokens are SOL)
      const chain = (call.chain ?? "solana").toLowerCase();
      if (chain === "solana" || chain === "sol") {
        const candles = await fetchKlines(call.address, calledAtSec, nowSec);
        klineCount = candles.length;

        for (const c of candles) {
          // Filter to candles strictly after called_at
          const candleTimeSec = typeof c.time === "number"
            ? Math.floor(c.time > 1e12 ? c.time / 1000 : c.time)
            : Math.floor(parseInt(String(c.time)) / 1000);

          if (candleTimeSec < calledAtSec) continue;

          const highMc = priceToMc(c.high);
          if (highMc > klineAthMc) klineAthMc = highMc;
        }
      }
    } catch (err) {
      console.error(`[${call.symbol ?? call.id}] kline fetch error:`, err);
      errors++;
    }

    const klineRatio  = klineAthMc > 0 ? klineAthMc / calledMc : 0;
    const existingAth = call.ath_multiple ?? 1;

    const newAth = Math.max(existingAth, currentRatio, klineRatio, 1);
    const improved = newAth > existingAth + 0.01;

    const label = `${call.symbol ?? "?"} (id=${call.id})`;
    if (improved) {
      await db.execute(sql`
        UPDATE pro_calls
        SET ath_multiple = ${newAth}, last_snapshot_at = NOW()
        WHERE id = ${call.id}
      `);
      console.log(
        `✓ ${label.padEnd(22)} | called=$${Math.round(calledMc).toLocaleString()} ` +
        `| klineCandles=${klineCount} | klineATH=$${Math.round(klineAthMc).toLocaleString()} ` +
        `| currentMC=$${Math.round(currentMcRaw).toLocaleString()} ` +
        `| ${existingAth.toFixed(2)}× → ${newAth.toFixed(2)}×`
      );
      updated++;
    } else {
      console.log(
        `- ${label.padEnd(22)} | ATH unchanged ${existingAth.toFixed(2)}× (kline=${klineRatio.toFixed(2)}× cur=${currentRatio.toFixed(2)}×)`
      );
      skipped++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n✅ Done — updated=${updated}, unchanged=${skipped}, errors=${errors}`);

  // Print final stats
  const stats = await db.execute(sql`
    SELECT
      COUNT(*)                                                    AS total,
      COUNT(CASE WHEN ath_multiple >= 2   THEN 1 END)            AS wins,
      COUNT(CASE WHEN ath_multiple >= 2   THEN 1 END) * 100.0
        / NULLIF(COUNT(*),0)                                      AS win_rate,
      COUNT(CASE WHEN ath_multiple >= 2   THEN 1 END)            AS x2,
      COUNT(CASE WHEN ath_multiple >= 3   THEN 1 END)            AS x3,
      COUNT(CASE WHEN ath_multiple >= 5   THEN 1 END)            AS x5,
      COUNT(CASE WHEN ath_multiple >= 10  THEN 1 END)            AS x10,
      ROUND(MAX(ath_multiple)::numeric, 2)                        AS best
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    WHERE CAST(NULLIF(t.market_cap_usd,'') AS NUMERIC) >= 5000
  `);
  console.log("\nPost-backfill stats (MC >= $5K):");
  console.table(stats.rows);

  process.exit(0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
