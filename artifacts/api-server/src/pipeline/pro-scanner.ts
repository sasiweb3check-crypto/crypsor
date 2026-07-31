/**
 * Pro Scanner
 *
 * Identifies tokens that qualify for the Pro Caller tier and registers them
 * in `pro_calls` (one record per token, never duplicated).
 *
 * On-time path (Jul 2026):
 *   intel:scored → immediate scan → live GMGN KOL/smart verify → INSERT with
 *   freeze → Pro Score v2 + surface NOW.
 *
 * Qualification tracks
 * ────────────────────
 *  VERY STRONG  (scanner_label = 'very_strong')
 *    Track A: intelligence_score >= 80 + verified KOL/Smart >= 1 + MC >= $5K
 *    Track B: intelligence_score >= 75 + verified KOL >= 2  + MC >= $5K
 *
 *  STRONG       (scanner_label = 'strong')
 *    Track C: intelligence_score >= 80 + verified KOL/Smart = 0 + MC >= $5K
 *             Auto-upgraded once live GMGN shows KOL/Smart.
 *
 * KOL/smart SSOT at qualify: live GMGN (wallet_tags_stat / holder_stat + tagged
 * holder lists). Never trust inflated intel-log kol (tracked-wallet boost) alone.
 * Entry MC / ATH always use called_mc_usd; surfaced_* is first-seen-in-UI only.
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
  verifyTokenKolSmart,
  walletsPayload,
  type GmgnProVerifyResult,
} from "../lib/gmgn-pro-verify";

const log = logger.child({ module: "pro-scanner" });

const SCAN_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 12_000;

const MIN_INTEL = 80;
const MIN_INTEL_STRONG_KOL = 75;
const MIN_KOL_STRONG = 2;
const MIN_MC = 5_000;
const MAX_MC = 500_000;
/** Cap live GMGN verifies per full cycle to stay under rate limits. */
const MAX_VERIFY_PER_CYCLE = 12;

type Candidate = {
  token_id: number;
  address: string;
  chain: string;
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
): "very_strong" | "strong" | null {
  if (intel >= MIN_INTEL && (kol >= 1 || smart >= 1)) return "very_strong";
  if (intel >= MIN_INTEL_STRONG_KOL && kol >= MIN_KOL_STRONG) return "very_strong";
  if (intel >= MIN_INTEL && kol === 0 && smart === 0) return "strong";
  return null;
}

async function loadCandidates(onlyTokenId?: number, limit = 40): Promise<Candidate[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (l.token_id)
      l.token_id,
      t.address,
      t.chain,
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
    WHERE l.intelligence_score >= ${MIN_INTEL_STRONG_KOL}
      AND l.market_cap_usd::numeric >= ${MIN_MC}
      AND l.market_cap_usd::numeric <= ${MAX_MC}
      AND l.status_after IN ('new', 'active', 'watch')
      AND NOT EXISTS (SELECT 1 FROM pro_calls pc WHERE pc.token_id = l.token_id)
      ${onlyTokenId ? sql`AND l.token_id = ${onlyTokenId}` : sql``}
    ORDER BY l.token_id, l.computed_at ASC
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
}): Promise<boolean> {
  const { c, scannerLabel, kol, smart, source, verify } = args;
  const walletsJson = verify?.ok ? JSON.stringify(walletsPayload(verify)) : null;
  try {
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
        ${c.computed_at},
        ${c.market_cap_usd},
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
  let strong = 0;
  let verified = 0;

  // Prefer verifying highest-intel first when we must truncate.
  const ordered = [...candidates].sort(
    (a, b) => (b.intelligence_score ?? 0) - (a.intelligence_score ?? 0),
  );
  const toVerify = ordered.slice(0, MAX_VERIFY_PER_CYCLE);
  const deferred = ordered.slice(MAX_VERIFY_PER_CYCLE);

  for (const c of toVerify) {
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
      log.warn({ err, tokenId: c.token_id }, "GMGN verify failed (non-fatal)");
    }

    const kol = verify?.ok ? verify.kolCount : Math.max(0, Number(c.holder_kol_count ?? 0));
    const smart = verify?.ok ? verify.smartCount : Math.max(0, Number(c.holder_smart_count ?? 0));
    const source = verify?.ok ? "gmgn_live" : "intel_log";
    const track = gateTrack(c.intelligence_score, kol, smart);
    if (!track) continue;

    const inserted = await insertProCall({
      c, scannerLabel: track, kol, smart, source, verify,
    });
    if (inserted) {
      if (track === "very_strong") veryStrong++;
      else strong++;
      log.info(
        {
          tokenId: c.token_id,
          symbolHint: c.address.slice(0, 8),
          track,
          intel: c.intelligence_score,
          kol,
          smart,
          source,
          calledMc: c.market_cap_usd,
        },
        "Pro call registered",
      );
    }
  }

  // Deferred candidates: insert without live verify using raw log counts so we
  // do not drop them; upgradeStrong / next cycle will re-verify.
  for (const c of deferred) {
    const kol = Math.max(0, Number(c.holder_kol_count ?? 0));
    const smart = Math.max(0, Number(c.holder_smart_count ?? 0));
    const track = gateTrack(c.intelligence_score, kol, smart);
    if (!track) continue;
    const inserted = await insertProCall({
      c, scannerLabel: track, kol, smart, source: "intel_log", verify: null,
    });
    if (inserted) {
      if (track === "very_strong") veryStrong++;
      else strong++;
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
      if (verify.kolCount < 1 && verify.smartCount < 1) continue;

      await db.execute(sql`
        UPDATE pro_calls
        SET
          scanner_label      = 'very_strong',
          called_kol_count   = ${verify.kolCount},
          called_smart_count = ${verify.smartCount},
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
      await db.execute(sql`
        UPDATE pro_calls
        SET
          called_kol_count   = ${verify.kolCount},
          called_smart_count = ${verify.smartCount},
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
        pc.surfaced_at,
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
      WHERE (pc.pro_score IS NULL OR pc.score_version IS DISTINCT FROM 'v2'
             OR pc.quality_label IS NULL OR pc.surfaced_at IS NULL)
        ${tokenId ? sql`AND pc.token_id = ${tokenId}` : sql``}
      ORDER BY pc.called_at DESC
      LIMIT ${tokenId ? 1 : 80}
    `);

    let n = 0;
    for (const r of rows.rows as Array<Record<string, unknown>>) {
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

      const result = computeProScore({
        calledIntelScore: Number(r.called_intel_score ?? 60),
        calledKolCount: Number(r.called_kol_count ?? 0),
        calledSmartCount: Number(r.called_smart_count ?? 0),
        calledMcUsd: calledMc || null,
        calledHolderVelocity: r.called_holder_velocity != null ? Number(r.called_holder_velocity) : null,
        calledMcGrowth: r.called_mc_growth != null ? Number(r.called_mc_growth) : null,
        calledVolumeIntensity: r.called_volume_intensity != null ? Number(r.called_volume_intensity) : null,
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
        secRatTraderAmtRate: r.sec_rat_trader_amt_rate != null ? Number(r.sec_rat_trader_amt_rate) : null,
      });

      const qualityLabel = result.qualityLabel;
      const surfacingNow = qualityLabel === "good" || qualityLabel === "very_good";
      const entryTier: EntryTier = result.entryTier;

      // surfaced_mc = MC when first visible in UI (audit), NOT entry price.
      await db.execute(sql`
        UPDATE pro_calls
        SET
          ath_multiple = GREATEST(COALESCE(ath_multiple, 1), ${athMultiple}),
          pro_score = ${result.score},
          survival_score = ${result.survivalScore},
          last_survival_at = NOW(),
          entry_tier = ${entryTier},
          score_version = 'v2',
          quality_label = CASE
            WHEN ${runStatus} = 'DEAD' AND ${athMultiple} < 2 THEN ${qualityLabel}
            WHEN quality_label = 'very_good' THEN 'very_good'
            WHEN quality_label = 'good' AND ${qualityLabel} = 'very_good' THEN 'very_good'
            WHEN quality_label = 'good' AND ${qualityLabel} = 'below' THEN 'good'
            WHEN quality_label = 'good' THEN 'good'
            ELSE ${qualityLabel}
          END,
          surfaced_at = CASE
            WHEN ${surfacingNow} THEN COALESCE(surfaced_at, NOW())
            ELSE surfaced_at
          END,
          surfaced_mc_usd = CASE
            WHEN ${surfacingNow} THEN COALESCE(surfaced_mc_usd, ${String(currentMc || calledMc || 0)})
            ELSE surfaced_mc_usd
          END
        WHERE id = ${Number(r.pro_call_id)}
      `);
      n++;
    }
    return n;
  } catch (err) {
    log.warn({ err }, "scoreAndSurfacePending error (non-fatal)");
    return 0;
  }
}

async function scanOnce(onlyTokenId?: number): Promise<void> {
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
  }
}

export function startProScanner(): void {
  pipelineQueue.register<{ tokenId?: number }>("pro", async (data) => {
    await scanOnce(data.tokenId);
  });

  eventBus.on("intel:scored", (e: IntelScoredEvent) => {
    if (e.intelligenceScore < MIN_INTEL_STRONG_KOL) return;
    const mc = e.marketCapUsd ? parseFloat(e.marketCapUsd) : 0;
    if (mc > 0 && mc < MIN_MC) return;
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
