/**
 * token_traders — top traders per token from GMGN.
 *
 * Distinct from token_holders: traders are ranked by profit/volume from the
 * GMGN top_traders endpoint. A wallet can appear here without being a current
 * holder (they may have already sold). Labels include FOMO, smart_degen, KOL,
 * insider, sniper, etc. — all sourced directly from GMGN.
 */

import { pgTable, serial, text, integer, timestamp, unique, real } from "drizzle-orm/pg-core";
import { tracked_tokens } from "./tracked_tokens";

export const token_traders = pgTable(
  "token_traders",
  {
    id:            serial("id").primaryKey(),
    tokenId:       integer("token_id")
                     .notNull()
                     .references(() => tracked_tokens.id, { onDelete: "cascade" }),
    walletAddress: text("wallet_address").notNull(),
    // ── Social identity ──────────────────────────────────────────────────────
    twitterName:     text("twitter_name"),
    twitterUsername: text("twitter_username"),
    // ── GMGN labels (fomo, smart_degen, kol, renowned, insider, sniper, etc.) ─
    labels: text("labels").array().notNull().default([]),
    // ── P&L ─────────────────────────────────────────────────────────────────
    profit:            real("profit"),             // profit ratio (e.g. 2.5 = 250% gain)
    profitUsd:         real("profit_usd"),         // realized + unrealized USD profit
    realizedProfit:    real("realized_profit"),    // USD already taken
    unrealizedProfit:  real("unrealized_profit"),  // USD still in position
    // ── Volume ──────────────────────────────────────────────────────────────
    buyVolumeUsd:  real("buy_volume_usd"),
    sellVolumeUsd: real("sell_volume_usd"),
    netFlowUsd:    real("net_flow_usd"),           // buy - sell
    // ── Trade counts ────────────────────────────────────────────────────────
    buyCount:  integer("buy_count").notNull().default(0),
    sellCount: integer("sell_count").notNull().default(0),
    // ── Avg price ───────────────────────────────────────────────────────────
    avgBuyPriceUsd:  real("avg_buy_price_usd"),
    avgSellPriceUsd: real("avg_sell_price_usd"),
    // ── Current position ────────────────────────────────────────────────────
    holdingPct: real("holding_pct"),    // % of supply still held (0 = fully sold)
    // ── Timestamps ──────────────────────────────────────────────────────────
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("trader_token_wallet_unique").on(t.tokenId, t.walletAddress)],
);

export type TokenTrader = typeof token_traders.$inferSelect;
