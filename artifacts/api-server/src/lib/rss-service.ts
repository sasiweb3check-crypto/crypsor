/**
 * RSS Service
 *
 * Fetches crypto news RSS feeds, caches them in-process (30 min TTL),
 * and matches articles to tracked tokens by symbol / name.
 *
 * No external packages needed — pure Node.js fetch + regex XML parser.
 */

export interface RssArticle {
  title:       string;
  link:        string;
  description: string;
  source:      string;   // feed display name
  publishedAt: string;   // ISO or original pubDate string
}

interface FeedCache {
  articles:  RssArticle[];
  fetchedAt: number;
}

// ── RSS sources ───────────────────────────────────────────────────────────────

const FEEDS: { name: string; url: string }[] = [
  { name: "CryptoPanic",   url: "https://cryptopanic.com/feed"                               },
  { name: "CoinTelegraph", url: "https://cointelegraph.com/rss"                              },
  { name: "Decrypt",       url: "https://decrypt.co/feed"                                    },
  { name: "CoinDesk",      url: "https://www.coindesk.com/arc/outboundfeeds/rss/"            },
  { name: "BeInCrypto",    url: "https://beincrypto.com/feed/"                               },
];

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const cache = new Map<string, FeedCache>();

// ── XML helpers ───────────────────────────────────────────────────────────────

function extractTag(xml: string, tag: string): string {
  // Handle CDATA and plain text content
  const pattern = new RegExp(
    `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>` +
    `|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "i",
  );
  const m = xml.match(pattern);
  if (!m) return "";
  return ((m[1] ?? m[2]) || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
}

function parseItems(xml: string, sourceName: string): RssArticle[] {
  const articles: RssArticle[] = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const content     = m[1];
    const title       = extractTag(content, "title");
    const link        = extractTag(content, "link") || extractTag(content, "guid");
    const description = extractTag(content, "description");
    const pubDate     = extractTag(content, "pubDate") || extractTag(content, "dc:date") || "";

    if (!title || !link) continue;

    let isoDate = pubDate;
    try { isoDate = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(); } catch {}

    articles.push({ title, link, description, source: sourceName, publishedAt: isoDate });
  }
  return articles;
}

// ── Fetcher ───────────────────────────────────────────────────────────────────

async function fetchFeed(feed: { name: string; url: string }): Promise<RssArticle[]> {
  const cached = cache.get(feed.url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.articles;
  }

  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": "CrypsorBot/1.0 (token intelligence monitor)" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml      = await res.text();
    const articles = parseItems(xml, feed.name);
    cache.set(feed.url, { articles, fetchedAt: Date.now() });
    return articles;
  } catch (err) {
    // Return stale cache if available, else empty
    return cache.get(feed.url)?.articles ?? [];
  }
}

/** Fetch all feeds in parallel; return flat deduplicated list */
export async function fetchAllArticles(): Promise<RssArticle[]> {
  const results = await Promise.allSettled(FEEDS.map(f => fetchFeed(f)));
  const all: RssArticle[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const a of r.value) {
      if (!seen.has(a.link)) { seen.add(a.link); all.push(a); }
    }
  }
  return all;
}

// ── Token matching ────────────────────────────────────────────────────────────

/**
 * Returns true if the article text mentions this token.
 * Prioritises $SYMBOL pattern; falls back to name match for longer names.
 */
export function matchesToken(
  article: RssArticle,
  symbol:  string | null,
  name:    string | null,
): boolean {
  const text = `${article.title} ${article.description}`.toLowerCase();

  if (symbol && symbol.length >= 3) {
    if (text.includes(`$${symbol.toLowerCase()}`)) return true;
  }
  if (symbol && symbol.length >= 5) {
    if (text.includes(symbol.toLowerCase())) return true;
  }
  if (name && name.length >= 5) {
    if (text.includes(name.toLowerCase())) return true;
  }
  return false;
}

/**
 * Fetch Google News RSS for a specific token and return windowed article counts.
 * Used by the social intel service for per-token news velocity.
 */
export async function fetchTokenNewsArticles(
  symbol: string | null,
  name:   string | null,
): Promise<{
  count2h:     number;
  count24h:    number;
  topHeadline: string | null;
  topSource:   string | null;
  topLink:     string | null;
}> {
  const empty = { count2h: 0, count24h: 0, topHeadline: null, topSource: null, topLink: null };
  const sym = symbol?.replace(/[^a-zA-Z0-9]/g, "") ?? "";
  if (!sym && !name) return empty;

  const query = sym.length >= 3
    ? `${sym} crypto`
    : `"${name}" crypto`;

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en&gl=US&ceid=US:en`;

  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Crypsor/1.0 token-intelligence" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const xml      = await resp.text();
    const articles = parseItems(xml, "Google News");

    const now = Date.now();
    let count2h = 0, count24h = 0;
    let top: RssArticle | null = null;

    for (const a of articles) {
      const ageMs = now - new Date(a.publishedAt).getTime();
      if (ageMs < 0 || ageMs > 86_400_000) continue;
      count24h++;
      if (ageMs < 7_200_000) count2h++;
      if (!top) top = a;
    }

    return {
      count2h,
      count24h,
      topHeadline: top?.title    ?? null,
      topSource:   top?.source   ?? null,
      topLink:     top?.link     ?? null,
    };
  } catch {
    return empty;
  }
}

/** Cache age info for the client */
export function cacheInfo(): { fetchedAt: number | null; ageMinutes: number } {
  let oldest = Infinity;
  for (const v of cache.values()) {
    if (v.fetchedAt < oldest) oldest = v.fetchedAt;
  }
  if (!isFinite(oldest)) return { fetchedAt: null, ageMinutes: 0 };
  return {
    fetchedAt:  oldest,
    ageMinutes: Math.floor((Date.now() - oldest) / 60_000),
  };
}
