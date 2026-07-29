/**
 * socials.ts
 *
 * Extracts social links (Twitter/X, Telegram, website) from the DexScreener-
 * shaped `raw_metadata` blob stored per token. This is the only socials
 * source in the pipeline today — there is no dedicated GMGN socials
 * endpoint, and no discrete DB columns, so this stays a derive-on-read helper
 * used by both the caller routes (display) and caller alerts (Telegram links).
 */

export interface Socials {
  twitter?: string;
  telegram?: string;
  website?: string;
}

export function extractSocials(rawMetadata: unknown): Socials {
  if (!rawMetadata || typeof rawMetadata !== "object") return {};
  const meta = rawMetadata as Record<string, unknown>;
  const pairs = Array.isArray(meta.pairs) ? meta.pairs : [];
  const info = (pairs[0] as Record<string, unknown> | undefined)?.info;
  if (!info || typeof info !== "object") return {};
  const infoObj = info as Record<string, unknown>;
  const socials: Socials = {};

  for (const s of Array.isArray(infoObj.socials) ? infoObj.socials : []) {
    if (!s || typeof s !== "object") continue;
    const entry = s as Record<string, string>;
    if (entry.type === "twitter" && entry.url) socials.twitter = entry.url;
    if (entry.type === "telegram" && entry.url) socials.telegram = entry.url;
  }
  for (const w of Array.isArray(infoObj.websites) ? infoObj.websites : []) {
    if (w && typeof w === "object") {
      const url = (w as Record<string, string>).url;
      if (url) {
        socials.website = url;
        break;
      }
    }
  }
  return socials;
}
