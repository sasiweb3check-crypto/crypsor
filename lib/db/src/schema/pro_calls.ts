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
} from "drizzle-orm/pg-core";

export const pro_calls = pgTable("pro_calls", {
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

  // ── Running ATH tracker (updated by snapshot worker) ────────────────────
  athMultiple:      real("ath_multiple").default(1), // max(current_mc / called_mc) ever seen
  lastSnapshotAt:   timestamp("last_snapshot_at"),

  // ── Pro Score (0-100) and quality label (updated every snapshot cycle) ──
  // Composite of: intel strength, MC/liquidity, ATH multiplier, gain momentum,
  // run-status quality, risk/security.  very_good ≥ 75 | good 55-74 | below < 55
  proScore:         real("pro_score"),
  qualityLabel:     text("quality_label"), // 'very_good' | 'good' | 'below'

  createdAt:        timestamp("created_at").defaultNow(),
});
