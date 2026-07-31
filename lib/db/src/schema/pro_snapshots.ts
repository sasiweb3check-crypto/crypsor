/**
 * pro_snapshots
 *
 * Periodic snapshots (every 5 min) of market data for all pro-called tokens.
 * Sourced from tracked_tokens (already maintained by the main pipeline) — no
 * extra GMGN calls needed.
 */

import {
  pgTable,
  serial,
  integer,
  real,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const pro_snapshots = pgTable(
  "pro_snapshots",
  {
    id:           serial("id").primaryKey(),

    proCallId:    integer("pro_call_id").notNull(),  // FK -> pro_calls.id
    tokenId:      integer("token_id").notNull(),      // FK -> tracked_tokens.id

    snapshotAt:   timestamp("snapshot_at").defaultNow().notNull(),

    // ── Market state at snapshot time ────────────────────────────────────────
    mcUsd:        text("mc_usd"),
    kolCount:     integer("kol_count").default(0),
    smartCount:   integer("smart_count").default(0),
    intelScore:   real("intel_score"),

    // ── ATH multiple at this snapshot (current_mc / called_mc) ──────────────
    athMultiple:  real("ath_multiple"),

    // ── Pro Score v2 snapshot fields (survival / age tracking) ───────────────
    survivalScore:        real("survival_score"),
    proScore:             real("pro_score"),
    qualityLabel:         text("quality_label"),
    gainPct:              real("gain_pct"),
    runStatus:            text("run_status"),
    holderVelocityScore:  real("holder_velocity_score"),
    ageHours:             real("age_hours"),
  },
  (t) => [
    index("pro_snapshots_call_snap_idx").on(t.proCallId, t.snapshotAt),
  ],
);
