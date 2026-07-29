import { pgTable, serial, text, integer, timestamp, unique, real } from "drizzle-orm/pg-core";
import { tracked_tokens } from "./tracked_tokens";

/**
 * token_holders — KOL and smart-money wallet registry.
 *
 * Only wallets tagged kol / renowned / smart_money / smart_degen are stored here.
 * One row per wallet address (unique on wallet_address), deduped across all tokens.
 * token_id tracks which token the wallet was most recently seen in.
 * On conflict (same wallet reappears in any token), only balance is updated.
 */
export const token_holders = pgTable(
  "token_holders",
  {
    id: serial("id").primaryKey(),
    // Last token this wallet was seen holding. Nullable — set to NULL if that
    // token is deleted (SET NULL cascade). Not part of the unique key.
    tokenId: integer("token_id")
      .references(() => tracked_tokens.id, { onDelete: "set null" }),
    walletAddress: text("wallet_address").notNull(),
    // ── Social identity ──────────────────────────────────────────────────────
    twitterName:     text("twitter_name"),
    twitterUsername: text("twitter_username"),
    // ── Classification labels (kol, renowned, smart_money, smart_degen) ──────
    labels: text("labels").array().notNull().default([]),
    // ── Position data ────────────────────────────────────────────────────────
    amountPercentage: real("amount_percentage"),
    balance:          text("balance"),            // raw token balance (primary field)
    costUsd:          text("cost_usd"),
    realizedProfit:   text("realized_profit"),
    unrealizedProfit: text("unrealized_profit"),
    // ── Activity ─────────────────────────────────────────────────────────────
    buyCount:  integer("buy_count").notNull().default(0),
    sellCount: integer("sell_count").notNull().default(0),
    // ── Snapshot context ─────────────────────────────────────────────────────
    snapshotMarketCapUsd: text("snapshot_market_cap_usd"),
    // ── Timestamps ───────────────────────────────────────────────────────────
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  // Unique per wallet address — same wallet deduped across all tokens.
  (t) => [unique("holder_wallet_unique").on(t.walletAddress)],
);

export type TokenHolder = typeof token_holders.$inferSelect;
