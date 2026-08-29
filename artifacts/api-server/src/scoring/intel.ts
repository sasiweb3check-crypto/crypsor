/**
 * Fund-tape observations. Not a desk gate — tracked-wallet buys stay on intake.
 * Rumor-name hits are tags, not confirmation of an official launch.
 */
export type IntelChain = "sol" | "robinhood";
export type IntelKind = "fund" | "buy" | "sell" | "deploy";

export type IntelDraft = {
  chain: IntelChain;
  kind: IntelKind;
  at: number;
  wallet: string;
  counterparty: string | null;
  mint: string | null;
  symbol: string | null;
  name: string | null;
  usd: number | null;
  nativeAmt: number | null;
  tx: string;
  rumor: string | null;
  tags: string[];
  detail: string;
  extra?: Record<string, unknown>;
};

/** Names/tickers people are using for the Trump-coin rumor. Not an official list. */
export const RUMOR_TERMS = [
  "trump", "melania", "wlfi", "djt", "maga", "potus", "whitehouse",
  "officialtrump", "truth", "47coin", "$47",
] as const;

export const FUND_MIN_USD = 15_000;
export const BUY_MIN_USD = 2_000;
export const RUMOR_BUY_MIN_USD = 200;
export const RH_FUND_ETH = 5;
export const DEX_MAX_AGE_MS = 24 * 3_600_000;

export function rumorHit(...parts: Array<string | null | undefined>): string | null {
  const blob = parts.filter(Boolean).join(" ").toLowerCase();
  if (!blob.trim()) return null;
  for (const t of RUMOR_TERMS) {
    if (blob.includes(t)) return t;
  }
  return null;
}

export function intelKey(e: Pick<IntelDraft, "chain" | "tx" | "kind" | "wallet">): string {
  return `${e.chain}:${e.tx}:${e.kind}:${e.wallet}`;
}

export function buyFloorUsd(rumor: string | null): number {
  return rumor ? RUMOR_BUY_MIN_USD : BUY_MIN_USD;
}

export function passesBuyUsd(usd: number | null | undefined, rumor: string | null): boolean {
  const n = Number(usd);
  return Number.isFinite(n) && n >= buyFloorUsd(rumor);
}

export function passesFundUsd(usd: number | null | undefined): boolean {
  const n = Number(usd);
  return Number.isFinite(n) && n >= FUND_MIN_USD;
}

export function weiToEth(hex: string | null | undefined): number | null {
  if (!hex || hex === "0x" || hex === "0x0") return null;
  try {
    const wei = BigInt(hex);
    if (wei <= 0n) return null;
    return Number(wei / 10n ** 15n) / 1_000;
  } catch {
    return null;
  }
}

export type RhRpcTx = {
  hash?: string;
  from?: string;
  to?: string | null;
  value?: string;
  input?: string;
};

export function draftFromRhTx(
  tx: RhRpcTx,
  opts: { at: number; ethUsd: number | null },
): IntelDraft | null {
  const hash = (tx.hash || "").trim();
  const from = (tx.from || "").trim();
  if (!hash || !from) return null;
  const to = tx.to ? String(tx.to).trim() : "";
  const input = (tx.input || "").trim();
  const eth = weiToEth(tx.value);
  const usd = eth != null && opts.ethUsd != null ? eth * opts.ethUsd : null;
  const created = !to && input.length > 10;
  if (created) {
    return {
      chain: "robinhood",
      kind: "deploy",
      at: opts.at,
      wallet: from,
      counterparty: null,
      mint: null,
      symbol: null,
      name: null,
      usd,
      nativeAmt: eth,
      tx: hash,
      rumor: null,
      tags: ["deploy"],
      detail: "Contract create on Robinhood Chain.",
    };
  }
  if (eth == null || eth < RH_FUND_ETH || !to) return null;
  return {
    chain: "robinhood",
    kind: "fund",
    at: opts.at,
    wallet: to,
    counterparty: from,
    mint: null,
    symbol: "ETH",
    name: "Ether",
    usd,
    nativeAmt: eth,
    tx: hash,
    rumor: null,
    tags: usd != null && usd >= FUND_MIN_USD ? ["large"] : ["eth"],
    detail: `ETH ${eth.toFixed(2)} moved on Robinhood Chain.`,
  };
}

export type PumpTradeLike = {
  signature?: string;
  is_buy?: boolean;
  user?: string;
  timestamp?: number;
  sol_amount?: number;
  token_amount?: number;
};

export function draftFromPumpTrade(
  t: PumpTradeLike,
  coin: { mint: string; symbol?: string | null; name?: string | null },
  solUsd: number | null,
): IntelDraft | null {
  const wallet = t.user || "";
  const sig = t.signature || "";
  if (!wallet || !sig) return null;
  const sol = Number(t.sol_amount) / 1e9;
  const usd = sol > 0 && solUsd != null ? sol * solUsd : null;
  const rumor = rumorHit(coin.name, coin.symbol);
  const buy = Boolean(t.is_buy);
  if (!passesBuyUsd(usd, rumor)) return null;
  const at = Number(t.timestamp);
  return {
    chain: "sol",
    kind: buy ? "buy" : "sell",
    at: at > 1e12 ? at : at * 1000,
    wallet,
    counterparty: null,
    mint: coin.mint,
    symbol: coin.symbol ?? null,
    name: coin.name ?? null,
    usd,
    nativeAmt: sol > 0 ? sol : null,
    tx: sig,
    rumor,
    tags: [buy ? "buy" : "sell", ...(rumor ? ["rumor"] : []), ...(usd != null && usd >= BUY_MIN_USD ? ["large"] : [])],
    detail: buy
      ? `Memecoin buy${rumor ? ` · name hit “${rumor}”` : ""}.`
      : `Memecoin sell${rumor ? ` · name hit “${rumor}”` : ""}.`,
  };
}

export function skipWallet(wallet: string, tracked: Set<string>): boolean {
  return !wallet || tracked.has(wallet);
}

export const CRAWL_MC_MIN = 8_000;
export const CRAWL_AGE_MS = 10 * 60_000;
export const TRADE_COIN_CAP = 15;
export const FUNDER_CAP = 6;

export type PumpCoinLike = {
  mint: string;
  name?: string | null;
  symbol?: string | null;
  usd_market_cap?: number | null;
  market_cap_usd?: number | null;
  created_timestamp?: number | null;
  nsfw?: boolean;
  is_banned?: boolean;
};

export function pumpCreatedMs(ts: number | null | undefined): number | null {
  const at = Number(ts);
  if (!Number.isFinite(at) || at <= 0) return null;
  return at < 1e12 ? at * 1000 : at;
}

export function coinWorthCrawl(coin: PumpCoinLike, now = Date.now()): boolean {
  if (rumorHit(coin.name, coin.symbol)) return true;
  const mc = Number(coin.usd_market_cap ?? coin.market_cap_usd ?? 0);
  if (Number.isFinite(mc) && mc >= CRAWL_MC_MIN) return true;
  const created = pumpCreatedMs(coin.created_timestamp);
  return created != null && now - created <= CRAWL_AGE_MS;
}

const NOISE_SYMBOLS = new Set([
  "SOL", "WSOL", "BTC", "WBTC", "ETH", "WETH", "USDC", "USDT", "PYUSD",
]);

function noisySymbol(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return NOISE_SYMBOLS.has(symbol.replace(/^\$/, "").trim().toUpperCase());
}

export function pickCrawlCoins<T extends PumpCoinLike>(coins: T[], now = Date.now(), cap = TRADE_COIN_CAP): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const c of coins) {
    if (!c.mint || seen.has(c.mint)) continue;
    if (c.nsfw || c.is_banned) continue;
    if (noisySymbol(c.symbol)) continue;
    if (!coinWorthCrawl(c, now)) continue;
    seen.add(c.mint);
    out.push(c);
    if (out.length >= cap) break;
  }
  return out;
}

export type NativeInLike = {
  signature?: string;
  timestamp?: number;
  from?: string;
  to?: string;
  lamports?: number;
};

export function draftFromNativeIn(t: NativeInLike, solUsd: number | null): IntelDraft | null {
  const wallet = t.to || "";
  const from = t.from || "";
  const sig = t.signature || "";
  if (!wallet || !from || !sig || from === wallet) return null;
  const sol = Number(t.lamports) / 1e9;
  if (!(sol > 0)) return null;
  const usd = solUsd != null ? sol * solUsd : null;
  if (!passesFundUsd(usd)) return null;
  const at = Number(t.timestamp);
  return {
    chain: "sol",
    kind: "fund",
    at: at > 1e12 ? at : at * 1000,
    wallet,
    counterparty: from,
    mint: null,
    symbol: "SOL",
    name: "Solana",
    usd,
    nativeAmt: sol,
    tx: sig,
    rumor: null,
    tags: ["large", "fund"],
    detail: `SOL ${sol.toFixed(2)} inbound — who funded this wallet.`,
  };
}

export type DexPairLike = {
  chainId?: string;
  pairAddress?: string;
  pairCreatedAt?: number;
  marketCap?: number;
  fdv?: number;
  url?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
};

export function dexChain(chainId?: string | null): IntelChain | null {
  const c = (chainId || "").toLowerCase();
  if (c === "solana") return "sol";
  if (c === "robinhood") return "robinhood";
  return null;
}

export function draftFromDexPair(pair: DexPairLike, now = Date.now()): IntelDraft | null {
  const chain = dexChain(pair.chainId);
  if (!chain) return null;
  const created = Number(pair.pairCreatedAt);
  if (!Number.isFinite(created) || created <= 0) return null;
  if (now - created > DEX_MAX_AGE_MS) return null;
  const rumor = rumorHit(pair.baseToken?.name, pair.baseToken?.symbol);
  if (!rumor) return null;
  const mint = (pair.baseToken?.address || "").trim();
  const pairAddr = (pair.pairAddress || "").trim();
  if (!mint || !pairAddr) return null;
  if (noisySymbol(pair.baseToken?.symbol)) return null;
  const mc = Number(pair.marketCap ?? pair.fdv ?? 0);
  return {
    chain,
    kind: "deploy",
    at: created,
    wallet: pairAddr,
    counterparty: null,
    mint,
    symbol: pair.baseToken?.symbol ?? null,
    name: pair.baseToken?.name ?? null,
    usd: Number.isFinite(mc) && mc > 0 ? mc : null,
    nativeAmt: null,
    tx: `pair:${pairAddr}`,
    rumor,
    tags: ["rumor", "dex", "young"],
    extra: pair.url ? { url: pair.url } : undefined,
    detail: `Young Dex pair name hit “${rumor}” — rumor tag, not an official launch.`,
  };
}

export function isSolanaAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}
