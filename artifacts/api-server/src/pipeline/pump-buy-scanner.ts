/**
 * Pump-SDK buy scanner — scores tokens discovered via tracked-wallet buys only.
 *
 * Discovery source: token_buys (token:bought events + recent-buy refresh).
 * Market data: DexScreener /tokens/:mint (not DexScreener search discovery).
 * Scoring/labels: pump-fullend strategy engine (grade S–D, tags, buy/intra signals).
 */

import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { pipelineQueue } from "../lib/job-queue";
import { invalidateCallsCaches } from "../lib/pro-cache";
import {
  buildPumpScanPayload,
  parsePumpScan,
  pickBestSolanaPair,
  type DexPairLike,
  type PumpScanPayload,
} from "../lib/pump-sdk-score";
import { eventBus, type TokenBoughtEvent } from "./event-bus";
import { healthMonitor } from "./health-monitor";

const log = logger.child({ module: "pump-buy-scanner" });

const SCAN_DELAY_MS = 8_000;
const REFRESH_INTERVAL_MS = 90_000;
const MAX_REFRESH_BATCH = 40;

type PumpJob = { tokenId: number; tokenAddress: string; chain: string };

healthMonitor.register("pump-buy-scanner");

async function fetchDexPairsForMint(address: string): Promise<DexPairLike[]> {
  const resp = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!resp.ok) throw new Error(`DexScreener HTTP ${resp.status}`);
  const json = await resp.json() as { pairs?: DexPairLike[] };
  return Array.isArray(json.pairs) ? json.pairs : [];
}

async function scanBoughtToken(tokenId: number, tokenAddress: string, chain: string): Promise<void> {
  if ((chain || "").toLowerCase() !== "solana") return;

  const t0 = Date.now();
  try {
    const buyCheck = await db.execute(sql`
      SELECT 1 FROM token_buys WHERE token_id = ${tokenId} LIMIT 1
    `);
    if (!buyCheck.rows.length) {
      log.debug({ tokenId }, "skip pump scan — no token_buys row");
      return;
    }

    const pairs = await fetchDexPairsForMint(tokenAddress);
    const pair = pickBestSolanaPair(pairs);
    if (!pair) {
      log.debug({ tokenId, tokenAddress: tokenAddress.slice(0, 8) }, "no Dex pair yet");
      healthMonitor.ok("pump-buy-scanner", Date.now() - t0);
      return;
    }

    const prevRow = await db
      .select({ pumpScan: tracked_tokens.pumpScan })
      .from(tracked_tokens)
      .where(eq(tracked_tokens.id, tokenId))
      .limit(1);
    const prev = parsePumpScan(prevRow[0]?.pumpScan);
    const payload = buildPumpScanPayload(pair, prev);

    await db
      .update(tracked_tokens)
      .set({
        pumpScan: payload,
        pumpScanUpdatedAt: new Date(),
      })
      .where(eq(tracked_tokens.id, tokenId));

    const changed =
      !prev
      || prev.grade !== payload.grade
      || prev.buySignal !== payload.buySignal
      || prev.intraSignal !== payload.intraSignal
      || Math.abs(prev.score - payload.score) >= 5;

    if (changed) {
      invalidateCallsCaches();
      eventBus.emit("calls:changed", {
        reason: "score",
        tokenId,
        at: new Date().toISOString(),
      });
    }

    log.info(
      {
        tokenId,
        grade: payload.grade,
        score: payload.score,
        buy: payload.buySignal,
        intra: payload.intraSignal,
        tags: payload.tags.slice(0, 4).map((t) => t.label),
      },
      "pump-sdk scan (buy-sourced)",
    );
    healthMonitor.ok("pump-buy-scanner", Date.now() - t0);
  } catch (err) {
    healthMonitor.error("pump-buy-scanner", err);
    log.warn({ err, tokenId }, "pump-sdk scan failed");
  }
}

function enqueueScan(tokenId: number, tokenAddress: string, chain: string, delayMs = SCAN_DELAY_MS) {
  pipelineQueue.enqueue<PumpJob>(
    "pump",
    { tokenId, tokenAddress, chain },
    {
      priority: 6,
      delayMs,
      dedupKey: `pump-buy-scan:${tokenId}`,
    },
  );
}

async function refreshRecentBuys(): Promise<void> {
  const t0 = Date.now();
  try {
    const rows = await db.execute(sql`
      SELECT t.id, t.address, t.chain
      FROM tracked_tokens t
      WHERE t.chain = 'solana'
        AND COALESCE(t.status, '') NOT IN ('ignored', 'archive')
        AND EXISTS (SELECT 1 FROM token_buys tb WHERE tb.token_id = t.id)
        AND (
          t.pump_scan IS NULL
          OR t.pump_scan_updated_at IS NULL
          OR t.pump_scan_updated_at < NOW() - INTERVAL '3 minutes'
        )
        AND t.last_buy_at > NOW() - INTERVAL '48 hours'
      ORDER BY t.last_buy_at DESC NULLS LAST
      LIMIT ${MAX_REFRESH_BATCH}
    `);

    for (const r of rows.rows as Array<Record<string, unknown>>) {
      enqueueScan(Number(r.id), String(r.address), String(r.chain ?? "solana"), 0);
    }
    healthMonitor.ok("pump-buy-scanner", Date.now() - t0);
  } catch (err) {
    healthMonitor.error("pump-buy-scanner", err);
    log.warn({ err }, "pump-buy refresh failed");
  }
}

export function startPumpBuyScanner(): void {
  pipelineQueue.register<PumpJob>("pump", async (data) => {
    await scanBoughtToken(data.tokenId, data.tokenAddress, data.chain);
  });

  eventBus.on("token:bought", (e: TokenBoughtEvent) => {
    if ((e.chain || "").toLowerCase() !== "solana") return;
    enqueueScan(e.tokenId, e.tokenAddress, e.chain, SCAN_DELAY_MS);
  });

  setTimeout(() => { void refreshRecentBuys(); }, 20_000);
  setInterval(() => { void refreshRecentBuys(); }, REFRESH_INTERVAL_MS);

  log.info({ refreshMs: REFRESH_INTERVAL_MS }, "pump-buy-scanner started (buys-only)");
}

export type { PumpScanPayload };
