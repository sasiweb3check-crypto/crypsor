/**
 * Free tape for wallet scout: DAS holders, pump.fun trades, Helius pool txs, Gecko OHLCV.
 * Gecko public trades are 24h-only and used as a supplement, not the full history.
 */
import { logger } from "../core/log";
import { heliusKey } from "../core/settings";
import {
  attachMc, fillsFromHeliusTx, interpolateMc, pumpMcFromReserves, usdFromMc,
  type HeliusLikeTx, type TokenFill,
} from "../scoring/scout-fills";
import { pace } from "./pace";
import type { ScoutToken } from "./scout-meta";

export const SKIP_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xHH19mCeKjM79LHU",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
]);

export type HolderBal = { owner: string; amount: number };

export type ScoutProgressFn = (phase: string, detail: string, n?: number, of?: number) => void;

type DasAccounts = {
  result?: {
    total?: number;
    token_accounts?: Array<{ owner?: string; amount?: string | number }>;
  };
};

async function heliusRpc<T>(body: unknown): Promise<T | null> {
  const key = await heliusKey();
  if (!key) return null;
  try {
    await pace("helius-holders", 80);
    const resp = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) return null;
    return await resp.json() as T;
  } catch (err) {
    logger.debug({ err }, "scout helius rpc failed");
    return null;
  }
}

export function skipSet(token: ScoutToken): Set<string> {
  const s = new Set(SKIP_PROGRAMS);
  s.add(token.mint);
  if (token.pairAddress) s.add(token.pairAddress);
  if (token.bondingCurve) s.add(token.bondingCurve);
  return s;
}

export async function loadHolders(mint: string, decimals: number | null, on?: ScoutProgressFn): Promise<HolderBal[]> {
  const out: HolderBal[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 3; page++) {
    on?.("holders", `DAS holders page ${page}`, page, 3);
    const json = await heliusRpc<DasAccounts>({
      jsonrpc: "2.0",
      id: "holders",
      method: "getTokenAccounts",
      params: { mint, page, limit: 1000 },
    });
    const rows = json?.result?.token_accounts ?? [];
    if (!rows.length) break;
    for (const r of rows) {
      const owner = r.owner || "";
      if (!owner || seen.has(owner)) continue;
      let amt = Number(r.amount);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      if (decimals != null && amt > 1e6) amt = amt / (10 ** decimals);
      seen.add(owner);
      out.push({ owner, amount: amt });
    }
    if (rows.length < 1000) break;
  }
  return out;
}

type PumpTrade = {
  signature?: string;
  sol_amount?: number;
  token_amount?: number;
  is_buy?: boolean;
  user?: string;
  timestamp?: number;
  virtual_sol_reserves?: number;
  virtual_token_reserves?: number;
};

export async function loadPumpTrades(
  token: ScoutToken,
  on?: ScoutProgressFn,
): Promise<TokenFill[]> {
  const mint = token.mint;
  const fills: TokenFill[] = [];
  const skip = skipSet(token);
  for (let offset = 0; offset < 6_000; offset += 200) {
    on?.("pump", `pump.fun trades ${offset}`, offset, 6_000);
    try {
      await pace("pump-trades", 400);
      const resp = await fetch(
        `https://frontend-api-v3.pump.fun/trades/all/${encodeURIComponent(mint)}?limit=200&offset=${offset}`,
        {
          headers: {
            Accept: "application/json",
            Origin: "https://pump.fun",
            Referer: "https://pump.fun/",
            "User-Agent": "Mozilla/5.0 (compatible; Crypsor/scout)",
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!resp.ok) break;
      const rows = await resp.json() as PumpTrade[];
      if (!Array.isArray(rows) || !rows.length) break;
      for (const t of rows) {
        const wallet = t.user || "";
        if (!wallet || skip.has(wallet)) continue;
        let tokenAmt = Number(t.token_amount);
        if (!(tokenAmt > 0)) continue;
        if (token.decimals != null && token.supply != null && tokenAmt > token.supply * 10) {
          tokenAmt = tokenAmt / (10 ** token.decimals);
        }
        const sol = Number(t.sol_amount) / 1e9;
        const usd = sol > 0 && token.solUsd ? sol * token.solUsd : usdFromMc(tokenAmt, null, token.supply);
        const mc = pumpMcFromReserves(
          t.virtual_sol_reserves, t.virtual_token_reserves,
          token.decimals ?? 6, token.supply, token.solUsd,
        );
        const at = Number(t.timestamp);
        fills.push({
          wallet,
          side: t.is_buy ? "buy" : "sell",
          tokenAmt,
          usd: usd != null && usd > 0 ? usd : (sol > 0 && token.solUsd ? sol * token.solUsd : null),
          at: at > 1e12 ? at : at * 1000,
          sig: t.signature || `${wallet}:${at}`,
          mc,
          src: "pump",
        });
      }
      if (rows.length < 200) break;
    } catch (err) {
      logger.debug({ err, offset }, "pump trades page failed");
      break;
    }
  }
  return fills;
}

export async function loadPoolTxs(
  token: ScoutToken,
  address: string,
  on?: ScoutProgressFn,
): Promise<TokenFill[]> {
  const key = await heliusKey();
  if (!key || !address) return [];
  const skip = skipSet(token);
  skip.add(address);
  const fills: TokenFill[] = [];
  let before: string | undefined;
  for (let page = 0; page < 15; page++) {
    on?.("pool", `Helius ${address.slice(0, 6)}… page ${page + 1}`, page + 1, 15);
    try {
      await pace("helius-tx", 80);
      const q = new URL(`https://api.helius.xyz/v0/addresses/${address}/transactions`);
      q.searchParams.set("api-key", key);
      q.searchParams.set("limit", "100");
      if (before) q.searchParams.set("before", before);
      const resp = await fetch(q, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) break;
      const txs = await resp.json() as HeliusLikeTx[];
      if (!Array.isArray(txs) || !txs.length) break;
      for (const tx of txs) {
        fills.push(...fillsFromHeliusTx(tx, token.mint, { skip, solUsd: token.solUsd, src: "pool" }));
      }
      const last = txs[txs.length - 1]?.signature;
      if (!last || last === before) break;
      before = last;
      if (txs.length < 100) break;
    } catch (err) {
      logger.debug({ err, address: address.slice(0, 8) }, "pool txs failed");
      break;
    }
  }
  return fills;
}

type GeckoOhlcv = {
  data?: { attributes?: { ohlcv_list?: Array<[number, number, number, number, number, number]> } };
};

export async function loadOhlcv(pool: string): Promise<Array<{ t: number; close: number }>> {
  if (!pool) return [];
  try {
    await pace("gecko", 2_200);
    const resp = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=5&limit=1000&currency=usd`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000) },
    );
    if (!resp.ok) return [];
    const json = await resp.json() as GeckoOhlcv;
    const list = json.data?.attributes?.ohlcv_list ?? [];
    return list
      .map((row) => ({ t: Number(row[0]), close: Number(row[4]) }))
      .filter((c) => Number.isFinite(c.t) && c.close > 0);
  } catch (err) {
    logger.debug({ err }, "ohlcv failed");
    return [];
  }
}

type GeckoTrades = {
  data?: Array<{
    attributes?: {
      tx_hash?: string;
      tx_from_address?: string;
      kind?: string;
      from_token_amount?: string;
      to_token_amount?: string;
      volume_in_usd?: string;
      block_timestamp?: string;
    };
  }>;
};

/** Public Gecko trades are the last 24h only — merged by signature, never the full tape. */
export async function loadGeckoTrades(token: ScoutToken): Promise<TokenFill[]> {
  const pool = token.pairAddress;
  if (!pool) return [];
  try {
    await pace("gecko", 2_200);
    const resp = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/trades`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000) },
    );
    if (!resp.ok) return [];
    const json = await resp.json() as GeckoTrades;
    const skip = skipSet(token);
    const fills: TokenFill[] = [];
    for (const row of json.data ?? []) {
      const a = row.attributes ?? {};
      const wallet = a.tx_from_address || "";
      if (!wallet || skip.has(wallet)) continue;
      const buy = (a.kind || "").toLowerCase() === "buy";
      const tokenAmt = Number(buy ? a.to_token_amount : a.from_token_amount);
      const usd = Number(a.volume_in_usd);
      const at = Date.parse(a.block_timestamp || "");
      if (!(tokenAmt > 0) || !Number.isFinite(at)) continue;
      fills.push({
        wallet,
        side: buy ? "buy" : "sell",
        tokenAmt,
        usd: Number.isFinite(usd) && usd > 0 ? usd : null,
        at,
        sig: a.tx_hash || `${wallet}:${at}`,
        mc: null,
        src: "gecko24h",
      });
    }
    return fills;
  } catch (err) {
    logger.debug({ err }, "gecko trades failed");
    return [];
  }
}

export function stampMc(fills: TokenFill[], candles: Array<{ t: number; close: number }>, supply: number | null): TokenFill[] {
  return fills.map((f) => {
    if (f.mc != null && f.mc > 0) {
      const usd = f.usd ?? usdFromMc(f.tokenAmt, f.mc, supply);
      return usd != null && f.usd == null ? { ...f, usd } : f;
    }
    const mc = interpolateMc(f.at, candles, supply);
    const withMc = attachMc(f, mc);
    const usd = withMc.usd ?? usdFromMc(withMc.tokenAmt, withMc.mc, supply);
    return usd != null ? { ...withMc, usd } : withMc;
  });
}
