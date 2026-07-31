/**
 * Crypsor-owned wallet intel — separate from GMGN KOL / smart tags.
 *
 * We score holder behaviour from token_holder_snapshots.holders_data,
 * assign our own labels, accumulate weightage across tokens, and track
 * win/loss outcomes (2× ATH) for Crypsor win-rate.
 */

import {
  pgTable,
  serial,
  integer,
  real,
  text,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { tracked_tokens } from "./tracked_tokens";

/** Aggregate per-wallet profile (Crypsor labels + win-rate memory). */
export const crypsor_wallet_intel = pgTable(
  "crypsor_wallet_intel",
  {
    walletAddress: text("wallet_address").primaryKey(),
    /** diamond | accumulator | solid | watch | flipper | dump | whale | noise */
    ourLabel: text("our_label").notNull().default("noise"),
    /** 0–100 behaviour score from last judgment */
    behaviourScore: real("behaviour_score").notNull().default(0),
    /** Cumulative weight — increments on good sightings / wins */
    weightage: real("weightage").notNull().default(0),
    /** wins / (wins + losses), null until first settled outcome */
    winRate: real("win_rate"),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    tokensSeen: integer("tokens_seen").notNull().default(0),
    sightings: integer("sightings").notNull().default(0),
    avgHoldPct: real("avg_hold_pct"),
    lastTokenId: integer("last_token_id").references(() => tracked_tokens.id, {
      onDelete: "set null",
    }),
    lastReason: text("last_reason"),
    firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("crypsor_wallet_intel_label_idx").on(t.ourLabel),
    index("crypsor_wallet_intel_weight_idx").on(t.weightage),
    index("crypsor_wallet_intel_winrate_idx").on(t.winRate),
  ],
);

/**
 * Per wallet × token event log.
 * role = observed | win | loss — unique so increments stay idempotent.
 */
export const crypsor_wallet_token_events = pgTable(
  "crypsor_wallet_token_events",
  {
    id: serial("id").primaryKey(),
    walletAddress: text("wallet_address").notNull(),
    tokenId: integer("token_id")
      .notNull()
      .references(() => tracked_tokens.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // observed | win | loss
    ourLabelAt: text("our_label_at"),
    behaviourScoreAt: real("behaviour_score_at"),
    holdPct: real("hold_pct"),
    buyCount: integer("buy_count"),
    sellCount: integer("sell_count"),
    realizedPnl: real("realized_pnl"),
    snapshotId: integer("snapshot_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("crypsor_wte_wallet_token_role").on(t.walletAddress, t.tokenId, t.role),
    index("crypsor_wte_token_idx").on(t.tokenId),
    index("crypsor_wte_wallet_idx").on(t.walletAddress),
  ],
);

export type CrypsorWalletIntel = typeof crypsor_wallet_intel.$inferSelect;
export type CrypsorWalletTokenEvent = typeof crypsor_wallet_token_events.$inferSelect;
