/**
 * token_price_snapshots
 *
 * Point-in-time snapshot of a token's market data, written by the price
 * service on every cycle (~20s).  Used by the intelligence engine to compute
 * growth trends, EMA proxies, volume intensity, and liquidity health.
 *
 * Retention: rows older than 48 hours are pruned by the intelligence engine.
 */

import { pgTable, serial, integer, real, text, timestamp } from "drizzle-orm/pg-core";
import { tracked_tokens } from "./tracked_tokens";

export const token_price_snapshots = pgTable("token_price_snapshots", {
  id:           serial("id").primaryKey(),
  tokenId:      integer("token_id").notNull()
                  .references(() => tracked_tokens.id, { onDelete: "cascade" }),
  snapshotAt:   timestamp("snapshot_at").defaultNow().notNull(),
  priceUsd:     text("price_usd"),
  marketCapUsd: text("market_cap_usd"),
  liquidityUsd: text("liquidity_usd"),
  volume24hUsd: text("volume_24h_usd"),
});

export type TokenPriceSnapshot = typeof token_price_snapshots.$inferSelect;
export type InsertTokenPriceSnapshot = typeof token_price_snapshots.$inferInsert;
