import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function truncateAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatUsd(price: number | string | null | undefined): string {
  if (price === null || price === undefined) return '—';
  const numPrice = typeof price === 'string' ? parseFloat(price) : price;
  if (isNaN(numPrice)) return '—';

  if (numPrice < 0.00001) {
    return `$${numPrice.toFixed(8)}`;
  } else if (numPrice < 0.01) {
    return `$${numPrice.toFixed(6)}`;
  } else if (numPrice < 1) {
    return `$${numPrice.toFixed(4)}`;
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(numPrice);
}

/** Compact USD: $1.2K / $500K / $1.2M / $3.4B — for invested amounts, market caps, etc. */
export function formatCompactUsd(val: number | string | null | undefined): string {
  if (val === null || val === undefined) return '—';
  const n = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(n) || n === 0) return '—';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
}

/** Format a market-cap / large dollar value as 1.2K / 500K / 1.2M / 3.4B (no $ — use formatCompactUsd for dollar values) */
export function formatMarketCap(val: number | string | null | undefined): string {
  if (val === null || val === undefined) return '—';
  const n = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(n) || n <= 0) return '—';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(1)}K`;
  return `${n.toFixed(0)}`;
}

/**
 * Format a token price smartly:
 * - Large values ($1K+) use K/M/B shorthand
 * - Sub-dollar values show enough decimal places to be meaningful
 * - Handles tiny meme coin prices like $0.000007
 */
export function formatTokenPrice(val: number | string | null | undefined): string {
  if (val === null || val === undefined) return '—';
  const n = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(n) || n < 0) return '—';
  if (n === 0) return '$0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(2)}K`;
  if (n >= 1)             return `${n.toFixed(2)}`;
  if (n >= 0.01)          return `${n.toFixed(4)}`;
  if (n >= 0.0001)        return `${n.toFixed(6)}`;
  if (n >= 0.000001)      return `${n.toFixed(8)}`;
  // Very tiny — strip trailing zeros for readability
  return `${n.toFixed(10).replace(/0+$/, '')}`;
}

export function formatDate(dateStr: string): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatGain(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return '—';
  const formatted = pct.toFixed(1);
  return pct > 0 ? `+${formatted}%` : `${formatted}%`;
}

export function formatTimeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo`;
  return `${Math.floor(diffMonth / 12)}y`;
}

// ── Token metadata safety helpers ────────────────────────────────────────────

/**
 * Resolve a token image URL with a 3-step fallback chain:
 *  1. Existing logoUri from DB/API
 *  2. Jupiter token list CDN
 *  3. ui-avatars placeholder (always succeeds)
 */
export function safeImageUrl(
  logoUri: string | null | undefined,
  address: string | null | undefined,
  symbol: string | null | undefined,
): string {
  if (logoUri) return logoUri;
  if (address) return `https://static.jup.ag/images/tokens/${address}.png`;
  const name = symbol || address?.slice(0, 4) || '?';
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=1a2030&color=f59e0b&size=64`;
}

/**
 * Safe symbol: falls back to truncated address rather than blank / crash.
 */
export function safeSymbol(
  symbol: string | null | undefined,
  address: string | null | undefined,
): string {
  return symbol || (address ? truncateAddress(address) : '?');
}

/**
 * Safe name: falls back to symbol then truncated address.
 */
export function safeName(
  name: string | null | undefined,
  symbol: string | null | undefined,
  address: string | null | undefined,
): string {
  return name || symbol || (address ? truncateAddress(address) : 'Unknown');
}

export function getGmgnUrl(chain: string, address: string): string {
  const chainMap: Record<string, string> = {
    solana: 'sol',
    eth: 'eth',
    base: 'base',
    bsc: 'bsc',
    polygon: 'polygon',
    arbitrum: 'arbitrum',
    avalanche: 'avax',
  };
  const gmgnChain = chainMap[chain.toLowerCase()] || 'sol';
  return `https://gmgn.ai/${gmgnChain}/token/${address}`;
}
