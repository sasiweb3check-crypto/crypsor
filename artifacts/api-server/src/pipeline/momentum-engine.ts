import { db } from "@workspace/db";
import { tracked_tokens, token_buys } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus, type TokenBoughtEvent } from "./event-bus";
import { healthMonitor } from "./health-monitor";

const MIN = 60_000;

// ── Normalization helpers ──────────────────────────────────────────────────────

function minMaxNorm(values: number[], val: number): number {
  if (values.length === 0) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 50;
  return Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
}

function stddev(vals: number[]): number {
  if (vals.length < 2) return 1;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  return Math.sqrt(variance) || 1;
}

// ── Raw signal extraction ─────────────────────────────────────────────────────

function extractRawSignals(t: {
  momentum5m: number; momentum15m: number; momentum30m: number;
  momentum1h: number; momentum6h: number; momentum24h: number;
  buyPressure: number;
  holderCount: number; holderKolCount: number; holderSmartCount: number;
  holderMomentumScore: number;
  gainPct: number | null;
  liquidityUsd: string | null;
  firstDetectedAt: Date;
}) {
  const rawPrice = t.momentum5m * 3 + t.momentum1h * 0.5 + t.momentum6h * 0.1;
  const rawVolume = (t.momentum1h * 6) / Math.max(t.momentum24h, 1);
  const rawBuyPressure = t.buyPressure;
  const kolSmartDensity =
    (t.holderKolCount + t.holderSmartCount) / Math.max(t.holderCount, 1);
  const rawHolder = kolSmartDensity * 60 + t.holderMomentumScore * 0.4;
  const liqUsd = t.liquidityUsd ? parseFloat(t.liquidityUsd) : null;
  const lowLiquidityFlag = liqUsd !== null && liqUsd < 10_000;
  return { rawPrice, rawVolume, rawBuyPressure, rawHolder, lowLiquidityFlag, liqUsd };
}

// ── Build final 0-100 momentum object from normalised signals ─────────────────

function buildMomentum(
  t: {
    momentum5m: number; momentum15m: number; momentum30m: number;
    momentum1h: number; momentum6h: number; momentum24h: number;
    gainPct: number | null;
    firstDetectedAt: Date;
    lowLiquidityFlag: boolean;
  },
  normed: { price: number; volume: number; buyPressure: number; holder: number },
) {
  const { price, volume, buyPressure, holder } = normed;
  const liqComponent = 0;

  const compositeMomentum = Math.min(100, Math.max(0,
    0.30 * price + 0.25 * volume + 0.25 * buyPressure + 0.15 * holder + 0.05 * liqComponent
  ));

  const perFiveRates = [
    t.momentum5m,
    t.momentum15m / 3,
    t.momentum30m / 6,
    t.momentum1h  / 12,
  ];
  const sd = stddev(perFiveRates);
  const volatilityAdjMomentum = Math.min(100, Math.max(0,
    compositeMomentum / Math.max(sd / 5 + 1, 1)
  ));

  const ageHours = (Date.now() - t.firstDetectedAt.getTime()) / 3_600_000;
  const earlyBias = ageHours <= 1 ? 1.3 : ageHours <= 2 ? 1.15 : 1.0;
  const earlyMomentum = Math.min(100, Math.max(0,
    (0.6 * price + 0.3 * volume + 0.1 * holder) * earlyBias
  ));

  const h6Ratio = t.momentum6h / Math.max(t.momentum1h * 6, 1);
  const sustainedMomentum = Math.min(100, Math.max(0,
    0.4 * price * Math.min(1, h6Ratio) + 0.4 * volume + 0.2 * holder
  ));

  const recentSpike = t.momentum5m / Math.max(t.momentum1h / 12 + 0.01, 1);
  const gainRecovery = Math.min(100, Math.max(0, t.gainPct ?? 0));
  const revivalPotential = Math.min(100, Math.max(0,
    0.5 * Math.min(100, recentSpike * 20) + 0.3 * buyPressure + 0.2 * gainRecovery
  ));

  const round1 = (n: number) => Math.round(n * 10) / 10;

  return {
    compositeMomentum:      round1(compositeMomentum),
    priceMomentum:          round1(price),
    volumeMomentum:         round1(volume),
    buyPressureMomentum:    round1(buyPressure),
    holderMomentumComputed: round1(holder),
    liquidityMomentum:      null as number | null,
    volatilityAdjMomentum:  round1(volatilityAdjMomentum),
    earlyMomentum:          round1(earlyMomentum),
    sustainedMomentum:      round1(sustainedMomentum),
    revivalPotential:       round1(revivalPotential),
    lowLiquidityFlag:       t.lowLiquidityFlag,
  };
}

// ── Fetch buy-window counts from the buy log ──────────────────────────────────

async function fetchBuyCounts(tokenId: number) {
  const buys = await db
    .select({ boughtAt: token_buys.boughtAt })
    .from(token_buys)
    .where(eq(token_buys.tokenId, tokenId));

  const now = Date.now();
  const cnt = (ms: number) =>
    buys.filter(b => now - new Date(b.boughtAt).getTime() <= ms).length;

  return {
    m5:  cnt(5   * MIN),
    m15: cnt(15  * MIN),
    m30: cnt(30  * MIN),
    m1h: cnt(60  * MIN),
    m6h: cnt(360 * MIN),
    m24h: cnt(1440 * MIN),
  };
}

// ── Single-token update (on buy event) ───────────────────────────────────────

async function updateMomentumOnBuy(e: TokenBoughtEvent): Promise<void> {
  const t0 = Date.now();
  try {
    const m = await fetchBuyCounts(e.tokenId);
    await db.update(tracked_tokens).set({
      momentum5m:   m.m5,
      momentum15m:  m.m15,
      momentum30m:  m.m30,
      momentum1h:   m.m1h,
      momentum6h:   m.m6h,
      momentum24h:  m.m24h,
      activeWallets: m.m24h,
      lastBuyAt:    e.boughtAt,
    }).where(eq(tracked_tokens.id, e.tokenId));
    healthMonitor.ok("momentum-engine", Date.now() - t0);
  } catch (err) {
    healthMonitor.error("momentum-engine", err);
    logger.warn({ err, tokenId: e.tokenId }, "Momentum buy-update failed (non-fatal)");
  }
}

// ── Full batch refresh (all tokens) ──────────────────────────────────────────
// Scheduled every 5 minutes by the periodic loop in startMomentumEngine.

export async function refreshAllMomentum(): Promise<void> {
  try {
    const tokens = await db.select({
      id:                  tracked_tokens.id,
      momentum5m:          tracked_tokens.momentum5m,
      momentum15m:         tracked_tokens.momentum15m,
      momentum30m:         tracked_tokens.momentum30m,
      momentum1h:          tracked_tokens.momentum1h,
      momentum6h:          tracked_tokens.momentum6h,
      momentum24h:         tracked_tokens.momentum24h,
      buyPressure:         tracked_tokens.buyPressure,
      holderCount:         tracked_tokens.holderCount,
      holderKolCount:      tracked_tokens.holderKolCount,
      holderSmartCount:    tracked_tokens.holderSmartCount,
      holderMomentumScore: tracked_tokens.holderMomentumScore,
      gainPct:             tracked_tokens.gainPct,
      liquidityUsd:        tracked_tokens.liquidityUsd,
      firstDetectedAt:     tracked_tokens.firstDetectedAt,
    }).from(tracked_tokens);

    if (tokens.length === 0) return;

    const withRaw = tokens.map(t => ({
      t,
      raw: extractRawSignals({ ...t, gainPct: t.gainPct ?? null }),
    }));

    const allRawPrice       = withRaw.map(r => r.raw.rawPrice);
    const allRawVolume      = withRaw.map(r => r.raw.rawVolume);
    const allRawBuyPressure = withRaw.map(r => r.raw.rawBuyPressure);
    const allRawHolder      = withRaw.map(r => r.raw.rawHolder);

    for (const { t, raw } of withRaw) {
      const normed = {
        price:       minMaxNorm(allRawPrice,       raw.rawPrice),
        volume:      minMaxNorm(allRawVolume,       raw.rawVolume),
        buyPressure: minMaxNorm(allRawBuyPressure,  raw.rawBuyPressure),
        holder:      minMaxNorm(allRawHolder,       raw.rawHolder),
      };

      const m = buildMomentum(
        { ...t, gainPct: t.gainPct ?? null, lowLiquidityFlag: raw.lowLiquidityFlag },
        normed,
      );

      await db.update(tracked_tokens).set({
        momentum5m:   t.momentum5m,
        momentum15m:  t.momentum15m,
        momentum30m:  t.momentum30m,
        momentum1h:   t.momentum1h,
        momentum6h:   t.momentum6h,
        momentum24h:  t.momentum24h,
        activeWallets: t.momentum24h,
        compositeMomentum:      m.compositeMomentum,
        priceMomentum:          m.priceMomentum,
        volumeMomentum:         m.volumeMomentum,
        buyPressureMomentum:    m.buyPressureMomentum,
        holderMomentumComputed: m.holderMomentumComputed,
        liquidityMomentum:      m.liquidityMomentum,
        volatilityAdjMomentum:  m.volatilityAdjMomentum,
        earlyMomentum:          m.earlyMomentum,
        sustainedMomentum:      m.sustainedMomentum,
        revivalPotential:       m.revivalPotential,
        lowLiquidityFlag:       m.lowLiquidityFlag,
      }).where(eq(tracked_tokens.id, t.id));
    }

    logger.debug({ count: tokens.length }, "Multi-type momentum refresh complete");
  } catch (err) {
    logger.warn({ err }, "Full momentum refresh failed");
  }
}

/**
 * Start the momentum engine.
 * Periodic batch refresh runs every 5 minutes after the previous run completes.
 * Event-driven per-buy updates fire immediately via the event bus.
 */
export function startMomentumEngine() {
  eventBus.on("token:bought", (e) => { updateMomentumOnBuy(e).catch(() => {}); });
  const loop = () => {
    refreshAllMomentum()
      .catch(err => logger.warn({ err }, "Momentum batch refresh failed"))
      .finally(() => setTimeout(loop, 300_000));
  };
  setTimeout(loop, 300_000);
  logger.info("Momentum engine started (event-driven buy updates + 5 min batch refresh)");
}
