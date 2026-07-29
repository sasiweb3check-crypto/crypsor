import { pgTable, serial, text, integer, timestamp, unique, real, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tracked_tokens = pgTable(
  "tracked_tokens",
  {
    id: serial("id").primaryKey(),
    address: text("address").notNull(),
    chain: text("chain").notNull(),
    name: text("name"),
    symbol: text("symbol"),
    logoUri: text("logo_uri"),
    decimals: integer("decimals"),
    detectedPriceUsd: text("detected_price_usd"),
    currentPriceUsd: text("current_price_usd"),
    athPriceUsd: text("ath_price_usd"),
    marketCapUsd: text("market_cap_usd"),
    athMarketCapUsd: text("ath_market_cap_usd"),
    fdvUsd: text("fdv_usd"),
    liquidityUsd: text("liquidity_usd"),
    volume24hUsd: text("volume_24h_usd"),
    tokenCreatedAt: timestamp("token_created_at"),
    priceUpdatedAt: timestamp("price_updated_at"),
    firstDetectedAt: timestamp("first_detected_at").defaultNow().notNull(),
    lastBuyAt: timestamp("last_buy_at"),
    // ── Lifecycle engine ─────────────────────────────────────────────────
    // new | active | watch | archive | revived
    status: text("status").default("new").notNull(),
    // ── Migration tracking ────────────────────────────────────────────────
    // true = token has migrated (e.g. pump.fun → Raydium); exempt from auto-delete
    migrated: boolean("migrated").default(false).notNull(),
    // ── Momentum (precomputed buy counts per window) ──────────────────────
    momentum5m:  integer("momentum_5m").default(0).notNull(),
    momentum15m: integer("momentum_15m").default(0).notNull(),
    momentum30m: integer("momentum_30m").default(0).notNull(),
    momentum1h:  integer("momentum_1h").default(0).notNull(),
    momentum6h:  integer("momentum_6h").default(0).notNull(),
    momentum24h: integer("momentum_24h").default(0).notNull(),
    // ── Activity ─────────────────────────────────────────────────────────
    activeWallets: integer("active_wallets").default(0).notNull(),
    lastSellAt:    timestamp("last_sell_at"),
    // ── Precomputed projection (never compute in routes) ──────────────────
    gainPct:     real("gain_pct"),           // detected → current %
    athGainPct:  real("ath_gain_pct"),        // detected → ATH %
    buyPressure: integer("buy_pressure").default(0).notNull(),  // weighted momentum score
    // ── Image persistence ─────────────────────────────────────────────────
    imageStatus:     text("image_status").default("none").notNull(), // none|pending|ok|failed
    imageRetryCount: integer("image_retry_count").default(0).notNull(),
    imagePath:       text("image_path"),     // served via /api/assets/token/:id
    // ── Pipeline priority & holder snapshot tracking ──────────────────────────
    // Higher number = scanned sooner by the wallet scheduler
    priority:               integer("priority").default(0).notNull(),
    // FK (soft) to token_holder_snapshots — updated by TokenUpdater on each snapshot
    latestHolderSnapshotId: integer("latest_holder_snapshot_id"),
    lastHoldersUpdatedAt:   timestamp("last_holders_updated_at"),
    // ── GMGN holder intelligence (single token-level momentum source) ───────
    holderMomentumScore:    real("holder_momentum_score").default(0).notNull(),
    holderMomentumLabel:    text("holder_momentum_label").default("balanced").notNull(),
    holderCount:            integer("holder_count").default(0).notNull(),
    holderKolCount:         integer("holder_kol_count").default(0).notNull(),
    holderSmartCount:       integer("holder_smart_count").default(0).notNull(),
    holderTop10Pct:         real("holder_top10_pct").default(0).notNull(),
    holderHoldingRate:      real("holder_holding_rate").default(0).notNull(),
    holderBoughtRate:       real("holder_bought_rate").default(0).notNull(),
    holderMomentumUpdatedAt: timestamp("holder_momentum_updated_at"),
    holderQualityScore:  real("holder_quality_score").default(0).notNull(),
    holderBundlerCount:  integer("holder_bundler_count").default(0).notNull(),
    holderSniperCount:   integer("holder_sniper_count").default(0).notNull(),
    // ── Holder Intelligence v2 ─────────────────────────────────────────────
    // Dedicated v2 column — same blended formula (60% flow + 40% quality)
    // kept separate so the original holderMomentumScore can be deprecated
    // independently without breaking existing dashboard sorts/filters.
    holderMomentumScoreV2:   real("holder_momentum_score_v2").default(0).notNull(),
    // Cluster / cabal detection
    holderClusterCount:      integer("holder_cluster_count").default(0).notNull(),
    holderCabalDetected:     boolean("holder_cabal_detected"),
    holderLargestClusterPct: real("holder_largest_cluster_pct").default(0).notNull(),
    // Raw JSON payload from last metadata enrichment (DexScreener / PumpFun)
    rawMetadata:            jsonb("raw_metadata"),
    // ── Per-field staleness tracking ─────────────────────────────────────
    // Lets the UI show "Holders: 47m ago (stale)" with warning colors.
    metadataUpdatedAt:      timestamp("metadata_updated_at"),
    // ── Lifecycle hysteresis ──────────────────────────────────────────────
    // Set whenever status transitions (new→active, watch→archive, etc.)
    lastStatusChangeAt:     timestamp("last_status_change_at"),
    // ── Multi-type momentum (batch-computed, normalized 0-100) ────────────
    compositeMomentum:      real("composite_momentum").default(0).notNull(),
    priceMomentum:          real("price_momentum").default(0).notNull(),
    volumeMomentum:         real("volume_momentum").default(0).notNull(),
    buyPressureMomentum:    real("buy_pressure_momentum").default(0).notNull(),
    holderMomentumComputed: real("holder_momentum_computed").default(0).notNull(),
    liquidityMomentum:      real("liquidity_momentum"),          // null = no historical data
    volatilityAdjMomentum:  real("volatility_adj_momentum").default(0).notNull(),
    earlyMomentum:          real("early_momentum").default(0).notNull(),
    sustainedMomentum:      real("sustained_momentum").default(0).notNull(),
    revivalPotential:       real("revival_potential").default(0).notNull(),
    lowLiquidityFlag:       boolean("low_liquidity_flag").default(false).notNull(),
    // ── Intelligence Layer ────────────────────────────────────────────────────
    // Master intelligence score (0-100) blending 5 signal components with
    // risk penalties (top10 concentration, micro-cap) and bonuses
    intelligenceScore:      real("intelligence_score").default(0).notNull(),
    // Human-readable quality tier derived from intelligenceScore
    // Elite ≥82 | Excellent ≥72 | Strong ≥62 | Good ≥52 | Average ≥40 | Speculative ≥25 | Weak <25
    qualityLabel:           text("quality_label").default("Weak").notNull(),
    // Sub-scores (0-100 each)
    mcGrowthScore:          real("mc_growth_score").default(0).notNull(),
    volumeIntensityScore:   real("volume_intensity_score").default(0).notNull(),
    holderVelocityScore:    real("holder_velocity_score").default(0).notNull(),
    kolSmartScore:          real("kol_smart_score").default(0).notNull(),
    liquidityHealthScore:   real("liquidity_health_score").default(0).notNull(),
    intelligenceUpdatedAt:  timestamp("intelligence_updated_at"),
    // Consecutive positive-signal check counter (for New→Active graduation)
    consecutivePositiveChecks: integer("consecutive_positive_checks").default(0).notNull(),
    // Peak MC seen so far (for draw-down %)
    peakMcUsd:              real("peak_mc_usd"),
    // ── Social intelligence ────────────────────────────────────────────────
    socialViralityScore:  real("social_virality_score").default(0).notNull(),
    socialSentimentScore: real("social_sentiment_score").default(0).notNull(),
    socialNoveltyScore:   real("social_novelty_score").default(0).notNull(),
    socialUpdatedAt:      timestamp("social_updated_at"),
    // ── Security / CA analysis (GMGN token_security + token_info) ─────────────
    secIsHoneypot:          boolean("sec_is_honeypot"),
    secOwnerRenounced:      boolean("sec_owner_renounced"),
    secMintRenounced:       boolean("sec_mint_renounced"),         // SOL: renounced_mint
    secFreezeRenounced:     boolean("sec_freeze_renounced"),       // SOL: renounced_freeze_account
    secOpenSource:          boolean("sec_open_source"),
    secTop10HolderRate:     real("sec_top10_holder_rate"),
    secRugRatio:            real("sec_rug_ratio"),
    secSniperCount:         integer("sec_sniper_count"),
    secCreatorAddress:      text("sec_creator_address"),
    secCreatorClose:        boolean("sec_creator_close"),
    secCreatorTokenStatus:  text("sec_creator_token_status"),      // "creator_close" | "creator_hold"
    secBuyTax:              real("sec_buy_tax"),
    secSellTax:             real("sec_sell_tax"),
    secLpLocked:            boolean("sec_lp_locked"),
    secLpLockPercent:       real("sec_lp_lock_percent"),
    secCtoFlag:             boolean("sec_cto_flag"),
    secBluechipOwnerPct:    real("sec_bluechip_owner_pct"),
    secRatTraderAmtRate:    real("sec_rat_trader_amt_rate"),
    secCreatorCreatedCount: integer("sec_creator_created_count"),  // how many tokens creator launched
    secFetchedAt:           timestamp("sec_fetched_at"),
    // ── Composite scoring (scoringEngine.ts — holder-velocity-dominant weights) ──
    // Runs alongside intelligenceScore; same sub-scores, different formula.
    compositeScore:         real("composite_score"),
    compositeFactors:       jsonb("composite_factors").$type<string[]>(),
    compositeUpdatedAt:     timestamp("composite_updated_at"),
    // ── Caller alert state (persisted so restarts can't cause duplicate/missed alerts) ──
    // Postmortem label (GOOD_SETUP | SURPRISE_SIGNAL | DUMP_WARNING) last actually alerted —
    // a new alert only fires when the live label differs from this.
    lastAlertedLabel:       text("last_alerted_label"),
    lastAlertedAt:          timestamp("last_alerted_at"),
    // Highest ATH-multiple achievement tier (2/3/5/10) already alerted for this token.
    athAlertMultiple:       real("ath_alert_multiple").default(0).notNull(),
  },
  (t) => [unique("token_chain_unique").on(t.address, t.chain)],
);

export const insertTrackedTokenSchema = createInsertSchema(tracked_tokens).omit({
  id: true,
  firstDetectedAt: true,
});
export type InsertTrackedToken = z.infer<typeof insertTrackedTokenSchema>;
export type TrackedToken = typeof tracked_tokens.$inferSelect;
