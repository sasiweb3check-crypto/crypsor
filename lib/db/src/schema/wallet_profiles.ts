/**
 * wallet_profiles — canonical per-wallet identity store.
 *
 * Instead of repeating wallet metadata (labels, twitter) in every
 * token_holders row, wallet identity is stored once here and position
 * data lives in token_holders (which keeps the (tokenId, walletAddress)
 * composite key for per-token balance/cost data).
 *
 * Labels are MERGED (union) across snapshots — once a wallet earns a
 * "smart_degen" label from any token's GMGN data it keeps it forever.
 */

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const wallet_profiles = pgTable("wallet_profiles", {
  walletAddress:  text("wallet_address").primaryKey(),
  labels:         text("labels").array().notNull().default([]),
  twitterName:    text("twitter_name"),
  twitterUsername: text("twitter_username"),
  firstSeenAt:    timestamp("first_seen_at").defaultNow().notNull(),
  lastSeenAt:     timestamp("last_seen_at").defaultNow().notNull(),
});

export type WalletProfile = typeof wallet_profiles.$inferSelect;
