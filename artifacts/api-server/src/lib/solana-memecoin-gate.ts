/**
 * Solana memecoin eligibility — stop stables / wrapped majors / junk MC
 * at wallet-buy discovery. Only tokens that trade vs SOL or USDC (or are
 * still bonding with no Dex pairs yet) are tracked.
 */

import { logger } from "./logger";

const log = logger.child({ module: "solana-memecoin-gate" });

/** Native SOL (wSOL) and USDC — required quote side for listed pairs. */
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const ALLOWED_QUOTES = new Set([SOL_MINT, USDC_MINT]);

/** Hard mint denylist — never record buys / never Pro-call. */
export const SOLANA_BLOCKED_MINTS = new Set([
  // Native / stables / cash
  SOL_MINT,
  USDC_MINT,
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", // USDS
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
  // LSTs
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", // stSOL
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // jitoSOL
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", // bSOL
  "he1iusmfkpAdwvxLNGV8Y1iSbj4rAyfzmiUEqLdjoxc", // hSOL
  "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", // JupSOL
  // Wrapped majors / BTC / ETH
  "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", // cbBTC
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", // WBTC
  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E", // BTC (legacy)
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // WETH
  // World Liberty USD1 (and known clones) — not memecoins
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
  "6oQJwuAF4GjUfvRhGFYWbyXAPwf4zMQMhkxhHwmqveG5",
  "BSJUzBQfPe7snyjxJxAJG183yYhDtLUEi3c8LGW7DCVw",
  "AKuUqLaZ7raFP4HsoxgeDMNphihvcH7TpVZdKxVEi9o4",
  "GcFbNQg1sSy4nJGsBRJSqZvcfm7jH4bB2XVhA5SGtB8t",
  "HCLQMW6KCCZqNcxja5iXEpMY7MGAApiAoMoyvAeVo9p6",
]);

/** Symbols that must never enter discovery / Pro (case-insensitive). */
export const BLOCKED_SYMBOLS = new Set([
  "SOL", "WSOL", "USDC", "USDT", "USDS", "PYUSD", "USD1", "DAI", "UXD",
  "CBBTC", "WBTC", "BTC", "TBTC", "WETH", "ETH", "STETH",
  "MSOL", "STSOL", "JITOSOL", "BSOL", "HSOL", "JUPSOL", "INF",
]);

/** Discovery MC ceiling — majors / stables sit way above this. */
export const MAX_DISCOVERY_MC_USD = 2_000_000;
/** Absolute absurd MC — treat as bad data (cbBTC-class). */
export const MAX_ABSURD_MC_USD = 50_000_000;
/** Pro surface entry MC cap (sweet spot was $5–15K). */
export const MAX_PRO_ENTRY_MC_USD = 40_000;
/** Pro min liquidity when known. */
export const MIN_PRO_LIQ_USD = 8_000;

export type MemecoinGateResult = {
  ok: boolean;
  reason?: string;
  symbol?: string | null;
  marketCapUsd?: number | null;
  quoteOk?: boolean;
};

type DexPair = {
  chainId?: string;
  dexId?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string };
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
};

const eligibilityCache = new Map<string, { expires: number; result: MemecoinGateResult }>();

export function normalizeSymbol(sym: string | null | undefined): string {
  return (sym ?? "").trim().toUpperCase().replace(/^\$/, "");
}

export function isBlockedMint(mint: string): boolean {
  return SOLANA_BLOCKED_MINTS.has(mint.trim());
}

export function isBlockedSymbol(sym: string | null | undefined): boolean {
  const s = normalizeSymbol(sym);
  if (!s) return false;
  if (BLOCKED_SYMBOLS.has(s)) return true;
  // USD1 / USDx stables pattern (not meme tickers like "BASEDUSD")
  if (/^USD[A-Z0-9]{0,2}$/.test(s) && s !== "USD") return true;
  return false;
}

export function isAbsurdMarketCap(mc: number | null | undefined): boolean {
  if (mc == null || !Number.isFinite(mc)) return false;
  return mc > MAX_ABSURD_MC_USD;
}

export function evaluateDexPairs(
  mint: string,
  pairs: DexPair[] | null | undefined,
): MemecoinGateResult {
  if (isBlockedMint(mint)) {
    return { ok: false, reason: "blocked_mint" };
  }

  const solPairs = (pairs ?? []).filter(p => (p.chainId ?? "") === "solana");
  if (solPairs.length === 0) {
    // Bonding / not listed yet — allow; metadata will re-check after list
    return { ok: true, reason: "no_pairs_bonding", quoteOk: false };
  }

  const quoteOkPairs = solPairs.filter(p => {
    const q = (p.quoteToken?.address ?? "").trim();
    return ALLOWED_QUOTES.has(q);
  });
  if (quoteOkPairs.length === 0) {
    return { ok: false, reason: "no_sol_usdc_pair", quoteOk: false };
  }

  // Prefer highest-liq SOL/USDC pair for MC/symbol
  const best = [...quoteOkPairs].sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
  )[0];
  const symbol = best.baseToken?.symbol ?? null;
  if (isBlockedSymbol(symbol)) {
    return { ok: false, reason: `blocked_symbol:${normalizeSymbol(symbol)}`, symbol };
  }
  // Base mint should match (avoid quote-as-base misreads)
  const base = (best.baseToken?.address ?? "").trim();
  if (base && base !== mint && isBlockedMint(base)) {
    return { ok: false, reason: "base_is_blocked_mint", symbol };
  }

  const mc = best.marketCap ?? best.fdv ?? null;
  if (mc != null && mc > MAX_DISCOVERY_MC_USD) {
    return {
      ok: false,
      reason: `mc_too_high:${Math.round(mc)}`,
      symbol,
      marketCapUsd: mc,
      quoteOk: true,
    };
  }
  if (isAbsurdMarketCap(mc)) {
    return { ok: false, reason: "absurd_mc", symbol, marketCapUsd: mc, quoteOk: true };
  }

  return {
    ok: true,
    reason: "sol_usdc_pair",
    symbol,
    marketCapUsd: mc,
    quoteOk: true,
  };
}

/**
 * Live DexScreener check (short timeout). Cached ~30m per mint.
 * Fail-open only when Dex is unreachable AND mint is not blocked.
 */
export async function checkSolanaMemecoinBuy(mint: string): Promise<MemecoinGateResult> {
  const key = mint.trim();
  if (isBlockedMint(key)) return { ok: false, reason: "blocked_mint" };

  const hit = eligibilityCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.result;

  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${key}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!resp.ok) {
      const result: MemecoinGateResult = { ok: true, reason: `dex_http_${resp.status}_allow` };
      eligibilityCache.set(key, { expires: Date.now() + 5 * 60_000, result });
      return result;
    }
    const json = await resp.json() as { pairs?: DexPair[] };
    const result = evaluateDexPairs(key, json.pairs);
    eligibilityCache.set(key, { expires: Date.now() + 30 * 60_000, result });
    if (!result.ok) {
      log.info({ mint: key.slice(0, 8), reason: result.reason, symbol: result.symbol }, "Memecoin gate rejected buy");
    }
    return result;
  } catch (err) {
    log.debug({ err, mint: key.slice(0, 8) }, "Dex gate check failed — allow once");
    const result: MemecoinGateResult = { ok: true, reason: "dex_error_allow" };
    eligibilityCache.set(key, { expires: Date.now() + 2 * 60_000, result });
    return result;
  }
}

/** Used by Pro qualify / quarantine — symbol + MC sanity without network. */
export function isProBannedToken(opts: {
  address?: string | null;
  symbol?: string | null;
  calledMcUsd?: number | null;
  currentMcUsd?: number | null;
}): { banned: boolean; reason?: string } {
  if (opts.address && isBlockedMint(opts.address)) {
    return { banned: true, reason: "blocked_mint" };
  }
  if (isBlockedSymbol(opts.symbol)) {
    return { banned: true, reason: `blocked_symbol:${normalizeSymbol(opts.symbol)}` };
  }
  const mc = opts.calledMcUsd ?? opts.currentMcUsd ?? null;
  if (isAbsurdMarketCap(mc)) {
    return { banned: true, reason: "absurd_mc" };
  }
  if (mc != null && mc > MAX_DISCOVERY_MC_USD) {
    return { banned: true, reason: "mc_too_high" };
  }
  return { banned: false };
}
