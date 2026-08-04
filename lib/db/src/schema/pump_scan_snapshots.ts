/**
 * pump_scan_snapshots
 *
 * Point-in-time pump-fullend signal + MC captures for buy-sourced tokens.
 * Written by pump-buy-scanner on each successful Dex score refresh.
 * Used for gain-since-detection verification and detail tape.
 */

import {
  pgTable,
  serial,
  integer,
  real,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { tracked_tokens } from "./tracked_tokens";

export const pump_scan_snapshots = pgTable(
  "pump_scan_snapshots",
  {
    id: serial("id").primaryKey(),
    tokenId: integer("token_id")
      .notNull()
      .references(() => tracked_tokens.id, { onDelete: "cascade" }),
    snapshotAt: timestamp("snapshot_at").defaultNow().notNull(),

    score: real("score"),
    grade: text("grade"),
    buySignal: text("buy_signal"),
    intraSignal: text("intra_signal"),
    buyPassCount: integer("buy_pass_count"),
    intraPassCount: integer("intra_pass_count"),

    priceUsd: text("price_usd"),
    marketCapUsd: text("market_cap_usd"),
    liquidityUsd: text("liquidity_usd"),
    volume24hUsd: text("volume_24h_usd"),
    txns24h: integer("txns_24h"),

    priceAtDetection: text("price_at_detection"),
    mcAtDetection: text("mc_at_detection"),
    gainSinceDetection: real("gain_since_detection"),
    athGain: real("ath_gain"),
    mcGainSinceDetection: real("mc_gain_since_detection"),
    athMcGain: real("ath_mc_gain"),

    /** Full scan payload for signal condition replay */
    payload: jsonb("payload"),
  },
  (t) => [
    index("pump_scan_snapshots_token_snap_idx").on(t.tokenId, t.snapshotAt),
  ],
);

export type PumpScanSnapshot = typeof pump_scan_snapshots.$inferSelect;
export type InsertPumpScanSnapshot = typeof pump_scan_snapshots.$inferInsert;
