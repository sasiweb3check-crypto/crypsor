import { pgTable, serial, text, integer, timestamp, unique, real } from "drizzle-orm/pg-core";
import { tracked_tokens } from "./tracked_tokens";

export const token_holders = pgTable(
  "token_holders",
  {
    id: serial("id").primaryKey(),
    tokenId: integer("token_id")
      .notNull()
      .references(() => tracked_tokens.id, { onDelete: "cascade" }),
    walletAddress: text("wallet_address").notNull(),
    // ── Social identity ──────────────────────────────────────────────────────
    twitterName:     text("twitter_name"),     // display name e.g. "Ansem"
    twitterUsername: text("twitter_username"), // handle e.g. "blknoiz06"
    // ── Classification labels (kol, smart_money, smart_degen, whale, etc.) ───
    labels: text("labels").array().notNull().default([]),
    // ── Position data ────────────────────────────────────────────────────────
    amountPercentage: real("amount_percentage"),  // % of total supply held
    balance:          text("balance"),            // raw token balance
    costUsd:          text("cost_usd"),           // total invested USD (cost basis)
    realizedProfit:   text("realized_profit"),
    unrealizedProfit: text("unrealized_profit"),
    // ── Activity ─────────────────────────────────────────────────────────────
    buyCount:  integer("buy_count").notNull().default(0),
    sellCount: integer("sell_count").notNull().default(0),
    // ── Snapshot context — MC at the time this snapshot was taken ────────────
    snapshotMarketCapUsd: text("snapshot_market_cap_usd"),
    // ── Timestamps ───────────────────────────────────────────────────────────
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("holder_token_wallet_unique").on(t.tokenId, t.walletAddress)],
);

export type TokenHolder = typeof token_holders.$inferSelect;
