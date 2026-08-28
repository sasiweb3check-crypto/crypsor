/**
 * Public thesis + social read from Dex / pump.fun / CoinGecko copy.
 * Research context for a suggestion — not a lock.
 */
export type Sentiment = "hot" | "mixed" | "quiet";

export type PublicStoryIn = {
  description?: string | null;
  socials?: string[];
  hasSite?: boolean;
  replies?: number | null;
  boosted?: boolean;
  geckoUpPct?: number | null;
  source?: string | null;
};

export type PublicStory = {
  thesis: string;
  sentiment: Sentiment;
  socials: string[];
};

export function publicStory(i: PublicStoryIn): PublicStory {
  const socials = [...new Set((i.socials ?? []).map((s) => s.toLowerCase()).filter(Boolean))].slice(0, 5);
  const replies = i.replies ?? 0;
  const gecko = i.geckoUpPct;
  let sentiment: Sentiment = "quiet";
  if (i.boosted || replies >= 80 || (gecko != null && gecko >= 70)) sentiment = "hot";
  else if (socials.length >= 2 || replies >= 15 || (gecko != null && gecko >= 55)) sentiment = "mixed";

  const bits: string[] = [];
  const desc = (i.description ?? "").replace(/\s+/g, " ").trim();
  if (desc) bits.push(desc.length > 220 ? `${desc.slice(0, 219)}…` : desc);
  if (socials.length) bits.push(`Public socials: ${socials.join(", ")}.`);
  else bits.push("No public socials on this print.");
  if (i.hasSite) bits.push("Has a site.");
  if (i.boosted) bits.push("DexScreener boost is on — treat that as paid attention, not proof.");
  if (replies >= 15) bits.push(`pump.fun thread has ${replies} replies.`);
  if (gecko != null) bits.push(`CoinGecko up-votes ${Math.round(gecko)}%.`);
  bits.push("Scanner still has to clear it. This is not an entry by itself.");

  return { thesis: bits.join(" "), sentiment, socials };
}
