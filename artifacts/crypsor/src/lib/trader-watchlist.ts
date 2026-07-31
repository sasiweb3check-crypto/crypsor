/**
 * Dex watchlist — tokens he keeps commenting on (not auto-trade).
 */

export type WatchedToken = {
  tokenId: number;
  address: string;
  symbol: string;
  addedAt: string;
};

const KEY = "crypsor:dex-watchlist:v1";

export function loadWatchlist(): WatchedToken[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WatchedToken[];
    return Array.isArray(parsed) ? parsed.slice(0, 24) : [];
  } catch {
    return [];
  }
}

export function saveWatchlist(list: WatchedToken[]): void {
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 24)));
}

export function toggleWatch(
  list: WatchedToken[],
  token: { tokenId: number; address: string; symbol: string },
): WatchedToken[] {
  const exists = list.some(w => w.tokenId === token.tokenId);
  const next = exists
    ? list.filter(w => w.tokenId !== token.tokenId)
    : [{ ...token, addedAt: new Date().toISOString() }, ...list];
  saveWatchlist(next);
  return next;
}

export function isWatched(list: WatchedToken[], tokenId: number): boolean {
  return list.some(w => w.tokenId === tokenId);
}
