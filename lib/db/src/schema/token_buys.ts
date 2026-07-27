import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { walletdatasource } from "./walletdatasource";
import { tracked_tokens } from "./tracked_tokens";

export const token_buys = pgTable("token_buys", {
  id: serial("id").primaryKey(),
  walletId: integer("wallet_id")
    .notNull()
    .references(() => walletdatasource.id, { onDelete: "cascade" }),
  tokenId: integer("token_id")
    .notNull()
    .references(() => tracked_tokens.id, { onDelete: "cascade" }),
  priceUsd: text("price_usd"),
  amount: text("amount"),
  txHash: text("tx_hash"),
  boughtAt: timestamp("bought_at").defaultNow().notNull(),
});

export const insertTokenBuySchema = createInsertSchema(token_buys).omit({
  id: true,
  boughtAt: true,
});
export type InsertTokenBuy = z.infer<typeof insertTokenBuySchema>;
export type TokenBuy = typeof token_buys.$inferSelect;
