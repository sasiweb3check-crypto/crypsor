/**
 * Robinhood Chain blocks + Dex rumor-name search (solana + robinhood).
 * Age-capped so old official TRUMP/MELANIA pairs are not logged as new deploys.
 */
import { logger } from "../core/log";
import {
  draftFromDexPair, draftFromRhTx, skipWallet,
  type DexPairLike, type IntelDraft, type RhRpcTx,
} from "../scoring/intel";
import { pace } from "./pace";
import type { DexPair } from "./pair-stats";

export const RH_RPC = "https://rpc.mainnet.chain.robinhood.com";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const SEARCH = ["trump", "wlfi", "melania"] as const;
const BLOCKS = 5;

type RpcBlock = {
  timestamp?: string;
  transactions?: RhRpcTx[];
};

async function rhRpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    await pace("rh-rpc", 200);
    const resp = await fetch(RH_RPC, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) return null;
    const json = await resp.json() as { result?: T };
    return json.result ?? null;
  } catch (err) {
    logger.debug({ err, method }, "rh rpc failed");
    return null;
  }
}

export async function ethUsdSpot(): Promise<number | null> {
  try {
    await pace("dex", 350);
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${WETH}`, {
      headers: { Accept: "application/json", "user-agent": "crypsor/moves" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const json = await resp.json() as { pairs?: DexPair[] };
    let best: DexPair | null = null;
    for (const p of json.pairs ?? []) {
      if ((p.chainId || "").toLowerCase() !== "ethereum") continue;
      if (!best || (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
    }
    const n = Number(best?.priceUsd);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function collectRhBlockDrafts(tracked: Set<string>, ethUsd: number | null): Promise<IntelDraft[]> {
  const hex = await rhRpc<string>("eth_blockNumber", []);
  const latest = hex ? Number.parseInt(hex, 16) : NaN;
  if (!Number.isFinite(latest)) return [];
  const out: IntelDraft[] = [];
  for (let i = 0; i < BLOCKS; i++) {
    const n = latest - i;
    const block = await rhRpc<RpcBlock>("eth_getBlockByNumber", [`0x${n.toString(16)}`, true]);
    if (!block) continue;
    const ts = Number.parseInt(String(block.timestamp ?? "0"), 16);
    const at = Number.isFinite(ts) && ts > 0 ? ts * 1000 : Date.now();
    for (const tx of block.transactions ?? []) {
      const d = draftFromRhTx(tx, { at, ethUsd });
      if (!d || skipWallet(d.wallet, tracked)) continue;
      if (d.counterparty && skipWallet(d.counterparty, tracked)) continue;
      out.push(d);
    }
  }
  return out;
}

async function searchDex(q: string): Promise<DexPairLike[]> {
  try {
    await pace("dex", 350);
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, {
      headers: { Accept: "application/json", "user-agent": "crypsor/moves" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return [];
    const json = await resp.json() as { pairs?: DexPairLike[] };
    return Array.isArray(json.pairs) ? json.pairs : [];
  } catch (err) {
    logger.debug({ err, q }, "dex rumor search failed");
    return [];
  }
}

export async function collectDexRumorDrafts(now = Date.now()): Promise<IntelDraft[]> {
  const seen = new Set<string>();
  const out: IntelDraft[] = [];
  for (const q of SEARCH) {
    const pairs = await searchDex(q);
    for (const p of pairs) {
      const d = draftFromDexPair(p, now);
      if (!d) continue;
      const k = `${d.chain}:${d.tx}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(d);
    }
  }
  return out;
}
