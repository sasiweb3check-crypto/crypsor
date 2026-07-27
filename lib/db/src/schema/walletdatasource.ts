import { pgTable, serial, text, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const walletdatasource = pgTable(
  "walletdatasource",
  {
    id: serial("id").primaryKey(),
    address: text("address").notNull(),
    label: text("label").notNull(),
    chain: text("chain").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // ── Scheduler fields ──────────────────────────────────────────────────
    nextScanAt: timestamp("next_scan_at"),
    lastScanAt: timestamp("last_scan_at"),
    scanPriority: integer("scan_priority").default(5).notNull(),
    backoffSeconds: integer("backoff_seconds").default(0).notNull(),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    lastError: text("last_error"),
    health: text("health").default("good").notNull(), // good | degraded | failing
  },
  (t) => [unique("wallet_chain_unique").on(t.address, t.chain)],
);

export const insertWalletSchema = createInsertSchema(walletdatasource).omit({
  id: true,
  createdAt: true,
  nextScanAt: true,
  lastScanAt: true,
  scanPriority: true,
  backoffSeconds: true,
  consecutiveFailures: true,
  lastError: true,
  health: true,
});
export type InsertWallet = z.infer<typeof insertWalletSchema>;
export type Wallet = typeof walletdatasource.$inferSelect;
