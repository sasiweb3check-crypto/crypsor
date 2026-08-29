/**
 * Solana fund-tape: newest pump coins + light first-page trades + Helius native in.
 * Does not admit tokens. Skips tracked desk wallets.
 */
import { logger } from "../core/log";
import { heliusKey } from "../core/settings";
import {
  draftFromNativeIn, draftFromPumpTrade, pickCrawlCoins, skipWallet, FUNDER_CAP,
  type IntelDraft,
} from "../scoring/intel";
import { newestCoins, firstTrades } from "./pumpfun";
import { pace } from "./pace";

type NativeXfer = { fromUserAccount?: string; toUserAccount?: string; amount?: number };
type HeliusLite = {
  signature?: string;
  timestamp?: number;
  nativeTransfers?: NativeXfer[];
};

async function nativeInDrafts(wallet: string, solUsd: number | null): Promise<IntelDraft[]> {
  const key = await heliusKey();
  if (!key) return [];
  try {
    await pace("helius", 250);
    const resp = await fetch(
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${key}&limit=25`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000) },
    );
    if (!resp.ok) return [];
    const txs = await resp.json() as HeliusLite[];
    const out: IntelDraft[] = [];
    for (const tx of Array.isArray(txs) ? txs : []) {
      if (!tx.signature || !tx.timestamp) continue;
      for (const n of tx.nativeTransfers ?? []) {
        if (n.toUserAccount !== wallet) continue;
        const d = draftFromNativeIn({
          signature: tx.signature,
          timestamp: tx.timestamp,
          from: n.fromUserAccount,
          to: n.toUserAccount,
          lamports: Number(n.amount),
        }, solUsd);
        if (d) out.push(d);
      }
    }
    return out;
  } catch (err) {
    logger.debug({ err, wallet: wallet.slice(0, 8) }, "intel helius native failed");
    return [];
  }
}

export async function collectSolDrafts(tracked: Set<string>, solUsd: number | null): Promise<IntelDraft[]> {
  const coins = await newestCoins(50);
  const crawl = pickCrawlCoins(coins);
  const out: IntelDraft[] = [];
  const buyWallets: string[] = [];

  for (const c of crawl) {
    await pace("pump-trades", 400);
    const trades = await firstTrades(c.mint, 200);
    for (const t of trades) {
      const d = draftFromPumpTrade(t, { mint: c.mint, symbol: c.symbol, name: c.name }, solUsd);
      if (!d || skipWallet(d.wallet, tracked)) continue;
      out.push(d);
      if (d.kind === "buy" && !buyWallets.includes(d.wallet)) buyWallets.push(d.wallet);
    }
  }

  for (const w of buyWallets.slice(0, FUNDER_CAP)) {
    if (skipWallet(w, tracked)) continue;
    const funds = await nativeInDrafts(w, solUsd);
    for (const d of funds) {
      if (skipWallet(d.wallet, tracked) || skipWallet(d.counterparty ?? "", tracked)) continue;
      out.push(d);
    }
  }

  return out;
}
