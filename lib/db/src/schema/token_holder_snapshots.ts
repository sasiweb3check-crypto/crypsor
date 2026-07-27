/**
 * token_holder_snapshots
 *
 * Stores point-in-time snapshots of GMGN holder data per token.
 * Each snapshot captures the full holder array (with labels, Twitter,
 * PnL, etc.) plus pre-computed summary stats so the Holders UI can
 * render historical views and diffs.
 *
 * Snapshot types:
 *   discovery  — taken 12 s after first detection
 *   post_buy   — taken shortly after a new buy event
 *   hourly     — periodic refresh for momentum tokens
 *   daily      — end-of-day archive
 *   manual     — on-demand via API
 *   default    — fallback / background refresh
 */

import { pgTable, serial, integer, real, timestamp, text, jsonb, boolean } from "drizzle-orm/pg-core";
import { tracked_tokens } from "./tracked_tokens";

export const token_holder_snapshots = pgTable("token_holder_snapshots", {
  id: serial("id").primaryKey(),

  tokenId: integer("token_id")
    .notNull()
    .references(() => tracked_tokens.id, { onDelete: "cascade" }),

  snapshotAt: timestamp("snapshot_at").defaultNow().notNull(),

  // discovery | post_buy | hourly | daily | manual | default
  snapshotType: text("snapshot_type").default("default").notNull(),

  // ── Summary stats (pre-computed from holders_data) ──────────────────────────
  holderCount:     integer("holder_count"),
  top10Pct:        text("top_10_pct"),       // sum of top-10 amount_percentage
  smartMoneyCount: integer("smart_money_count"),
  kolCount:        integer("kol_count"),
  freshWalletCount: integer("fresh_wallet_count"),
  botCount:        integer("bot_count"),
  insiderCount:    integer("insider_count"),
  devCount:        integer("dev_count"),
  bluechipCount:   integer("bluechip_count"),
  bundlerCount:    integer("bundler_count"),
  sniperCount:     integer("sniper_count"),
  devHoldPct:      text("dev_hold_pct"),
  totalPnl:        text("total_pnl"),
  holdingRate:     text("holding_rate"),
  boughtRate:      text("bought_rate"),
  boughtMore:      integer("bought_more"),
  holdCount:       integer("hold_count"),
  soldPart:        integer("sold_part"),
  soldCount:       integer("sold_count"),
  momentumScore:   text("momentum_score"),
  momentumLabel:   text("momentum_label"),
  qualityScore:    real("quality_score"),
  // Holder Intelligence v2
  momentumScoreV2: real("momentum_score_v2"),
  clusterCount:    integer("cluster_count"),
  cabalDetected:   boolean("cabal_detected"),
  clusterData:     jsonb("cluster_data"),

  // ── Full GMGN holder array ───────────────────────────────────────────────────
  // All wallet data: address, labels, twitter, pnl, amount%, balance etc.
  holdersData: jsonb("holders_data").$type<unknown[]>().notNull().default([]),

  // Raw GMGN API payload for debugging / re-processing
  rawGmgnPayload: jsonb("raw_gmgn_payload"),

  fetchedTopCount:      integer("fetched_top_count"),
  snapshotMarketCapUsd: text("snapshot_market_cap_usd"),
});

export type TokenHolderSnapshot    = typeof token_holder_snapshots.$inferSelect;
export type InsertTokenHolderSnapshot = typeof token_holder_snapshots.$inferInsert;
