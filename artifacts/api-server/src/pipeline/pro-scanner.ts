/**
 * Pro Scanner — Runner radar intake
 *
 * intel:scored → live GMGN verify → INSERT freeze → score → surface
 *
 * Gates:
 *   • Live GMGN verify OK
 *   • Tagged presence: smart OR KOL ≥ 1 (soft — momentum confirms later)
 *   • Entry MC $5K–$150K · liq when known · !honeypot
 *   • Banned mints/symbols rejected
 * Surface: very_good / good sticky desk; ENTRY alerts are momentum-based
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus, type IntelScoredEvent } from "./event-bus";
import { pipelineQueue } from "../lib/job-queue";
import {
  computeProScore,
  deriveRunStatus,
  type EntryTier,
} from "../lib/pro-scoring";
import {
  applyVerifyToTrackedToken,
  convictionFromPayload,
  qualitySignalsFromPayload,
  verifyTokenKolSmart,
  walletsPayload,
  type GmgnProVerifyResult,
} from "../lib/gmgn-pro-verify";
import { opsLog } from "../lib/ops-log";
import { healthMonitor } from "./health-monitor";
import { invalidateProCaches } from "../lib/pro-cache";
import {
  MAX_PRO_ENTRY_MC_USD,
  MIN_PRO_LIQ_USD,
  isProBannedToken,
} from "../lib/solana-memecoin-gate";

const log = logger.child({ module: "pro-scanner" });

const SCAN_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 12_000;

/** Intake intel floor — surface still uses SURFACE_* bars after scoring. */
const MIN_INTEL = 68;
const MIN_MC = 5_000;
const MAX_MC = MAX_PRO_ENTRY_MC_USD; // hard cap — late / major entries out
/** Cap live GMGN verifies per full cycle to stay under rate limits. */
const MAX_VERIFY_PER_CYCLE = 18;
/** Surface / alert bar — precision over volume. */
const SURFACE_VERY_GOOD = 75;
const SURFACE_GOOD_STRICT = 68;

function emitCallsChanged(
  reason: "insert" | "surface" | "score",
  opts?: { tokenId?: number; symbol?: string | null; qualityLabel?: string | null },
) {
  eventBus.emit("calls:changed", {
    reason,
    tokenId: opts?.tokenId,
    symbol: opts?.symbol ?? null,
    qualityLabel: opts?.qualityLabel ?? null,
    at: new Date().toISOString(),
  });
}

type Candidate = {
  token_id: number;
  address: string;
  chain: string;
  symbol: string | null;
  computed_at: string | Date;
  market_cap_usd: string | null;
  intelligence_score: number;
  holder_kol_count: number | null;
  holder_smart_count: number | null;
  kol_smart_score: number | null;
  holder_velocity_score: number | null;
  mc_growth_score: number | null;
  volume_intensity_score: number | null;
  status_after: string | null;
};

function gateTrack(
  intel: number,
  kol: number,
  smart: number,
  smartHoldRate: number | null,
): "very_strong" | null {
  // Soft tagged presence: smart OR KOL — bots dump; Runner confirms later.
  if (smart < 1 && kol < 1) return null;
  if (intel >= MIN_INTEL) return "very_strong";
  if (intel >= 60 && (smart >= 1 || kol >= 1)) return "very_strong";
  void smartHoldRate;
  return null;
}

/**
 * Radar counts for intake: prefer currently-holding, soft-fall back to tag totals.
 * Sold-out tags alone still need MIN_INTEL; Runner/ENTRY remains momentum-gated.
 */
function radarCounts(verify: GmgnProVerifyResult | null): { kol: number; smart: number } {
  if (!verify?.ok) return { kol: 0, smart: 0 };
  const holdKol = verify.holdingKol ?? 0;
  const holdSmart = verify.holdingSmart ?? 0;
  if (holdKol >= 1 || holdSmart >= 1) {
    return { kol: holdKol, smart: holdSmart };
  }
  return {
    kol: Math.max(0, verify.kolCount ?? 0),
    smart: Math.max(0, verify.smartCount ?? 0),
  };
}

/** @deprecated alias — holding-only path kept for upgrade helpers */
function holdingCounts(verify: GmgnProVerifyResult | null): { kol: number; smart: number } {
  if (!verify?.ok) return { kol: 0, smart: 0 };
  return { kol: verify.holdingKol, smart: verify.holdingSmart };
}

/**
 * Surface gate for the Pro desk / alerts.
 * Liquidity is enforced at INSERT (call-time). Do NOT re-check live liq here —
 * that was demoting 75–85 scores to `below` when pool liq dipped after entry
 * (main reason the desk looked empty for ~2 days).
 */
function shouldSurface(opts: {
  qualityLabel: string;
  score: number;
  smart: number;
  kol: number;
  hv: number | null;
  honeypot: boolean | null;
  calledMc: number;
}): boolean {
  if (opts.honeypot === true) return false;
  if (opts.calledMc < MIN_MC || opts.calledMc > MAX_MC) return false;
  // Soft: smart OR KOL present
  if (opts.smart < 1 && opts.kol < 1) return false;
  if (opts.qualityLabel === "very_good" || opts.score >= SURFACE_VERY_GOOD) return true;
  if (opts.score >= SURFACE_GOOD_STRICT) {
    if (opts.hv == null || opts.hv >= 70) return true;
  }
  return false;
}

async function loadCandidates(onlyTokenId?: number, limit = 40): Promise<Candidate[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (l.token_id)
      l.token_id,
      t.address,
      t.chain,
      t.symbol,
      l.computed_at,
      l.market_cap_usd,
      l.intelligence_score,
      l.holder_kol_count,
      l.holder_smart_count,
      l.kol_smart_score,
      l.holder_velocity_score,
      l.mc_growth_score,
      l.volume_intensity_score,
      l.status_after
    FROM token_intel_log l
    JOIN tracked_tokens t ON t.id = l.token_id
    WHERE l.intelligence_score >= ${MIN_INTEL}
      AND l.market_cap_usd::numeric >= ${MIN_MC}
      AND l.market_cap_usd::numeric <= ${MAX_MC}
      AND l.status_after IN ('new', 'active', 'watch')
      AND COALESCE(t.status, '') <> 'ignored'
      AND COALESCE(UPPER(t.symbol), '') NOT IN (
        'USD1','USDC','USDT','USDS','DAI','UXD','CBBTC','WBTC','BTC','TBTC',
        'WETH','ETH','SOL','WSOL','PYUSD','MSOL','STSOL','JITOSOL','BSOL'
      )
      AND NOT EXISTS (SELECT 1 FROM pro_calls pc WHERE pc.token_id = l.token_id)
      ${onlyTokenId ? sql`AND l.token_id = ${onlyTokenId}` : sql``}
    ORDER BY l.token_id, l.computed_at DESC
    LIMIT ${onlyTokenId ? 1 : limit}
  `);
  return result.rows as Candidate[];
}

async function insertProCall(args: {
  c: Candidate;
  scannerLabel: "very_strong" | "strong";
  kol: number;
  smart: number;
  source: string;
  verify: GmgnProVerifyResult | null;
  /** Live MC at verify/insert — never the earliest intel_log row. */
  calledMcUsd: number | null;
}): Promise<boolean> {
  const { c, scannerLabel, kol, smart, source, verify, calledMcUsd } = args;
  const walletsJson = verify?.ok ? JSON.stringify(walletsPayload(verify)) : null;
  const mcStr = calledMcUsd != null && calledMcUsd > 0
    ? String(calledMcUsd)
    : c.market_cap_usd;
  try {
    // Freeze called_at at insert time (NOW), not earliest intel_log.computed_at
    const result = await db.execute(sql`
      INSERT INTO pro_calls (
        token_id,
        called_at,
        called_mc_usd,
        called_intel_score,
        called_kol_count,
        called_smart_count,
        called_kol_smart_score,
        called_holder_velocity,
        called_mc_growth,
        called_volume_intensity,
        scanner_label,
        score_version,
        kol_smart_source,
        verified_at,
        verified_wallets
      ) VALUES (
        ${c.token_id},
        NOW(),
        ${mcStr},
        ${c.intelligence_score},
        ${kol},
        ${smart},
        ${c.kol_smart_score},
        ${c.holder_velocity_score},
        ${c.mc_growth_score},
        ${c.volume_intensity_score},
        ${scannerLabel},
        'v2',
        ${source},
        ${verify?.ok ? verify.fetchedAt : null},
        ${walletsJson}
      )
      ON CONFLICT (token_id) DO NOTHING
    `);
    return Number((result as unknown as { rowCount?: number }).rowCount ?? 0) > 0;
  } catch (err) {
    log.error({ err, tokenId: c.token_id }, "Pro scanner INSERT error");
    return false;
  }
}

async function qualifyCandidates(candidates: Candidate[]): Promise<{
  veryStrong: number;
  strong: number;
  verified: number;
}> {
  let veryStrong = 0;
  const strong = 0;
  let verified = 0;

  const ordered = [...candidates].sort(
    (a, b) => (b.intelligence_score ?? 0) - (a.intelligence_score ?? 0),
  );
  // Never insert without live verify — deferred intel_log path removed (dump source)
  const toVerify = ordered.slice(0, MAX_VERIFY_PER_CYCLE);
  if (ordered.length > MAX_VERIFY_PER_CYCLE) {
    opsLog("pro_qualify", "info", `Deferred ${ordered.length - MAX_VERIFY_PER_CYCLE} (verify cap)`, {
      deferred: ordered.length - MAX_VERIFY_PER_CYCLE,
    });
  }

  for (const c of toVerify) {
    const ban = isProBannedToken({
      address: c.address,
      symbol: c.symbol,
      calledMcUsd: parseFloat(c.market_cap_usd ?? "0") || null,
    });
    if (ban.banned) {
      opsLog("pro_qualify", "info", `Banned · ${ban.reason}`, {
        tokenId: c.token_id,
        symbol: c.symbol,
      });
      await db.execute(sql`
        UPDATE tracked_tokens
        SET status = 'ignored', last_status_change_at = NOW()
        WHERE id = ${c.token_id} AND COALESCE(status, '') <> 'ignored'
      `);
      continue;
    }

    const mc = parseFloat(c.market_cap_usd ?? "0") || 0;
    if (mc < MIN_MC || mc > MAX_MC) continue;

    let verify: GmgnProVerifyResult | null = null;
    try {
      verify = await verifyTokenKolSmart(c.chain || "sol", c.address);
      if (verify.ok) {
        await applyVerifyToTrackedToken(c.token_id, verify);
        verified++;
      }
    } catch (err) {
      log.warn({ err, tokenId: c.token_id }, "GMGN verify failed — skip qualify");
      continue;
    }

    // Live verify required — no intel_log / tracked-wallet fallback
    if (!verify?.ok) {
      opsLog("pro_qualify", "info", "Skip — GMGN verify failed", { tokenId: c.token_id });
      continue;
    }

    if (verify.liquidityUsd != null && verify.liquidityUsd > 0 && verify.liquidityUsd < MIN_PRO_LIQ_USD) {
      opsLog("pro_qualify", "info", `Skip — liq $${Math.round(verify.liquidityUsd)} < ${MIN_PRO_LIQ_USD}`, {
        tokenId: c.token_id,
      });
      continue;
    }

    let held = radarCounts(verify);
    // Soft sensor: our tracked wallets bought it — enough for radar intake when GMGN tags lag.
    if (held.kol < 1 && held.smart < 1 && c.intelligence_score >= MIN_INTEL) {
      try {
        const buyN = await db.execute(sql`
          SELECT COUNT(DISTINCT wallet_id)::int AS n
          FROM token_buys WHERE token_id = ${c.token_id}
        `);
        const n = Number((buyN.rows[0] as { n?: number } | undefined)?.n ?? 0);
        if (n >= 1) held = { kol: 0, smart: Math.max(1, n) };
      } catch { /* keep empty */ }
    }
    const kol = held.kol;
    const smart = held.smart;
    const smartHoldRate = verify.smartConviction?.holdRate ?? null;
    const track = gateTrack(c.intelligence_score, kol, smart, smartHoldRate);
    if (!track) {
      opsLog("pro_qualify", "info", `Skip — conviction gate (kol=${kol} smart=${smart} hold=${smartHoldRate ?? "n/a"})`, {
        tokenId: c.token_id,
        intel: c.intelligence_score,
        smartHoldRate,
        holdingKol: verify.holdingKol,
        holdingSmart: verify.holdingSmart,
        tagKol: verify.kolCount,
        tagSmart: verify.smartCount,
      });
      continue;
    }

    // Prefer live tracked MC at verify time over (possibly stale) intel_log MC
    let liveMc = mc;
    try {
      const live = await db.execute(sql`
        SELECT market_cap_usd FROM tracked_tokens WHERE id = ${c.token_id} LIMIT 1
      `);
      const raw = (live.rows[0] as { market_cap_usd?: string | null } | undefined)?.market_cap_usd;
      const parsed = raw != null ? parseFloat(String(raw)) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) liveMc = parsed;
    } catch { /* keep intel mc */ }
    if (liveMc < MIN_MC || liveMc > MAX_MC) {
      opsLog("pro_qualify", "info", `Skip — live MC $${Math.round(liveMc)} outside band`, {
        tokenId: c.token_id,
      });
      continue;
    }

    const inserted = await insertProCall({
      c, scannerLabel: track, kol, smart, source: "gmgn_live", verify, calledMcUsd: liveMc,
    });
    if (inserted) {
      veryStrong++;
      log.info(
        {
          tokenId: c.token_id,
          symbolHint: c.address.slice(0, 8),
          track,
          intel: c.intelligence_score,
          kol,
          smart,
          source: "gmgn_live",
          calledMc: liveMc,
          liq: verify.liquidityUsd,
        },
        "Pro call registered (strict)",
      );
      opsLog("pro_qualify", "info", `Pro call · smart${smart}·kol${kol} · intel ${c.intelligence_score}`, {
        inserted: true,
        tokenId: c.token_id,
        kol,
        smart,
        source: "gmgn_live",
        mc: liveMc,
      });
      emitCallsChanged("insert", {
        tokenId: c.token_id,
        symbol: c.symbol,
      });
    }
  }

  return { veryStrong, strong, verified };
}

async function upgradeStrongToVeryStrong(): Promise<number> {
  try {
    const pending = await db.execute(sql`
      SELECT pc.id AS pro_call_id, pc.token_id, t.address, t.chain,
             pc.called_kol_count, pc.called_smart_count
      FROM pro_calls pc
      JOIN tracked_tokens t ON t.id = pc.token_id
      WHERE pc.scanner_label = 'strong'
      ORDER BY pc.called_at DESC
      LIMIT ${MAX_VERIFY_PER_CYCLE}
    `);

    let upgraded = 0;
    for (const row of pending.rows as Array<{
      pro_call_id: number; token_id: number; address: string; chain: string;
      called_kol_count: number | null; called_smart_count: number | null;
    }>) {
      const verify = await verifyTokenKolSmart(row.chain || "sol", row.address);
      if (!verify.ok) continue;
      await applyVerifyToTrackedToken(row.token_id, verify);
      const held = holdingCounts(verify);
      if (held.smart < 1) continue;

      await db.execute(sql`
        UPDATE pro_calls
        SET
          scanner_label      = 'very_strong',
          called_kol_count   = ${held.kol},
          called_smart_count = ${held.smart},
          kol_smart_source   = 'gmgn_live',
          verified_at        = ${verify.fetchedAt},
          verified_wallets   = ${JSON.stringify(walletsPayload(verify))}
        WHERE id = ${row.pro_call_id}
          AND scanner_label = 'strong'
      `);
      upgraded++;
    }
    return upgraded;
  } catch (err) {
    log.warn({ err }, "Pro scanner: strong→very_strong upgrade error (non-fatal)");
    return 0;
  }
}

/** Backfill live GMGN verify onto recent pro_calls missing kol_smart_source. */
async function reverifyUnsourcedCalls(): Promise<number> {
  try {
    const pending = await db.execute(sql`
      SELECT pc.id AS pro_call_id, pc.token_id, t.address, t.chain
      FROM pro_calls pc
      JOIN tracked_tokens t ON t.id = pc.token_id
      WHERE pc.kol_smart_source IS NULL
        AND pc.called_at >= NOW() - INTERVAL '14 days'
      ORDER BY pc.called_at DESC
      LIMIT ${Math.min(6, MAX_VERIFY_PER_CYCLE)}
    `);

    let n = 0;
    for (const row of pending.rows as Array<{
      pro_call_id: number; token_id: number; address: string; chain: string;
    }>) {
      const verify = await verifyTokenKolSmart(row.chain || "sol", row.address);
      if (!verify.ok) continue;
      await applyVerifyToTrackedToken(row.token_id, verify);
      const held = holdingCounts(verify);
      // Freeze call-time counts once set — only fill NULLs; refresh wallet board JSON
      await db.execute(sql`
        UPDATE pro_calls
        SET
          called_kol_count   = COALESCE(called_kol_count, ${held.kol}),
          called_smart_count = COALESCE(called_smart_count, ${held.smart}),
          kol_smart_source   = 'gmgn_live',
          verified_at        = ${verify.fetchedAt},
          verified_wallets   = ${JSON.stringify(walletsPayload(verify))}
        WHERE id = ${row.pro_call_id}
      `);
      n++;
    }
    return n;
  } catch (err) {
    log.warn({ err }, "reverifyUnsourcedCalls error (non-fatal)");
    return 0;
  }
}

// ── Immediate Pro Score v2 + surface for newly inserted / unscored calls ─────

async function scoreAndSurfacePending(tokenId?: number): Promise<number> {
  try {
    const rows = await db.execute(sql`
      SELECT
        pc.id AS pro_call_id,
        pc.token_id,
        pc.called_at,
        pc.called_mc_usd,
        pc.called_intel_score,
        pc.called_kol_count,
        pc.called_smart_count,
        pc.called_holder_velocity,
        pc.called_mc_growth,
        pc.called_volume_intensity,
        pc.ath_multiple,
        pc.quality_label,
        pc.verified_wallets,
        pc.surfaced_at,
        pc.surfaced_mc_usd,
        t.address,
        t.symbol,
        t.market_cap_usd AS current_mc,
        t.ath_market_cap_usd AS ath_mc_usd,
        t.liquidity_usd,
        t.holder_velocity_score,
        t.sec_is_honeypot,
        t.sec_mint_renounced,
        t.sec_freeze_renounced,
        t.sec_top10_holder_rate,
        t.sec_lp_locked,
        t.sec_rat_trader_amt_rate
      FROM pro_calls pc
      JOIN tracked_tokens t ON t.id = pc.token_id
      WHERE (
          pc.pro_score IS NULL
          OR pc.quality_label IS NULL
          OR pc.surfaced_at IS NULL
          OR (pc.quality_label = 'below' AND pc.pro_score >= ${SURFACE_GOOD_STRICT}
              AND (COALESCE(pc.called_smart_count, 0) >= 1 OR COALESCE(pc.called_kol_count, 0) >= 1)
              AND pc.called_at >= NOW() - INTERVAL '3 days')
        )
        ${tokenId ? sql`AND pc.token_id = ${tokenId}` : sql``}
      ORDER BY pc.called_at DESC
      LIMIT ${tokenId ? 1 : 80}
    `);

    const list = (rows as { rows?: Array<Record<string, unknown>> }).rows
      ?? (Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []);
    let n = 0;
    let errors = 0;

    for (const r of list) {
      try {
        const calledMc = parseFloat(String(r.called_mc_usd ?? "0")) || 0;
        const currentMc = parseFloat(String(r.current_mc ?? "0")) || 0;
        const athMc = parseFloat(String(r.ath_mc_usd ?? "0")) || currentMc;
        const prevAth = Number(r.ath_multiple ?? 1) || 1;
        const athFromPipeline = calledMc > 0 ? athMc / calledMc : 1;
        const athMultiple = Math.max(prevAth, calledMc > 0 ? currentMc / calledMc : 1, athFromPipeline);
        const gainPct = calledMc > 0 ? ((currentMc - calledMc) / calledMc) * 100 : 0;
        const ageHours = r.called_at
          ? (Date.now() - new Date(String(r.called_at)).getTime()) / 3_600_000
          : 0;
        const runStatus = deriveRunStatus(currentMc || null, calledMc || null, athMultiple);

        let conviction: ReturnType<typeof convictionFromPayload> = null;
        let quality: ReturnType<typeof qualitySignalsFromPayload> | null = null;
        if (r.verified_wallets) {
          try {
            const raw = typeof r.verified_wallets === "string"
              ? JSON.parse(String(r.verified_wallets))
              : r.verified_wallets;
            conviction = convictionFromPayload(raw);
            quality = qualitySignalsFromPayload(raw);
          } catch { /* ignore */ }
        }

        const smart = Number(r.called_smart_count ?? 0);
        const prevScore = r.pro_score != null ? Number(r.pro_score) : null;
        // First-time score: if re-verify already shows 0% hold but call had smart≥1,
        // don't apply the "sold out" demotion — that dumps elite calls before they surface.
        const rawShr = conviction?.smart.holdRate ?? null;
        const smartHoldRate = (prevScore == null && smart >= 1 && rawShr === 0)
          ? null
          : rawShr;

        const result = computeProScore({
          calledIntelScore: Number(r.called_intel_score ?? 60),
          calledKolCount: Number(r.called_kol_count ?? 0),
          calledSmartCount: smart,
          calledMcUsd: calledMc || null,
          calledHolderVelocity: r.called_holder_velocity != null ? Number(r.called_holder_velocity) : null,
          calledMcGrowth: r.called_mc_growth != null ? Number(r.called_mc_growth) : null,
          calledVolumeIntensity: r.called_volume_intensity != null ? Number(r.called_volume_intensity) : null,
          smartHoldRate,
          kolHoldRate: conviction?.kol.holdRate ?? null,
          smartPaperHands: conviction?.smart.paperHands ?? null,
          diamondHands: (conviction?.smart.diamondHands ?? 0) + (conviction?.kol.diamondHands ?? 0),
          smartKolSupplyPct:
            (conviction?.smart.supplyPctHeld ?? 0) + (conviction?.kol.supplyPctHeld ?? 0),
          currentMcUsd: currentMc || null,
          athMultiple,
          gainSinceCall: gainPct,
          runStatus,
          liquidityUsd: parseFloat(String(r.liquidity_usd ?? "0")) || null,
          ageHoursSinceCall: ageHours,
          holderVelocityScore: r.holder_velocity_score != null ? Number(r.holder_velocity_score) : null,
          secIsHoneypot: r.sec_is_honeypot as boolean | null,
          secMintRenounced: r.sec_mint_renounced as boolean | null,
          secFreezeRenounced: r.sec_freeze_renounced as boolean | null,
          secTop10HolderRate: r.sec_top10_holder_rate != null ? Number(r.sec_top10_holder_rate) : null,
          secLpLocked: r.sec_lp_locked as boolean | null,
          secRatTraderAmtRate: r.sec_rat_trader_amt_rate != null
            ? Number(r.sec_rat_trader_amt_rate)
            : (quality?.ratPct ?? null),
          bundlerPct: quality?.bundlerPct ?? null,
          sniperHoldRate: quality?.sniperHoldRate ?? null,
          freshWalletRate: quality?.freshWalletRate ?? null,
          botDegenRate: quality?.botDegenRate ?? null,
          entrapmentPct: quality?.entrapmentPct ?? null,
        });

        const ban = isProBannedToken({
          address: r.address != null ? String(r.address) : null,
          symbol: r.symbol != null ? String(r.symbol) : null,
          calledMcUsd: calledMc || null,
          currentMcUsd: currentMc || null,
        });
        const hv = r.called_holder_velocity != null
          ? Number(r.called_holder_velocity)
          : (r.holder_velocity_score != null ? Number(r.holder_velocity_score) : null);

        // Rescue stuck elite rows that were demoted by the old live-liq gate
        const effectiveScore = Math.max(result.score, prevScore ?? 0);

        const alreadySurfaced = r.surfaced_at != null;
        const kol = Number(r.called_kol_count ?? 0);
        const taggedOk = smart >= 1 || kol >= 1;
        let qualityLabel: "very_good" | "good" | "below" = ban.banned
          ? "below"
          : result.qualityLabel;
        // Sticky: once on the desk, never demote for DEAD/live score decay.
        if (!ban.banned && alreadySurfaced) {
          const prevQ = r.quality_label != null ? String(r.quality_label) : "good";
          if (prevQ === "very_good" || effectiveScore >= SURFACE_VERY_GOOD) {
            qualityLabel = "very_good";
          } else {
            qualityLabel = "good";
          }
        } else if (!ban.banned && taggedOk && effectiveScore >= SURFACE_VERY_GOOD) {
          qualityLabel = "very_good";
        } else if (!ban.banned && taggedOk && effectiveScore >= SURFACE_GOOD_STRICT) {
          if (qualityLabel === "below") qualityLabel = "good";
        }

        const finalSurface = !ban.banned && (
          alreadySurfaced
          || (qualityLabel !== "below" && shouldSurface({
            qualityLabel,
            score: effectiveScore,
            smart,
            kol,
            hv,
            honeypot: r.sec_is_honeypot as boolean | null,
            calledMc,
          }))
        );
        if (!finalSurface && !alreadySurfaced && qualityLabel !== "below") {
          qualityLabel = "below";
        }
        if (finalSurface && qualityLabel === "below" && !ban.banned) {
          qualityLabel = "good";
        }

        const entryTier: EntryTier = result.entryTier;
        const surfacedMc = String(currentMc || calledMc || 0);
        const callId = Number(r.pro_call_id);
        const scoreToStore = effectiveScore > result.score && prevScore != null
          ? effectiveScore
          : result.score;

        if (finalSurface) {
          const wasNew = !alreadySurfaced;
          await db.execute(sql`
            UPDATE pro_calls
            SET
              ath_multiple = GREATEST(COALESCE(ath_multiple, 1), ${athMultiple}),
              pro_score = ${scoreToStore},
              survival_score = ${result.survivalScore},
              last_survival_at = NOW(),
              entry_tier = ${entryTier},
              score_version = 'v2',
              quality_label = ${qualityLabel},
              surfaced_at = COALESCE(surfaced_at, NOW()),
              surfaced_mc_usd = COALESCE(surfaced_mc_usd, ${surfacedMc})
            WHERE id = ${callId}
          `);
          // Only ping clients on first surface — rescoring would flood SSE
          if (wasNew) {
            emitCallsChanged("surface", {
              tokenId: Number(r.token_id),
              symbol: r.symbol != null ? String(r.symbol) : null,
              qualityLabel,
            });
          }
        } else {
          await db.execute(sql`
            UPDATE pro_calls
            SET
              ath_multiple = GREATEST(COALESCE(ath_multiple, 1), ${athMultiple}),
              pro_score = ${scoreToStore},
              survival_score = ${result.survivalScore},
              last_survival_at = NOW(),
              entry_tier = ${entryTier},
              score_version = 'v2',
              quality_label = ${ban.banned ? "below" : qualityLabel}
            WHERE id = ${callId}
          `);
        }
        n++;
      } catch (rowErr) {
        errors++;
        log.warn(
          { err: rowErr, proCallId: r.pro_call_id, symbol: r.symbol },
          "scoreAndSurfacePending row failed",
        );
      }
    }
    if (errors > 0) {
      opsLog("pro_qualify", "warn", `Scorer row errors ${errors}/${list.length}`, { errors, n });
    }
    return n;
  } catch (err) {
    log.warn({ err }, "scoreAndSurfacePending error (non-fatal)");
    opsLog("pro_qualify", "error", `Scorer failed: ${String(err).slice(0, 180)}`);
    return 0;
  }
}

async function scanOnce(onlyTokenId?: number): Promise<void> {
  const t0 = Date.now();
  try {
    const candidates = await loadCandidates(onlyTokenId);
    const { veryStrong, strong, verified } = await qualifyCandidates(candidates);
    const upgraded = await upgradeStrongToVeryStrong();
    const reverified = onlyTokenId ? 0 : await reverifyUnsourcedCalls();
    const scored = await scoreAndSurfacePending(onlyTokenId);

    if (veryStrong > 0 || strong > 0 || upgraded > 0 || scored > 0 || verified > 0 || reverified > 0) {
      log.info(
        {
          veryStrongInserted: veryStrong,
          strongInserted: strong,
          upgraded,
          scored,
          verified,
          reverified,
          onlyTokenId: onlyTokenId ?? null,
        },
        "Pro scanner cycle complete",
      );
      opsLog("pro_qualify", "info", `Qualify cycle · +${veryStrong + strong} calls · scored ${scored}`, {
        veryStrong,
        strong,
        verified,
        upgraded,
        scored,
        candidates: candidates.length,
      });
      // Bust Pro Intel feed/stats so Age tabs show the new call immediately
      if (veryStrong + strong + scored > 0) {
        await invalidateProCaches();
      }
    } else if (candidates.length > 0) {
      opsLog("pro_qualify", "info", `Qualify checked ${candidates.length} — none inserted`, {
        candidates: candidates.length,
        verified,
      });
    }
    healthMonitor.ok("pro-scanner", Date.now() - t0);
  } catch (err) {
    log.error({ err }, "Pro scanner cycle failed");
    opsLog("pro_qualify", "error", `Pro scanner failed: ${String(err).slice(0, 180)}`);
    healthMonitor.error("pro-scanner", err);
  }
}

export function startProScanner(): void {
  pipelineQueue.register<{ tokenId?: number }>("pro", async (data) => {
    await scanOnce(data.tokenId);
  });

  eventBus.on("intel:scored", (e: IntelScoredEvent) => {
    if (e.intelligenceScore < MIN_INTEL) return;
    const mc = e.marketCapUsd ? parseFloat(e.marketCapUsd) : 0;
    if (mc > 0 && (mc < MIN_MC || mc > MAX_MC)) return;
    pipelineQueue.enqueue(
      "pro",
      { tokenId: e.tokenId },
      { priority: 12, dedupKey: `pro:${e.tokenId}`, delayMs: 200 },
    );
  });

  setTimeout(async () => {
    await scanOnce();
    setInterval(() => {
      pipelineQueue.enqueue("pro", {}, { priority: 5, dedupKey: "pro:full-cycle" });
    }, SCAN_INTERVAL_MS);
  }, STARTUP_DELAY_MS);

  log.info(
    { delayMs: STARTUP_DELAY_MS, intervalMs: SCAN_INTERVAL_MS },
    "Pro scanner scheduled (GMGN live verify + event-driven + 60s backup)",
  );
}
