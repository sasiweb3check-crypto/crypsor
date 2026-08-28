/** Dex CDN thumb — always https, used when pump/Dex metadata has no image. */
export function dexTokenImage(mint: string | null | undefined): string | null {
  if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return null;
  return `https://dd.dexscreener.com/ds-data/tokens/solana/${mint}.png`;
}

export function tokenImageUrl(
  stored: string | null | undefined,
  mint?: string | null,
): string | null {
  return httpsImage(stored) ?? dexTokenImage(mint);
}

/** Make a remote image URL usable in the desk. */
export function httpsImage(url: string | null | undefined): string | null {
  if (!url) return null;
  let u = url.trim();
  if (!u) return null;
  if (u.startsWith("ipfs://")) u = `https://ipfs.io/ipfs/${u.slice(7).replace(/^ipfs\//, "")}`;
  if (u.startsWith("//")) u = `https:${u}`;
  if (u.startsWith("http://")) u = `https://${u.slice(7)}`;
  if (!/^https:\/\//i.test(u)) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function clip(text: string | null | undefined, n = 160): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}
