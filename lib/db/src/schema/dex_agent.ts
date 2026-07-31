/**
 * Dex Autopilot — automated paper agent book + pattern memory.
 * Marks to live on-chain MC from tracked_tokens. No emotional discretion.
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

export const dex_agent_state = pgTable("dex_agent_state", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").default(true).notNull(),
  bankrollUsd: real("bankroll_usd").default(1000).notNull(),
  realizedPnlUsd: real("realized_pnl_usd").default(0).notNull(),
  tradesOpened: integer("trades_opened").default(0).notNull(),
  tradesClosed: integer("trades_closed").default(0).notNull(),
  hits3x: integer("hits_3x").default(0).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const dex_positions = pgTable(
  "dex_positions",
  {
    id: serial("id").primaryKey(),
    tokenId: integer("token_id").notNull(),
    proCallId: integer("pro_call_id"),
    address: text("address").notNull(),
    symbol: text("symbol"),
    /** Original paper stake at entry */
    stakeUsd: real("stake_usd").notNull(),
    /** Remaining stake after moon-bag partial (0 = fully closed) */
    remainingStakeUsd: real("remaining_stake_usd").notNull(),
    entryMcUsd: real("entry_mc_usd").notNull(),
    entryAt: timestamp("entry_at").defaultNow().notNull(),
    entryPhase: text("entry_phase"),
    entryScore: real("entry_score"),
    entryVelocity: real("entry_velocity"),
    entrySnapCount: integer("entry_snap_count"),
    patternKey: text("pattern_key"),
    peakMultiple: real("peak_multiple").default(1),
    moonBagTaken: boolean("moon_bag_taken").default(false).notNull(),
    status: text("status").default("open").notNull(), // open | moon | closed
    exitMcUsd: real("exit_mc_usd"),
    exitAt: timestamp("exit_at"),
    exitReason: text("exit_reason"),
    realizedPnlUsd: real("realized_pnl_usd").default(0),
  },
  (t) => [
    index("dex_positions_status_idx").on(t.status),
    index("dex_positions_token_idx").on(t.tokenId),
  ],
);

export const dex_agent_events = pgTable(
  "dex_agent_events",
  {
    id: serial("id").primaryKey(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    kind: text("kind").notNull(), // enter | take_profit | moon_trail | stop | skip | pattern
    level: text("level").default("info").notNull(),
    msg: text("msg").notNull(),
    tokenId: integer("token_id"),
    symbol: text("symbol"),
    meta: text("meta"), // JSON
  },
  (t) => [index("dex_agent_events_created_idx").on(t.createdAt)],
);

export const dex_patterns = pgTable(
  "dex_patterns",
  {
    id: serial("id").primaryKey(),
    patternKey: text("pattern_key").notNull().unique(),
    samples: integer("samples").default(0).notNull(),
    wins3x: integer("wins_3x").default(0).notNull(),
    losses: integer("losses").default(0).notNull(),
    sumExitMultiple: real("sum_exit_multiple").default(0).notNull(),
    bestMultiple: real("best_multiple").default(1),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    notes: text("notes"),
  },
  (t) => [index("dex_patterns_key_idx").on(t.patternKey)],
);
