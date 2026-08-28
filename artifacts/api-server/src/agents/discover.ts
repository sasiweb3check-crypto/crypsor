/**
 * PUBLIC TAPE — DexScreener boosts/profiles, pump.fun movers, CoinGecko trending.
 *
 * Names land in a waiting room, then the scanner grades them.
 * They never auto-lock. A pass still requires a tracked-wallet buy.
 */
import { cacheBust } from "../core/cache";
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { isNoiseToken } from "../scoring/noise";
import { httpsImage } from "../scoring/image";
import { publicStory } from "../scoring/thesis";
import { latestBoosts, latestProfiles, profileSocials } from "../sources/dexscreener";
import { currentlyLive, moverCoins } from "../sources/pumpfun";
import { geckoTrending } from "../sources/coingecko";
import { pace } from "../sources/pace";
import { agentNote } from "./log";
import { emitLiveStats } from "./stats";

type Hit = {
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  source: string;
  mc: number | null;
  description: string | null;
  socials: string[];
  hasSite: boolean;
  replies: number | null;
  boosted: boolean;
  geckoUpPct: number | null;
};

const ADMIT_CAP = 6;
const PUBLIC_SOURCES = ["public_tape", "dex_boost", "pump_mover", "gecko"];

async function already(mint: string): Promise<boolean> {
  const r = await pool.query("SELECT 1 FROM f2_tokens WHERE mint = $1", [mint]);
  return r.rows.length > 0;
}

async function collect(): Promise<Hit[]> {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  const push = (h: Hit) => {
    if (!h.mint || seen.has(h.mint) || isNoiseToken(h.mint, h.symbol)) return;
    seen.add(h.mint);
    hits.push(h);
  };

  await pace("discover_dex", 1_200);
  try {
    const [boosts, profiles] = await Promise.all([latestBoosts(), latestProfiles()]);
    for (const p of [...boosts.slice(0, 8), ...profiles.slice(0, 6)]) {
      const mint = p.tokenAddress!;
      const socials = profileSocials(p);
      push({
        mint,
        symbol: null,
        name: null,
        image: httpsImage(p.icon),
        source: p.totalAmount ? "dex_boost" : "public_tape",
        mc: null,
        description: p.description ?? null,
        socials,
        hasSite: socials.some((s) => s.includes("web") || s.includes("site")),
        replies: null,
        boosted: Boolean(p.totalAmount || p.amount),
        geckoUpPct: null,
      });
    }
  } catch {
    // stay smooth
  }

  await pace("discover_pump", 1_200);
  try {
    const [live, movers] = await Promise.all([currentlyLive(10), moverCoins(10)]);
    for (const c of [...live, ...movers]) {
      if (c.nsfw) continue;
      push({
        mint: c.mint,
        symbol: c.symbol ?? null,
        name: c.name ?? null,
        image: httpsImage(c.image_uri),
        source: "pump_mover",
        mc: c.usd_market_cap ?? c.market_cap_usd ?? null,
        description: null,
        socials: [c.twitter ? "twitter" : "", c.telegram ? "telegram" : "", c.website ? "website" : ""].filter(Boolean),
        hasSite: Boolean(c.website),
        replies: c.reply_count ?? null,
        boosted: false,
        geckoUpPct: null,
      });
    }
  } catch {
    // stay smooth
  }

  await pace("discover_gecko", 2_000);
  try {
    for (const g of await geckoTrending(5)) {
      push({
        mint: g.mint!,
        symbol: g.symbol,
        name: g.name,
        image: g.image,
        source: "gecko",
        mc: null,
        description: null,
        socials: [],
        hasSite: false,
        replies: null,
        boosted: false,
        geckoUpPct: g.geckoUpPct,
      });
    }
  } catch {
    // stay smooth
  }

  return hits;
}

async function admit(h: Hit): Promise<boolean> {
  if (await already(h.mint)) {
    if (h.image) {
      await pool.query(
        `UPDATE f2_tokens SET image = COALESCE(image, $2) WHERE mint = $1 AND (image IS NULL OR image = '')`,
        [h.mint, h.image],
      );
    }
    return false;
  }
  if (h.mc != null && h.mc > 0 && h.mc < 8_000) return false;
  const story = publicStory({
    description: h.description,
    socials: h.socials,
    hasSite: h.hasSite,
    replies: h.replies,
    boosted: h.boosted,
    geckoUpPct: h.geckoUpPct,
    source: h.source,
  });
  await pool.query(
    `INSERT INTO f2_tokens (
       mint, symbol, name, image, source, stage, phase, wallet_buys,
       admission_mc, last_mc, peak_mc, mc_at_discovery, last_narrative, last_suggestion, meta
     ) VALUES (
       $1,$2,$3,$4,$5,'tracking','intake',0,$6,$6,$6,$6,$7,$8,$9
     ) ON CONFLICT (mint) DO NOTHING`,
    [
      h.mint, h.symbol, h.name, h.image, h.source,
      h.mc, story.thesis, story.sentiment,
      JSON.stringify({
        public: true, source: h.source, socials: story.socials,
        sentiment: story.sentiment, boosted: h.boosted, geckoUpPct: h.geckoUpPct,
      }),
    ],
  );
  return true;
}

export async function discoverTick(): Promise<{ seen: number; admitted: number; waiting: number }> {
  const hits = await collect();
  let admitted = 0;
  for (const h of hits) {
    if (admitted >= ADMIT_CAP) break;
    try {
      if (await admit(h)) admitted += 1;
    } catch {
      // keep the loop moving
    }
  }
  const wait = await pool.query(
    `SELECT COUNT(*)::int AS n FROM f2_tokens
     WHERE source = ANY($1::text[]) AND last_scan_at IS NULL
       AND COALESCE(phase,'intake') <> 'deceased'`,
    [PUBLIC_SOURCES],
  );
  const waiting = Number(wait.rows[0]?.n ?? 0);
  if (admitted) {
    cacheBust();
    await agentNote("discover", "ADMIT", `public tape +${admitted} waiting ${waiting}`, { quiet: true });
  }
  emitSse("discover:tick", { admitted, waiting, seen: hits.length });
  if (admitted) await emitLiveStats();
  return { seen: hits.length, admitted, waiting };
}
