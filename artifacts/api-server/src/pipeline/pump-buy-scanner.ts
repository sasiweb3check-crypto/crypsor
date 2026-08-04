/**
 * Pump-SDK buy scanner — scores tokens discovered via tracked-wallet buys only.
 *
 * Discovery source: token_buys (token:bought events + recent-buy refresh).
 * Market data: DexScreener /tokens/:mint (not DexScreener search discovery).
 * Scoring/labels: pump-fullend strategy engine (grade S–D, tags, buy/intra signals).
 * Persists sticky detection anchors + pump_scan_snapshots for gain/MC verification.
 */

import { db } from "@workspace/db";
import { tracked_tokens, token_price_snapshots, pump_scan_snapshots } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { pipelineQueue } from "../lib/job-queue";
import { invalidateCallsCaches } from "../lib/pro-cache";
import {
  buildPumpScanPayload,
  effectivePumpGain,
  parsePumpScan,
  pickBestSolanaPair,
  type DexPairLike,
  type PumpScanPayload,
} from "../lib/pump-sdk-score";
import { evaluatePumpAlerts } from "./pump-alerts";
import { eventBus, type TokenBoughtEvent } from "./event-bus";
import { healthMonitor } from "./health-monitor";

const log = logger.child({ module: "pump-buy-scanner" });

const SCAN_DELAY_MS = 8_000;
const REFRESH_INTERVAL_MS = 45_000;
const MAX_REFRESH_BATCH = 60;
const SNAPSHOT_MIN_GAP_MS = 45_000;
const PRUNE_EVERY_N = 40;

type PumpJob = { tokenId: number; tokenAddress: string; chain: string };

healthMonitor.register("pump-buy-scanner");

let scanCountSincePrune = 0;

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

function crossedGainThreshold(prev: PumpScanPayload | null, next: PumpScanPayload): boolean {
  const a = effectivePumpGain(prev ?? {});
  const b = effectivePumpGain(next);
  if (Math.abs(b - a) >= 15) return true;
  if (a < 50 && b >= 50) return true;
  if (a < 100 && b >= 100) return true;
  if (a >= 50 && b < 50) return true;
  return false;
}

async function writePumpSnapshot(tokenId: number, payload: PumpScanPayload): Promise<void> {
  try {
    // Throttle: skip if last snapshot < SNAPSHOT_MIN_GAP_MS ago (unless first)
    const recent = await db.execute(sql`
      SELECT EXTRACT(EPOCH FROM (NOW() - snapshot_at)) * 1000 AS age_ms
      FROM pump_scan_snapshots
      WHERE token_id = ${tokenId}
      ORDER BY snapshot_at DESC
      LIMIT 1
    `);
    const ageMs = Number((recent.rows[0] as { age_ms?: number } | undefined)?.age_ms ?? Infinity);
    if (ageMs < SNAPSHOT_MIN_GAP_MS) return;

    await db.insert(pump_scan_snapshots).values({
      tokenId,
      score: payload.score,
      grade: payload.grade,
      buySignal: payload.buySignal,
      intraSignal: payload.intraSignal,
      buyPassCount: payload.buyPassCount,
      intraPassCount: payload.intraPassCount,
      priceUsd: String(payload.priceUsd),
      marketCapUsd: String(payload.marketCap),
      liquidityUsd: String(payload.liquidityUsd),
      volume24hUsd: String(payload.volume24h),
      txns24h: payload.txns24h,
      priceAtDetection: String(payload.priceAtDetection),
      mcAtDetection: String(payload.mcAtDetection),
      gainSinceDetection: payload.gainSinceDetection,
      athGain: payload.athGain,
      mcGainSinceDetection: payload.mcGainSinceDetection,
      athMcGain: payload.athMcGain,
      payload: {
        scores: payload.scores,
        tags: payload.tags,
        buyConditions: payload.buyConditions,
        intraConditions: payload.intraConditions,
        detectedAt: payload.detectedAt,
        athPrice: payload.athPrice,
        athMc: payload.athMc,
        buyFiredAt: payload.buyFiredAt,
        intraFiredAt: payload.intraFiredAt,
      },
    });

    // Also keep token_price_snapshots warm for MC charts even if price-service lags
    await db.insert(token_price_snapshots).values({
      tokenId,
      priceUsd: String(payload.priceUsd),
      marketCapUsd: String(payload.marketCap),
      liquidityUsd: String(payload.liquidityUsd),
      volume24hUsd: String(payload.volume24h),
    }).catch(() => {});
  } catch (err) {
    log.warn({ err, tokenId }, "pump snapshot write failed");
  }
}

async function pruneOldSnapshots(): Promise<void> {
  try {
    await db.execute(sql`
      DELETE FROM pump_scan_snapshots
      WHERE snapshot_at < NOW() - INTERVAL '48 hours'
    `);
    // Cap per-token history to latest 120 rows
    await db.execute(sql`
      DELETE FROM pump_scan_snapshots p
      WHERE p.id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY snapshot_at DESC) AS rn
          FROM pump_scan_snapshots
        ) x
        WHERE x.rn > 120
      )
    `);
  } catch (err) {
    log.warn({ err }, "pump snapshot prune failed");
  }
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

    // Skip persist if we still have no usable price AND no MC (can't anchor detection)
    if (!(payload.priceUsd > 0 || payload.marketCap > 0)) {
      log.debug({ tokenId }, "skip pump scan — no price/mc yet");
      healthMonitor.ok("pump-buy-scanner", Date.now() - t0);
      return;
    }

    await db
      .update(tracked_tokens)
      .set({
        pumpScan: payload,
        pumpScanUpdatedAt: new Date(),
        priceUpdatedAt: new Date(),
        ...(payload.marketCap > 0
          ? { marketCapUsd: String(payload.marketCap) }
          : {}),
        ...(payload.priceUsd > 0
          ? { currentPriceUsd: String(payload.priceUsd) }
          : {}),
        ...(payload.athPrice > 0
          ? { athPriceUsd: String(payload.athPrice) }
          : {}),
        ...(payload.volume24h > 0
          ? { volume24hUsd: String(payload.volume24h) }
          : {}),
        ...(payload.liquidityUsd > 0
          ? { liquidityUsd: String(payload.liquidityUsd) }
          : {}),
        ...(payload.athMc > 0
          ? { athMarketCapUsd: String(payload.athMc) }
          : {}),
        // Only set detected price/MC anchors once (sticky on token row too)
        ...(!prev && payload.priceAtDetection > 0
          ? { detectedPriceUsd: String(payload.priceAtDetection) }
          : {}),
        gainPct: effectivePumpGain(payload),
        athGainPct: payload.mcAtDetection > 0 ? payload.athMcGain : payload.athGain,
      })
      .where(eq(tracked_tokens.id, tokenId));

    await writePumpSnapshot(tokenId, payload);

    // Notable pump alerts → Telegram + notification center
    await evaluatePumpAlerts(tokenId, payload);

    const changed =
      !prev
      || prev.grade !== payload.grade
      || prev.buySignal !== payload.buySignal
      || prev.intraSignal !== payload.intraSignal
      || Math.abs(prev.score - payload.score) >= 5
      || crossedGainThreshold(prev, payload);

    if (changed) {
      invalidateCallsCaches();
      eventBus.emit("calls:changed", {
        reason: "score",
        tokenId,
        at: new Date().toISOString(),
      });
    }

    scanCountSincePrune += 1;
    if (scanCountSincePrune >= PRUNE_EVERY_N) {
      scanCountSincePrune = 0;
      void pruneOldSnapshots();
    }

    log.info(
      {
        tokenId,
        grade: payload.grade,
        score: payload.score,
        buy: payload.buySignal,
        intra: payload.intraSignal,
        mcGain: Math.round(payload.mcGainSinceDetection),
        priceGain: Math.round(payload.gainSinceDetection),
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
    // Young detections (<2h): refresh every ~60s. Older: every 3 minutes.
    const rows = await db.execute(sql`
      SELECT t.id, t.address, t.chain
      FROM tracked_tokens t
      WHERE t.chain = 'solana'
        AND COALESCE(t.status, '') NOT IN ('ignored', 'archive')
        AND EXISTS (SELECT 1 FROM token_buys tb WHERE tb.token_id = t.id)
        AND t.last_buy_at > NOW() - INTERVAL '48 hours'
        AND (
          t.pump_scan IS NULL
          OR t.pump_scan_updated_at IS NULL
          OR (
            COALESCE((t.pump_scan->>'detectedAt')::bigint, 0) > (EXTRACT(EPOCH FROM NOW()) * 1000 - 7200000)
            AND t.pump_scan_updated_at < NOW() - INTERVAL '60 seconds'
          )
          OR (
            COALESCE((t.pump_scan->>'detectedAt')::bigint, 0) <= (EXTRACT(EPOCH FROM NOW()) * 1000 - 7200000)
            AND t.pump_scan_updated_at < NOW() - INTERVAL '3 minutes'
          )
        )
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
