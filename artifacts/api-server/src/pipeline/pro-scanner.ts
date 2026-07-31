/**
 * Pro Scanner
 *
 * Identifies tokens that qualify for the Pro Caller tier and registers them
 * in `pro_calls` (one record per token, never duplicated).
 *
 * ── Qualification tracks ────────────────────────────────────────────────────
 *
 *  VERY STRONG  (scanner_label = 'very_strong')
 *    Track A: intelligence_score >= 80 + KOL/Smart >= 1 + MC >= $5K
 *    Track B: intelligence_score >= 75 + KOL >= 2  + MC >= $5K
 *             (strong KOL conviction allows a slightly lower intel gate)
 *
 *  STRONG       (scanner_label = 'strong')
 *    Track C: intelligence_score >= 80 + KOL = 0   + MC >= $5K
 *             Token met the intel gate but KOL/Smart data had not arrived yet
 *             due to GMGN timing delay (typically 12–60s after detection).
 *             Automatically upgraded to 'very_strong' once KOL data arrives.
 *
 * ── Why the two-track system ─────────────────────────────────────────────────
 *
 *  The intelligence engine runs every 5 minutes. GMGN holder data (KOL/Smart
 *  classification) arrives 12–60s after token detection. If the intel engine
 *  fires before GMGN responds, the log entry has kol_count = 0, causing the
 *  token to miss the KOL gate — permanently, under the old single-track design.
 *
 *  The two-track system fixes this:
 *    • High-intel tokens are captured immediately as 'strong' even with kol=0
 *    • Every scan cycle, 'strong' rows where KOL has since arrived are promoted
 *    • No strong token is ever permanently blocked by a timing gap
 *
 * ── Scan order ───────────────────────────────────────────────────────────────
 *  0. Backfill KOL/smart counts in intel log (existing rows with kol=0)
 *  1. INSERT very_strong  (Track A + B, highest priority)
 *  2. UPGRADE strong → very_strong  (KOL data arrived since last scan)
 *  3. INSERT strong  (Track C — intel-only, KOL still absent)
 *
 * Runs every 5 minutes with a 20-second startup delay.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const log = logger.child({ module: "pro-scanner" });

const SCAN_INTERVAL_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 20_000;

// ── Thresholds ────────────────────────────────────────────────────────────────

/** Minimum intel score for standard qualification (with any KOL/Smart). */
const MIN_INTEL = 80;

/**
 * Lower intel gate when KOL signal is strong (≥ MIN_KOL_STRONG wallets).
 * Strong KOL conviction is a high-confidence leading indicator that partially
 * compensates for a slightly lower composite intel score.
 */
const MIN_INTEL_STRONG_KOL = 75;

/** KOL count required to use the lower intel gate. */
const MIN_KOL_STRONG = 2;

/** Minimum called MC in USD. */
const MIN_MC = 5_000;

// ── Step 0: backfill KOL/smart counts in intel log ───────────────────────────
// Fixes the timing gap where GMGN data arrives after the first intel log entry.
// Only patches rows where intelligence_score already >= MIN_INTEL so the backfill
// doesn't inflate scores for genuinely weak tokens.

async function backfillKolSmartCounts(): Promise<void> {
  try {
    const result = await db.execute(sql`
      UPDATE token_intel_log l
      SET
        holder_kol_count   = t.holder_kol_count,
        holder_smart_count = t.holder_smart_count,
        kol_smart_score    = LEAST(100.0, GREATEST(0.0, (
          (t.holder_kol_count::float / NULLIF(t.holder_count, 0)) * 250.0 +
          (t.holder_smart_count::float / NULLIF(t.holder_count, 0)) * 200.0
        )::real))
      FROM tracked_tokens t
      WHERE l.token_id = t.id
        AND (l.holder_kol_count IS NULL OR l.holder_kol_count = 0)
        AND (l.holder_smart_count IS NULL OR l.holder_smart_count = 0)
        AND (t.holder_kol_count >= 1 OR t.holder_smart_count >= 1)
        AND l.intelligence_score >= ${MIN_INTEL}
    `);
    const updated = Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
    if (updated > 0) {
      log.info({ updated }, "KOL/smart backfill: intel log entries updated");
    }
  } catch (err) {
    log.warn({ err }, "KOL/smart backfill error (non-fatal)");
  }
}

// ── Step 1: INSERT very_strong ────────────────────────────────────────────────
// Track A: intel >= 80 + KOL/Smart >= 1
// Track B: intel >= 75 + KOL >= 2  (strong conviction lowers gate)

async function insertVeryStrong(): Promise<number> {
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
        scanner_label
      )
      SELECT DISTINCT ON (l.token_id)
        l.token_id,
        l.computed_at                    AS called_at,
        l.market_cap_usd                 AS called_mc_usd,
        l.intelligence_score             AS called_intel_score,
        l.holder_kol_count               AS called_kol_count,
        l.holder_smart_count             AS called_smart_count,
        l.kol_smart_score                AS called_kol_smart_score,
        'very_strong'                    AS scanner_label
      FROM token_intel_log l
      WHERE (
        -- Track A: standard gate — any KOL/Smart presence
        (
          l.intelligence_score        >= ${MIN_INTEL}
          AND (l.holder_kol_count >= 1 OR l.holder_smart_count >= 1)
        )
        OR
        -- Track B: lower intel gate when KOL signal is strong (≥ 2 wallets)
        (
          l.intelligence_score        >= ${MIN_INTEL_STRONG_KOL}
          AND l.holder_kol_count      >= ${MIN_KOL_STRONG}
        )
      )
        AND l.market_cap_usd::numeric   >= ${MIN_MC}
        AND l.status_after IN ('new', 'active', 'watch')
        AND NOT EXISTS (
          SELECT 1 FROM pro_calls pc WHERE pc.token_id = l.token_id
        )
      ORDER BY l.token_id, l.computed_at ASC
      ON CONFLICT (token_id) DO NOTHING
    `);
    return Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
  } catch (err) {
    log.error({ err }, "Pro scanner: very_strong INSERT error");
    return 0;
  }
}

// ── Step 2: UPGRADE strong → very_strong ─────────────────────────────────────
// For existing 'strong' tokens where KOL/Smart data has since arrived.
// Also updates called_kol/smart counts to reflect the real data.

async function upgradeStrongToVeryStrong(): Promise<number> {
  try {
    const result = await db.execute(sql`
      UPDATE pro_calls pc
      SET
        scanner_label      = 'very_strong',
        called_kol_count   = GREATEST(pc.called_kol_count,   t.holder_kol_count),
        called_smart_count = GREATEST(pc.called_smart_count, t.holder_smart_count)
      FROM tracked_tokens t
      WHERE pc.token_id = t.id
        AND pc.scanner_label = 'strong'
        AND (t.holder_kol_count >= 1 OR t.holder_smart_count >= 1)
    `);
    return Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
  } catch (err) {
    log.warn({ err }, "Pro scanner: strong→very_strong upgrade error (non-fatal)");
    return 0;
  }
}

// ── Step 3: INSERT strong ─────────────────────────────────────────────────────
// Track C: intel >= 80, KOL = 0 (GMGN data not yet arrived).
// These tokens met the intel gate but are in a holding pattern waiting for
// KOL/Smart confirmation. They ARE visible in Pro Intel immediately (with the
// 'strong' label) and will be upgraded the next time Step 2 runs.

async function insertStrong(): Promise<number> {
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
        scanner_label
      )
      SELECT DISTINCT ON (l.token_id)
        l.token_id,
        l.computed_at                    AS called_at,
        l.market_cap_usd                 AS called_mc_usd,
        l.intelligence_score             AS called_intel_score,
        COALESCE(l.holder_kol_count, 0)  AS called_kol_count,
        COALESCE(l.holder_smart_count,0) AS called_smart_count,
        l.kol_smart_score                AS called_kol_smart_score,
        'strong'                         AS scanner_label
      FROM token_intel_log l
      WHERE l.intelligence_score        >= ${MIN_INTEL}
        AND (l.holder_kol_count  IS NULL OR l.holder_kol_count  = 0)
        AND (l.holder_smart_count IS NULL OR l.holder_smart_count = 0)
        AND l.market_cap_usd::numeric   >= ${MIN_MC}
        AND l.status_after IN ('new', 'active', 'watch')
        AND NOT EXISTS (
          SELECT 1 FROM pro_calls pc WHERE pc.token_id = l.token_id
        )
      ORDER BY l.token_id, l.computed_at ASC
      ON CONFLICT (token_id) DO NOTHING
    `);
    return Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
  } catch (err) {
    log.error({ err }, "Pro scanner: strong INSERT error");
    return 0;
  }
}

// ── Main scan ────────────────────────────────────────────────────────────────

async function scanOnce(): Promise<void> {
  // Step 0: patch intel log rows where kol=0 but tracked_tokens now has data
  await backfillKolSmartCounts();

  // Step 1: insert fully-qualified tokens as very_strong
  const veryStrongInserted = await insertVeryStrong();

  // Step 2: promote strong tokens whose KOL data has arrived since last scan
  const upgraded = await upgradeStrongToVeryStrong();

  // Step 3: insert high-intel tokens with missing KOL data as strong
  const strongInserted = await insertStrong();

  if (veryStrongInserted > 0 || upgraded > 0 || strongInserted > 0) {
    log.info(
      { veryStrongInserted, upgraded, strongInserted },
      "Pro scanner cycle complete",
    );
  }
}

export function startProScanner(): void {
  setTimeout(async () => {
    await scanOnce();
    setInterval(scanOnce, SCAN_INTERVAL_MS);
  }, STARTUP_DELAY_MS);

  log.info(
    { delayMs: STARTUP_DELAY_MS, intervalMs: SCAN_INTERVAL_MS },
    "Pro scanner scheduled (very_strong: intel≥80+KOL, intel≥75+KOL≥2 | strong: intel≥80 no-KOL → auto-upgrade)",
  );
}
