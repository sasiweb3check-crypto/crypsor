import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";

export const token_sells = pgTable(
  "token_sells",
  {
    id:       serial("id").primaryKey(),
    walletId: integer("wallet_id").notNull(),
    tokenId:  integer("token_id").notNull(),
    priceUsd: text("price_usd"),
    amount:   text("amount"),
    txHash:   text("tx_hash"),
    soldAt:   timestamp("sold_at").defaultNow().notNull(),
  },
  (t) => [unique("sell_tx_unique").on(t.txHash)],
);
