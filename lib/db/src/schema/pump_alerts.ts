/**
 * pump_alerts — notable pump-desk signals (BUY / INTRA / grade / EEI / gain milestones).
 * Powers in-app notification center + Telegram (active path only).
 */

import {
  pgTable,
  serial,
  integer,
  real,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tracked_tokens } from "./tracked_tokens";

export const pump_alerts = pgTable(
  "pump_alerts",
  {
    id: serial("id").primaryKey(),
    tokenId: integer("token_id")
      .notNull()
      .references(() => tracked_tokens.id, { onDelete: "cascade" }),
    /** STRONG_BUY | INTRA_NOW | GRADE_S | GRADE_A | EEI | LARRY | GAIN_50 | ATH_2X | ATH_5X | ATH_10X */
    kind: text("kind").notNull(),
    /** Short UI chip label */
    label: text("label").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    score: real("score"),
    grade: text("grade"),
    buySignal: text("buy_signal"),
    intraSignal: text("intra_signal"),
    marketCapUsd: text("market_cap_usd"),
    mcAtDetection: text("mc_at_detection"),
    gainPct: real("gain_pct"),
    athGainPct: real("ath_gain_pct"),
    symbol: text("symbol"),
    name: text("name"),
    address: text("address"),
    telegramSent: boolean("telegram_sent").default(false).notNull(),
    telegramError: text("telegram_error"),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("pump_alerts_token_kind_uidx").on(t.tokenId, t.kind),
    index("pump_alerts_created_idx").on(t.createdAt),
    index("pump_alerts_unread_idx").on(t.readAt, t.createdAt),
  ],
);

export type PumpAlert = typeof pump_alerts.$inferSelect;
export type InsertPumpAlert = typeof pump_alerts.$inferInsert;
