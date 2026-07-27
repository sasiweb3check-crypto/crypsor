/**
 * GET /api/social
 *
 * Returns tracked tokens enriched with social signals:
 * - News articles matched from RSS feeds (CryptoPanic, CoinTelegraph, Decrypt, CoinDesk)
 * - Buzz score (article count, weighted by recency)
 * - Direct X / Reddit search URLs
 *
 * RSS data is cached 30 min in-process; results are nearly instant on repeat calls.
 *
 * Query params:
 *   status  — comma-separated statuses to include (default: "new,active,watch,revived,archive")
 *   limit   — max tokens returned (default 100)
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { desc, inArray } from "drizzle-orm";
import { fetchAllArticles, matchesToken, cacheInfo, type RssArticle } from "../lib/rss-service";

const router = Router();

function buzzScore(articles: RssArticle[]): number {
  const now = Date.now();
  let score = 0;
  for (const a of articles) {
    const ageH = (now - new Date(a.publishedAt).getTime()) / 3_600_000;
    if      (ageH < 1)  score += 10;
    else if (ageH < 6)  score += 6;
    else if (ageH < 24) score += 3;
    else                score += 1;
  }
  return score;
}

function xSearchUrl(symbol: string | null, name: string | null): string {
  const q = symbol ? `$${symbol} crypto` : `${name ?? ""} crypto`;
  return `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`;
}

function redditSearchUrl(symbol: string | null, name: string | null): string {
  const q = symbol ?? name ?? "";
  return `https://www.reddit.com/search/?q=${encodeURIComponent(q)}&sort=new`;
}

router.get("/social", async (req, res) => {
  try {
    const statusParam = String(req.query.status ?? "new,active,watch,revived,archive");
    const statuses    = statusParam.split(",").map(s => s.trim()).filter(Boolean);
    const limit       = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 200);

    // Load tokens + RSS articles in parallel
    const [tokens, articles] = await Promise.all([
      db.select({
        id:               tracked_tokens.id,
        address:          tracked_tokens.address,
        name:             tracked_tokens.name,
        symbol:           tracked_tokens.symbol,
        status:           tracked_tokens.status,
        gainPct:          tracked_tokens.gainPct,
        athGainPct:       tracked_tokens.athGainPct,
        marketCapUsd:     tracked_tokens.marketCapUsd,
        intelligenceScore: tracked_tokens.intelligenceScore,
        imageStatus:      tracked_tokens.imageStatus,
        firstDetectedAt:  tracked_tokens.firstDetectedAt,
        lastStatusChangeAt: tracked_tokens.lastStatusChangeAt,
      })
        .from(tracked_tokens)
        .where(inArray(tracked_tokens.status, statuses))
        .orderBy(desc(tracked_tokens.intelligenceScore))
        .limit(limit),
      fetchAllArticles(),
    ]);

    const cache = cacheInfo();

    // Enrich each token
    const enriched = tokens.map(token => {
      const matched = articles.filter(a =>
        matchesToken(a, token.symbol, token.name),
      );

      // Keep top 5 most recent
      matched.sort((a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
      );
      const topNews = matched.slice(0, 5).map(a => ({
        title:       a.title,
        link:        a.link,
        source:      a.source,
        publishedAt: a.publishedAt,
      }));

      return {
        id:               token.id,
        address:          token.address,
        name:             token.name,
        symbol:           token.symbol,
        status:           token.status,
        gainPct:          token.gainPct,
        athGainPct:       token.athGainPct,
        marketCapUsd:     token.marketCapUsd,
        intelligenceScore: token.intelligenceScore,
        imageStatus:      token.imageStatus,
        firstDetectedAt:  token.firstDetectedAt,
        lastStatusChangeAt: token.lastStatusChangeAt,
        // Social
        buzzScore:        buzzScore(matched),
        newsCount:        matched.length,
        news:             topNews,
        xSearchUrl:       xSearchUrl(token.symbol, token.name),
        redditSearchUrl:  redditSearchUrl(token.symbol, token.name),
      };
    });

    // Sort: tokens with news first, then by buzz score, then by intel score
    enriched.sort((a, b) => {
      if (b.buzzScore !== a.buzzScore) return b.buzzScore - a.buzzScore;
      return (b.intelligenceScore ?? 0) - (a.intelligenceScore ?? 0);
    });

    res.json({
      totalTokens:      enriched.length,
      totalArticles:    articles.length,
      cacheAgeMinutes:  cache.ageMinutes,
      cachedAt:         cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
      tokens:           enriched,
    });
  } catch (err) {
    console.error("social route error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
