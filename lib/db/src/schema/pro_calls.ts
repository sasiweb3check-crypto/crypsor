/**
 * pro_calls
 *
 * One record per token — inserted the first time a token qualifies for the
 * Pro Caller tier (intelligence_score >= 80, kol/smart >= 1, called MC >= $5K).
 *
 * `ath_multiple` is a running max updated by the pro-snapshots worker every
 * cycle.  Storing it here keeps the stats query O(1) instead of requiring a
 * full scan of pro_snapshots.
 */

import {
  pgTable,
  serial,
  integer,
  real,
  text,
  timestamp,
  boolean,
  index,
} from "drizzle-orm/pg-core";

export const pro_calls = pgTable(
  "pro_calls",
  {
    id:               serial("id").primaryKey(),

    // ── Token reference ──────────────────────────────────────────────────────
    tokenId:          integer("token_id").notNull().unique(),  // FK -> tracked_tokens.id

    // ── Snapshot of conditions at first qualification ────────────────────────
    calledAt:         timestamp("called_at").defaultNow().notNull(),
    calledMcUsd:      text("called_mc_usd"),          // market cap at call time
    calledIntelScore: real("called_intel_score"),
    calledKolCount:   integer("called_kol_count").default(0),
    calledSmartCount: integer("called_smart_count").default(0),
    calledKolSmartScore: real("called_kol_smart_score"),

    // ── Live GMGN verify freeze (set at qualify / upgrade) ───────────────────
    // Counts above are overwritten from GMGN live verify when available.
    // kol_smart_source: 'gmgn_live' | 'intel_log' | 'tracked_tokens'
    kolSmartSource:   text("kol_smart_source"),
    verifiedAt:       timestamp("verified_at", { withTimezone: true }),
    // { source, fetchedAt, holderStat, tagsStat, kol[], smart[] }
    verifiedWallets:  text("verified_wallets"), // JSON string for pg text/jsonb compat

    // ── Telegram alert bookkeeping (Pro alerts scratch rebuild) ──────────────
    // call_alert_sent_at set once when first Pro call alert is delivered.
    callAlertSentAt:  timestamp("call_alert_sent_at", { withTimezone: true }),
    // Comma-separated tiers already alerted, e.g. "2,5,10"
    milestoneAlertsSent: text("milestone_alerts_sent").default(""),

    // ── Runner Entry product (momentum-based) ────────────────────────────────
    runnerScore:      real("runner_score"),
    // radar | heating | entry | fading | dead
    runnerPhase:      text("runner_phase"),
    // First ENTRY-phase Telegram ping (MC-agnostic runner product)
    runnerAlertSentAt: timestamp("runner_alert_sent_at", { withTimezone: true }),
    // Last snap MC — for momentum delta without joining snapshots
    lastSnapMcUsd:    text("last_snap_mc_usd"),
    // Momentum snaps collected toward ENTRY observation gate (≥5)
    observationSnapCount: integer("observation_snap_count").default(0),

    // ── Running ATH tracker (updated by snapshot worker) ────────────────────
    athMultiple:      real("ath_multiple").default(1), // max(current_mc / called_mc) ever seen
    lastSnapshotAt:   timestamp("last_snapshot_at"),

    // ── Pro Score (0-100) and quality label (updated every snapshot cycle) ──
    // Composite of: intel strength, MC/liquidity, ATH multiplier, gain momentum,
    // run-status quality, risk/security.  very_good ≥ 75 | good 55-74 | below < 55
    proScore:         real("pro_score"),
    qualityLabel:     text("quality_label"), // 'very_good' | 'good' | 'below'

    // ── Scanner label — qualification track (set by pro-scanner) ────────────
    // 'very_strong' — met full criteria: intel ≥ 80 + KOL/Smart ≥ 1,
    //                 OR intel ≥ 75 + KOL ≥ 2 (strong conviction lowers gate)
    // 'strong'      — met intel-only criteria (≥ 80) but KOL data was absent at
    //                 scan time due to GMGN delay. Upgrades to very_strong
    //                 automatically once KOL/Smart data arrives.
    scannerLabel:     text("scanner_label").default("very_strong"),

    // ── Surfaced tracking — when the token first became visible in Pro Intel ──
    // Set once the first time quality_label transitions out of 'below'/null to
    // 'good' or 'very_good'.  This is "first seen in UI", NOT the entry price.
    // Entry / ATH / gain always use called_mc_usd (MC at first qualify).
    surfacedAt:       timestamp("surfaced_at", { withTimezone: true }),
    surfacedMcUsd:    text("surfaced_mc_usd"),

    // ── Pro Score v2 call-time sub-signals + survival ─────────────────────────
    // Captured from the qualifying intel-log row so scoring does not wait for
    // a later snapshot cycle (the old call→surface median lag was ~25h).
    calledHolderVelocity:   real("called_holder_velocity"),
    calledMcGrowth:         real("called_mc_growth"),
    calledVolumeIntensity:  real("called_volume_intensity"),
    survivalScore:          real("survival_score"),
    lastSurvivalAt:         timestamp("last_survival_at"),
    // micro ($5-15k) | low ($15-30k) | mid ($30-75k) | high | outlier
    entryTier:              text("entry_tier"),
    // 'v1' legacy | 'v2' outcome-tuned (Jul 2026)
    scoreVersion:           text("score_version").default("v2"),

    // ── Milestone tracker — set once, never cleared ───────────────────────────
    // Flags and timestamps for when ath_multiple first crossed each threshold.
    // Set by the pro-snapshots worker; immutable once true.
    hit2x:    boolean("hit_2x").default(false),
    hit2xAt:  timestamp("hit_2x_at"),
    hit3x:    boolean("hit_3x").default(false),
    hit3xAt:  timestamp("hit_3x_at"),
    hit5x:    boolean("hit_5x").default(false),
    hit5xAt:  timestamp("hit_5x_at"),
    hit10x:   boolean("hit_10x").default(false),
    hit10xAt: timestamp("hit_10x_at"),
    hit100x:  boolean("hit_100x").default(false),
    hit100xAt: timestamp("hit_100x_at"),

    createdAt:        timestamp("created_at").defaultNow(),
  },
  (t) => [
    index("pro_calls_quality_score_idx").on(t.qualityLabel, t.proScore),
    index("pro_calls_quality_called_idx").on(t.qualityLabel, t.calledAt),
    index("pro_calls_called_at_idx").on(t.calledAt),
    index("pro_calls_ath_idx").on(t.athMultiple),
    index("pro_calls_survival_idx").on(t.survivalScore),
  ],
);
