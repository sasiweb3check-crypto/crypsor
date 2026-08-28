/**
 * CoinGecko public API — trending + Solana contract lookup.
 * No key. Pace calls; cache the trending list.
 */
import { logger } from "../core/log";
import { pace } from "./pace";
import { httpsImage } from "../scoring/image";

export type GeckoHit = {
  id: string;
  symbol: string;
  name: string;
  mint: string | null;
  image: string | null;
  geckoUpPct: number | null;
  source: "gecko_trending";
};

type Trending = {
  coins?: Array<{
    item?: {
      id?: string;
      symbol?: string;
      name?: string;
      thumb?: string;
      small?: string;
      data?: { sentiment_votes_up_percentage?: number };
    };
  }>;
};

type Coin = {
  id?: string;
  symbol?: string;
  name?: string;
  image?: { small?: string; thumb?: string };
  platforms?: Record<string, string | undefined>;
  sentiment_votes_up_percentage?: number;
};

let cache: { at: number; hits: GeckoHit[] } | null = null;
const CACHE_MS = 8 * 60_000;

async function json<T>(url: string): Promise<T | null> {
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 429) return null;
    if (!resp.ok) return null;
    return await resp.json() as T;
  } catch (err) {
    logger.debug({ err, url }, "coingecko fetch failed");
    return null;
  }
}

export async function geckoTrending(limit = 6): Promise<GeckoHit[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.hits.slice(0, limit);
  await pace("gecko", 2_500);
  const trending = await json<Trending>("https://api.coingecko.com/api/v3/search/trending");
  const items = (trending?.coins ?? []).map((c) => c.item).filter(Boolean).slice(0, 8);
  const hits: GeckoHit[] = [];
  for (const item of items) {
    if (!item?.id) continue;
    await pace("gecko", 2_200);
    const coin = await json<Coin>(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(item.id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`);
    const mint = coin?.platforms?.solana || null;
    if (!mint) continue;
    hits.push({
      id: item.id,
      symbol: (coin?.symbol || item.symbol || "").toUpperCase(),
      name: coin?.name || item.name || item.id,
      mint,
      image: httpsImage(coin?.image?.small || coin?.image?.thumb || item.small || item.thumb),
      geckoUpPct: coin?.sentiment_votes_up_percentage ?? item.data?.sentiment_votes_up_percentage ?? null,
      source: "gecko_trending",
    });
    if (hits.length >= limit) break;
  }
  cache = { at: Date.now(), hits };
  return hits;
}
