/**
 * GET /api/feed
 *
 * Unified activity feed — merges intel score events, wallet buy events,
 * and social buzz signals into a single chronological timeline.
 *
 * Query params:
 *   limit  — max events to return (default 60, max 200)
 *   type   — filter: "all" | "status_change" | "score_change" | "buy" | "social" (default "all")
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  token_intel_log,
  tracked_tokens,
  token_buys,
  token_sells,
  walletdatasource,
  social_signals,
} from "@workspace/db";
import { desc, eq, gte, and } from "drizzle-orm";

const router = Router();

function usdShort(val: string | number | null | undefined): string {
  if (val == null) return "—";
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (!isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

router.get("/feed", async (req, res) => {
  try {
    const limit      = Math.min(parseInt(String(req.query.limit ?? "60"), 10) || 60, 200);
    const typeFilter = String(req.query.type ?? "all");

    const fetchIntel  = typeFilter === "all" || typeFilter === "status_change" || typeFilter === "score_change";
    const fetchBuys   = typeFilter === "all" || typeFilter === "buy";
    const fetchSells  = typeFilter === "all" || typeFilter === "sell";
    const fetchSocial = typeFilter === "all" || typeFilter === "social";

    const since24h = new Date(Date.now() - 24 * 3_600_000);

    // ── Parallel fetch all event sources ─────────────────────────────────────
    const [intelRows, buyRows, sellRows, socialRows] = await Promise.all([
      fetchIntel ? db
        .select({
          id:                    token_intel_log.id,
          computedAt:            token_intel_log.computedAt,
          trigger:               token_intel_log.trigger,
          intelligenceScore:     token_intel_log.intelligenceScore,
          prevIntelligenceScore: token_intel_log.prevIntelligenceScore,
          statusBefore:          token_intel_log.statusBefore,
          statusAfter:           token_intel_log.statusAfter,
          statusChanged:         token_intel_log.statusChanged,
          marketCapUsd:          token_intel_log.marketCapUsd,
          tokenId:               token_intel_log.tokenId,
          tokenAddress:          token_intel_log.tokenAddress,
          tokenName:             tracked_tokens.name,
          tokenSymbol:           tracked_tokens.symbol,
          tokenStatus:           tracked_tokens.status,
          tokenGainPct:          tracked_tokens.gainPct,
          tokenImageStatus:      tracked_tokens.imageStatus,
        })
        .from(token_intel_log)
        .leftJoin(tracked_tokens, eq(token_intel_log.tokenId, tracked_tokens.id))
        .orderBy(desc(token_intel_log.computedAt))
        .limit(limit) : [],

      fetchBuys ? db
        .select({
          id:                token_buys.id,
          boughtAt:          token_buys.boughtAt,
          priceUsd:          token_buys.priceUsd,
          amount:            token_buys.amount,
          txHash:            token_buys.txHash,
          tokenId:           token_buys.tokenId,
          tokenAddress:      tracked_tokens.address,
          tokenName:         tracked_tokens.name,
          tokenSymbol:       tracked_tokens.symbol,
          tokenStatus:       tracked_tokens.status,
          tokenGainPct:      tracked_tokens.gainPct,
          tokenMarketCapUsd: tracked_tokens.marketCapUsd,
          tokenIntelScore:   tracked_tokens.intelligenceScore,
          tokenImageStatus:  tracked_tokens.imageStatus,
          walletLabel:       walletdatasource.label,
          walletAddress:     walletdatasource.address,
        })
        .from(token_buys)
        .leftJoin(tracked_tokens,   eq(token_buys.tokenId,  tracked_tokens.id))
        .leftJoin(walletdatasource, eq(token_buys.walletId, walletdatasource.id))
        .orderBy(desc(token_buys.boughtAt))
        .limit(limit) : [],

      fetchSells ? db
        .select({
          id:                token_sells.id,
          soldAt:            token_sells.soldAt,
          priceUsd:          token_sells.priceUsd,
          amount:            token_sells.amount,
          txHash:            token_sells.txHash,
          tokenId:           token_sells.tokenId,
          tokenAddress:      tracked_tokens.address,
          tokenName:         tracked_tokens.name,
          tokenSymbol:       tracked_tokens.symbol,
          tokenStatus:       tracked_tokens.status,
          tokenGainPct:      tracked_tokens.gainPct,
          tokenMarketCapUsd: tracked_tokens.marketCapUsd,
          tokenIntelScore:   tracked_tokens.intelligenceScore,
          tokenImageStatus:  tracked_tokens.imageStatus,
          walletLabel:       walletdatasource.label,
          walletAddress:     walletdatasource.address,
        })
        .from(token_sells)
        .leftJoin(tracked_tokens,   eq(token_sells.tokenId,  tracked_tokens.id))
        .leftJoin(walletdatasource, eq(token_sells.walletId, walletdatasource.id))
        .orderBy(desc(token_sells.soldAt))
        .limit(limit) : [],

      fetchSocial ? db
        .select({
          id:               social_signals.id,
          capturedAt:       social_signals.capturedAt,
          viralityScore:    social_signals.viralityScore,
          noveltyScore:     social_signals.noveltyScore,
          sentimentScore:   social_signals.sentimentScore,
          redditMentions1h: social_signals.redditMentions1h,
          redditMentions24h: social_signals.redditMentions24h,
          newsMentions2h:   social_signals.newsMentions2h,
          newsMentions24h:  social_signals.newsMentions24h,
          tokenId:          social_signals.tokenId,
          tokenAddress:     tracked_tokens.address,
          tokenName:        tracked_tokens.name,
          tokenSymbol:      tracked_tokens.symbol,
          tokenStatus:      tracked_tokens.status,
          tokenGainPct:     tracked_tokens.gainPct,
          tokenMarketCapUsd: tracked_tokens.marketCapUsd,
          tokenIntelScore:  tracked_tokens.intelligenceScore,
          tokenImageStatus: tracked_tokens.imageStatus,
        })
        .from(social_signals)
        .leftJoin(tracked_tokens, eq(social_signals.tokenId, tracked_tokens.id))
        .where(and(
          gte(social_signals.viralityScore, 15),
          gte(social_signals.capturedAt, since24h),
        ))
        .orderBy(desc(social_signals.capturedAt))
        .limit(limit) : [],
    ]);

    // ── Normalise into unified FeedEvent shape ────────────────────────────────
    type TokenMeta = {
      id: number; address: string; name: string | null; symbol: string | null;
      status: string | null; gainPct: number | null; marketCapUsd: string | null;
      intelligenceScore: number | null; imageStatus: string | null;
    };

    type FeedEvent = {
      id: string; type: string; ts: string;
      token: TokenMeta;
      intel?:  { scoreDelta: number | null; prevScore: number | null; newScore: number; statusBefore: string; statusAfter: string; trigger: string; mcapFmt: string };
      buy?:    { walletLabel: string | null; walletAddress: string | null; amount: string | null; priceUsd: string | null; txHash: string | null; mcapFmt: string };
      sell?:   { walletLabel: string | null; walletAddress: string | null; amount: string | null; priceUsd: string | null; txHash: string | null; mcapFmt: string };
      social?: { viralityScore: number; noveltyScore: number; sentimentScore: number; redditMentions1h: number; redditMentions24h: number; newsMentions2h: number; newsMentions24h: number };
    };

    const events: FeedEvent[] = [];

    // Intel events
    for (const e of intelRows) {
      const scoreDelta = e.prevIntelligenceScore !== null
        ? Math.round((e.intelligenceScore - e.prevIntelligenceScore) * 10) / 10
        : null;

      let evtType: string;
      if (e.trigger === "first")                                    evtType = "first_detected";
      else if (e.statusChanged)                                     evtType = "status_change";
      else if (scoreDelta !== null && scoreDelta >=  5)             evtType = "score_spike";
      else if (scoreDelta !== null && scoreDelta <= -5)             evtType = "score_drop";
      else                                                          evtType = "score_change";

      if (typeFilter === "status_change" && evtType !== "status_change") continue;
      if (typeFilter === "score_change"  && !evtType.startsWith("score")) continue;

      events.push({
        id: `intel:${e.id}`, type: evtType, ts: (e.computedAt as Date).toISOString(),
        token: {
          id: e.tokenId, address: e.tokenAddress,
          name: e.tokenName ?? null, symbol: e.tokenSymbol ?? null,
          status: e.tokenStatus ?? null, gainPct: e.tokenGainPct ?? null,
          marketCapUsd: e.marketCapUsd ?? null, intelligenceScore: e.intelligenceScore,
          imageStatus: e.tokenImageStatus ?? null,
        },
        intel: { scoreDelta, prevScore: e.prevIntelligenceScore, newScore: e.intelligenceScore,
          statusBefore: e.statusBefore, statusAfter: e.statusAfter, trigger: e.trigger,
          mcapFmt: usdShort(e.marketCapUsd) },
      });
    }

    // Buy events
    for (const b of buyRows) {
      events.push({
        id: `buy:${b.id}`, type: "buy", ts: (b.boughtAt as Date).toISOString(),
        token: {
          id: b.tokenId, address: b.tokenAddress ?? "",
          name: b.tokenName ?? null, symbol: b.tokenSymbol ?? null,
          status: b.tokenStatus ?? null, gainPct: b.tokenGainPct ?? null,
          marketCapUsd: b.tokenMarketCapUsd ?? null, intelligenceScore: b.tokenIntelScore ?? null,
          imageStatus: b.tokenImageStatus ?? null,
        },
        buy: { walletLabel: b.walletLabel ?? null, walletAddress: b.walletAddress ?? null,
          amount: b.amount, priceUsd: b.priceUsd, txHash: b.txHash,
          mcapFmt: usdShort(b.tokenMarketCapUsd) },
      });
    }

    // Sell events
    for (const s of sellRows) {
      events.push({
        id: `sell:${s.id}`, type: "sell", ts: (s.soldAt as Date).toISOString(),
        token: {
          id: s.tokenId, address: s.tokenAddress ?? "",
          name: s.tokenName ?? null, symbol: s.tokenSymbol ?? null,
          status: s.tokenStatus ?? null, gainPct: s.tokenGainPct ?? null,
          marketCapUsd: s.tokenMarketCapUsd ?? null, intelligenceScore: s.tokenIntelScore ?? null,
          imageStatus: s.tokenImageStatus ?? null,
        },
        sell: { walletLabel: s.walletLabel ?? null, walletAddress: s.walletAddress ?? null,
          amount: s.amount, priceUsd: s.priceUsd, txHash: s.txHash,
          mcapFmt: usdShort(s.tokenMarketCapUsd) },
      });
    }

    // Social buzz events
    for (const s of socialRows) {
      events.push({
        id: `social:${s.id}`, type: "social_buzz", ts: (s.capturedAt as Date).toISOString(),
        token: {
          id: s.tokenId, address: s.tokenAddress ?? "",
          name: s.tokenName ?? null, symbol: s.tokenSymbol ?? null,
          status: s.tokenStatus ?? null, gainPct: s.tokenGainPct ?? null,
          marketCapUsd: s.tokenMarketCapUsd ?? null, intelligenceScore: s.tokenIntelScore ?? null,
          imageStatus: s.tokenImageStatus ?? null,
        },
        social: {
          viralityScore:    s.viralityScore,
          noveltyScore:     s.noveltyScore,
          sentimentScore:   s.sentimentScore,
          redditMentions1h: s.redditMentions1h,
          redditMentions24h: s.redditMentions24h,
          newsMentions2h:   s.newsMentions2h,
          newsMentions24h:  s.newsMentions24h,
        },
      });
    }

    // Sort newest-first, trim to limit
    events.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    res.json({ total: events.length, events: events.slice(0, limit) });
  } catch (err) {
    console.error("feed route error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
