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

import { pgTable, text, timestamp, real, integer, jsonb } from "drizzle-orm/pg-core";

export const wallet_profiles = pgTable("wallet_profiles", {
  walletAddress:   text("wallet_address").primaryKey(),
  labels:          text("labels").array().notNull().default([]),
  twitterName:     text("twitter_name"),
  twitterUsername: text("twitter_username"),
  firstSeenAt:     timestamp("first_seen_at").defaultNow().notNull(),
  lastSeenAt:      timestamp("last_seen_at").defaultNow().notNull(),
  // ── GMGN wallet_info enrichment ───────────────────────────────────────────
  // Fetched from /api/v1/wallet_info/{chain}/{wallet} and
  // /api/v1/wallet_holdings/{chain}/{wallet} on demand or when wallet is
  // identified as a creator/dev for a tracked token.
  totalPnlUsd:         real("total_pnl_usd"),        // lifetime PnL in USD
  realizedPnlUsd:      real("realized_pnl_usd"),
  unrealizedPnlUsd:    real("unrealized_pnl_usd"),
  winRate:             real("win_rate"),              // fraction 0-1
  avgHoldTimeSec:      integer("avg_hold_time_sec"),  // seconds
  totalTradeCount:     integer("total_trade_count"),
  solBalance:          real("sol_balance"),
  // Raw GMGN wallet_info payload for future field extraction
  gmgnProfile:         jsonb("gmgn_profile"),
  profileFetchedAt:    timestamp("profile_fetched_at"),
});

export type WalletProfile = typeof wallet_profiles.$inferSelect;
