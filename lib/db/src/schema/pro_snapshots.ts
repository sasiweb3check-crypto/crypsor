/**
 * pro_snapshots
 *
 * Periodic snapshots of market + intel state for pro-called tokens after the
 * call freeze. Used by trader detail charts and milestone / postmortem views.
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

    proCallId:    integer("pro_call_id").notNull(),
    tokenId:      integer("token_id").notNull(),

    snapshotAt:   timestamp("snapshot_at").defaultNow().notNull(),

    mcUsd:        text("mc_usd"),
    kolCount:     integer("kol_count").default(0),
    smartCount:   integer("smart_count").default(0),
    intelScore:   real("intel_score"),

    // Current MC / called MC at this snapshot (not the running max ATH)
    athMultiple:  real("ath_multiple"),

    survivalScore:        real("survival_score"),
    proScore:             real("pro_score"),
    qualityLabel:         text("quality_label"),
    gainPct:              real("gain_pct"),
    runStatus:            text("run_status"),
    holderVelocityScore:  real("holder_velocity_score"),
    ageHours:             real("age_hours"),

    // ── Enriched trader intel (added for Pro postmortem / detail) ────────────
    holderCount:          integer("holder_count"),
    mcGrowthScore:        real("mc_growth_score"),
    volumeIntensityScore: real("volume_intensity_score"),
    liquidityUsd:         text("liquidity_usd"),
    // Deltas vs call freeze (positive = more KOL/smart arrived after call)
    kolDelta:             integer("kol_delta").default(0),
    smartDelta:           integer("smart_delta").default(0),
  },
  (t) => [
    index("pro_snapshots_call_snap_idx").on(t.proCallId, t.snapshotAt),
  ],
);
