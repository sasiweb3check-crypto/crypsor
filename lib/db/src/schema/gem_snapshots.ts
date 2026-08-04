import {
  index,
  integer,
  pgTable,
  real,
  serial,
  timestamp,
} from "drizzle-orm/pg-core";
import { tracked_tokens } from "./tracked_tokens";

/**
 * GEM engine tape — compact numeric time series per buy-sourced token.
 *
 * One row per scan tick (~45-60s while a token is hot). This is the raw
 * evidence the GEM score is computed from: market state + short-window
 * flow (5m/1h buys/sells + volume) + holder count at that moment.
 *
 * Kept intentionally flat/numeric (no jsonb) so window deltas — velocity,
 * acceleration, holder growth — are cheap SQL/JS over a handful of rows.
 */
export const gem_snapshots = pgTable(
  "gem_snapshots",
  {
    id: serial("id").primaryKey(),
    tokenId: integer("token_id")
      .references(() => tracked_tokens.id)
      .notNull(),
    at: timestamp("at").defaultNow().notNull(),

    mcUsd: real("mc_usd"),
    liqUsd: real("liq_usd"),
    priceUsd: real("price_usd"),

    vol5m: real("vol_5m"),
    vol1h: real("vol_1h"),
    vol24h: real("vol_24h"),

    buys5m: integer("buys_5m"),
    sells5m: integer("sells_5m"),
    buys1h: integer("buys_1h"),
    sells1h: integer("sells_1h"),

    priceChange5m: real("price_change_5m"),
    priceChange1h: real("price_change_1h"),

    /** tracked_tokens.holder_count at snapshot time (null = not fetched yet) */
    holderCount: integer("holder_count"),

    /** GMGN live intel at snapshot time (gem-enrich) */
    top10Pct: real("top10_pct"),
    smartCount: integer("smart_count"),
    kolCount: integer("kol_count"),
    smartHoldPct: real("smart_hold_pct"),
    kolHoldPct: real("kol_hold_pct"),
    sniperHoldPct: real("sniper_hold_pct"),
    bundlerHoldPct: real("bundler_hold_pct"),
  },
  (t) => [index("idx_gem_snapshots_token_at").on(t.tokenId, t.at)],
);
