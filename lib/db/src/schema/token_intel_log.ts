/**
 * token_intel_log
 *
 * Immutable audit trail of every intelligence score computation that produced
 * a meaningful change (score shifts ≥ 1 point OR a status transition).
 *
 * Carries every factor and context input so you can replay exactly why the
 * score moved and whether the scoring logic is behaving correctly.
 */

import {
  pgTable,
  serial,
  integer,
  real,
  text,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";

export const token_intel_log = pgTable("token_intel_log", {
  id: serial("id").primaryKey(),

  // ── Token reference ──────────────────────────────────────────────────────────
  tokenId:      integer("token_id").notNull(),
  tokenAddress: text("token_address").notNull(),

  // ── Timestamp of this computation ────────────────────────────────────────────
  computedAt: timestamp("computed_at").defaultNow().notNull(),

  // ── Master intel score ────────────────────────────────────────────────────────
  intelligenceScore:    real("intelligence_score").notNull(),
  prevIntelligenceScore: real("prev_intelligence_score"), // null on first log entry

  // ── Five sub-scores (0–100 each) ──────────────────────────────────────────────
  mcGrowthScore:         real("mc_growth_score").notNull(),         // 35% weight
  volumeIntensityScore:  real("volume_intensity_score").notNull(),  // 25% weight
  holderVelocityScore:   real("holder_velocity_score").notNull(),   // 20% weight
  kolSmartScore:         real("kol_smart_score").notNull(),         // 15% weight
  liquidityHealthScore:  real("liquidity_health_score").notNull(),  // 5%  weight

  // ── Age factor applied to the raw weighted sum ────────────────────────────────
  ageMultiplier:    real("age_multiplier").notNull(),
  tokenAgeHours:    real("token_age_hours").notNull(),

  // ── Raw market data used for this computation ─────────────────────────────────
  marketCapUsd:   text("market_cap_usd"),
  volume24hUsd:   text("volume_24h_usd"),
  liquidityUsd:   text("liquidity_usd"),
  peakMcUsd:      real("peak_mc_usd"),

  // ── Holder data ───────────────────────────────────────────────────────────────
  holderCount:      integer("holder_count"),
  holderKolCount:   integer("holder_kol_count"),
  holderSmartCount: integer("holder_smart_count"),

  // ── Buy quality signal inputs ─────────────────────────────────────────────────
  totalBuys:        integer("total_buys"),
  smartBuys:        integer("smart_buys"),
  labeledFraction:  real("labeled_fraction"),  // smartBuys / totalBuys

  // ── Cohort context (for volume + holder velocity normalisation) ────────────────
  ageGroup:              text("age_group"),       // "new" | "young" | "mature"
  cohortSize:            integer("cohort_size"),  // # tokens in the same cohort
  cohortVolumePercentile: real("cohort_volume_percentile"),   // 0–1
  holderVelocityPerHour:  real("holder_velocity_per_hour"),

  // ── Graduation gate (new → active via intelligence path) ─────────────────────
  graduationConsecutive:   integer("graduation_consecutive"),  // current streak count
  graduationThresholdMet:  boolean("graduation_threshold_met"), // score ≥ 55 AND 3/5 positive

  // ── Lifecycle status ─────────────────────────────────────────────────────────
  statusBefore:   text("status_before").notNull(),
  statusAfter:    text("status_after").notNull(),
  statusChanged:  boolean("status_changed").notNull(),

  // ── Trigger for this log entry ────────────────────────────────────────────────
  // "score_change"   — intel score changed by ≥ 1 point
  // "status_change"  — lifecycle status changed (always logged regardless of score delta)
  // "first"          — first ever computation for this token
  trigger: text("trigger").notNull(),
});
