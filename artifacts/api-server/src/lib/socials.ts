/**
 * socials.ts
 *
 * Normalize social links from whatever we stored in raw_metadata:
 *   • DexScreener { pairs: [...] }
 *   • Raw pairs array (what metadata-service often writes)
 *   • Single pair object
 *   • GMGN token_link shape { twitter_username, website, telegram, ... }
 *   • Pump.fun coin { twitter, telegram, website }
 */

export interface Socials {
  twitter?: string;
  telegram?: string;
  website?: string;
}

function asTwitterUrl(v: string): string {
  const s = v.trim();
  if (!s) return s;
  if (s.startsWith("http")) return s;
  if (s.startsWith("@")) return `https://x.com/${s.slice(1)}`;
  if (s.startsWith("i/communities/")) return `https://x.com/${s}`;
  return `https://x.com/${s}`;
}

function asTelegramUrl(v: string): string {
  const s = v.trim();
  if (!s) return s;
  if (s.startsWith("http")) return s;
  return `https://t.me/${s.replace(/^@/, "")}`;
}

function fromDexInfo(info: Record<string, unknown> | null | undefined): Socials {
  if (!info || typeof info !== "object") return {};
  const socials: Socials = {};
  for (const s of Array.isArray(info.socials) ? info.socials : []) {
    if (!s || typeof s !== "object") continue;
    const entry = s as Record<string, string>;
    const type = (entry.type ?? "").toLowerCase();
    if ((type === "twitter" || type === "x") && entry.url) socials.twitter = entry.url;
    if (type === "telegram" && entry.url) socials.telegram = entry.url;
  }
  for (const w of Array.isArray(info.websites) ? info.websites : []) {
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

function fromFlat(obj: Record<string, unknown>): Socials {
  const socials: Socials = {};
  const tw =
    (typeof obj.twitter === "string" && obj.twitter) ||
    (typeof obj.twitter_username === "string" && obj.twitter_username) ||
    (typeof obj.twitterUrl === "string" && obj.twitterUrl) ||
    "";
  const tg =
    (typeof obj.telegram === "string" && obj.telegram) ||
    (typeof obj.telegramUrl === "string" && obj.telegramUrl) ||
    "";
  const web =
    (typeof obj.website === "string" && obj.website) ||
    (typeof obj.web === "string" && obj.web) ||
    "";
  if (tw) socials.twitter = asTwitterUrl(tw);
  if (tg) socials.telegram = asTelegramUrl(tg);
  if (web && web.startsWith("http")) socials.website = web;
  return socials;
}

function mergeSocials(...parts: Socials[]): Socials {
  const out: Socials = {};
  for (const p of parts) {
    if (p.twitter && !out.twitter) out.twitter = p.twitter;
    if (p.telegram && !out.telegram) out.telegram = p.telegram;
    if (p.website && !out.website) out.website = p.website;
  }
  return out;
}

export function extractSocials(rawMetadata: unknown): Socials {
  if (!rawMetadata) return {};

  // Dex pairs array stored directly
  if (Array.isArray(rawMetadata)) {
    const first = rawMetadata[0] as Record<string, unknown> | undefined;
    return fromDexInfo(first?.info as Record<string, unknown> | undefined);
  }

  if (typeof rawMetadata !== "object") return {};
  const meta = rawMetadata as Record<string, unknown>;

  // Wrapped Dex shape
  if (Array.isArray(meta.pairs)) {
    const first = meta.pairs[0] as Record<string, unknown> | undefined;
    return mergeSocials(
      fromDexInfo(first?.info as Record<string, unknown> | undefined),
      fromFlat(meta),
      meta.link && typeof meta.link === "object" ? fromFlat(meta.link as Record<string, unknown>) : {},
    );
  }

  // Single pair with info
  if (meta.info && typeof meta.info === "object") {
    return mergeSocials(fromDexInfo(meta.info as Record<string, unknown>), fromFlat(meta));
  }

  // GMGN link blob nested
  if (meta.link && typeof meta.link === "object") {
    return mergeSocials(fromFlat(meta.link as Record<string, unknown>), fromFlat(meta));
  }

  return fromFlat(meta);
}

/** True when at least one social channel is present. */
export function hasAnySocial(s: Socials): boolean {
  return Boolean(s.twitter || s.telegram || s.website);
}
