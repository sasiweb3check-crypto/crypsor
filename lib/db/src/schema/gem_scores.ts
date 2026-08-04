import {
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { tracked_tokens } from "./tracked_tokens";

/**
 * GEM engine verdicts — one row per token, updated every evaluation.
 *
 * `score` (0-100) is the single final number the desk/alerts trust.
 * `verdict`: GEM | WATCH | NEUTRAL | AVOID
 * `confidence` (0-1): evidence completeness — a GEM verdict is only allowed
 *   when confidence is high (tape depth + fresh holder data + security fetched).
 * `components`: per-pillar breakdown (flow/holders/smart/structure/timing)
 * `vetoes`: hard-fail reasons that force AVOID regardless of score.
 *
 * Call anchors: `first_gem_at` + `gem_call_mc_usd` are sticky from the first
 * GEM verdict; `peak_after_call_mc` tracks outcome for milestone alerts and
 * honest hit-rate accounting.
 */
export const gem_scores = pgTable("gem_scores", {
  id: serial("id").primaryKey(),
  tokenId: integer("token_id")
    .references(() => tracked_tokens.id)
    .notNull()
    .unique(),

  score: real("score").notNull(),
  verdict: text("verdict").notNull(),
  confidence: real("confidence").notNull(),
  components: jsonb("components").notNull(),
  vetoes: jsonb("vetoes"),
  snapshotsUsed: integer("snapshots_used").default(0).notNull(),

  /** Consecutive evaluations at GEM-qualifying score (persistence gate) */
  gemStreak: integer("gem_streak").default(0).notNull(),

  firstGemAt: timestamp("first_gem_at"),
  gemCallMcUsd: real("gem_call_mc_usd"),
  peakAfterCallMc: real("peak_after_call_mc"),

  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
