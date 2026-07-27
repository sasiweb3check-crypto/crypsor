import { pgTable, serial, integer, real, timestamp } from "drizzle-orm/pg-core";

export const social_signals = pgTable("social_signals", {
  id:                serial("id").primaryKey(),
  tokenId:           integer("token_id").notNull(),
  redditMentions1h:  integer("reddit_mentions_1h").default(0).notNull(),
  redditMentions24h: integer("reddit_mentions_24h").default(0).notNull(),
  redditTopScore:    integer("reddit_top_score").default(0).notNull(),
  newsMentions2h:    integer("news_mentions_2h").default(0).notNull(),
  newsMentions24h:   integer("news_mentions_24h").default(0).notNull(),
  sentimentScore:    real("sentiment_score").default(0).notNull(),   // -100 to 100
  viralityScore:     real("virality_score").default(0).notNull(),    // 0 to 100
  noveltyScore:      real("novelty_score").default(0).notNull(),     // 0 to 100
  capturedAt:        timestamp("captured_at").defaultNow().notNull(),
});
