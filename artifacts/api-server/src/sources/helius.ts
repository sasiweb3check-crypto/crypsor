/**
 * Helius — tracked-wallet buy detection (the human alpha source).
 * Enhanced transactions API: /v0/addresses/:wallet/transactions
 *
 * A transfer into the wallet is not a buy. Helius often labels airdrops
 * and ATA creates as SWAP. We require quote/SOL spend above dust.
 */
import { logger } from "../core/log";
import { heliusKey } from "../core/settings";
import { isNoiseMint, isQuoteMint } from "../scoring/noise";
import { isWalletSwapBuy, MIN_SOL_SPEND_LAMPORTS, type SwapTx } from "../scoring/swap-buy";

export { isWalletSwapBuy, MIN_SOL_SPEND_LAMPORTS };

export type HeliusTx = SwapTx & {
  signature?: string;
  timestamp?: number;
  type?: string;
};

export type WalletBuy = { wallet: string; mint: string; ts: number; sig: string; swap: boolean };

/** @deprecated use isWalletSwapBuy */
export const looksLikeSwap = isWalletSwapBuy;

function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Fetch parsed txs by signature. Empty map on missing key / HTTP errors — caller must not treat that as "not a buy". */
export async function txsBySigs(sigs: string[]): Promise<Map<string, HeliusTx>> {
  const key = await heliusKey();
  const uniq = [...new Set(sigs.filter(Boolean))];
  const out = new Map<string, HeliusTx>();
  if (!key || !uniq.length) return out;
  for (const chunk of chunks(uniq, 20)) {
    try {
      const resp = await fetch(
        `https://api.helius.xyz/v0/transactions?api-key=${key}`,
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ transactions: chunk }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!resp.ok) {
        logger.debug({ status: resp.status, n: chunk.length }, "helius txs-by-sig http error");
        continue;
      }
      const txs = await resp.json() as HeliusTx[];
      for (const tx of Array.isArray(txs) ? txs : []) {
        if (tx?.signature) out.set(tx.signature, tx);
      }
    } catch (err) {
      logger.debug({ err, n: chunk.length }, "helius txs-by-sig failed");
    }
  }
  return out;
}

/** Detect recent memecoin buys for one wallet (last `limit` txs). */
export async function recentBuys(wallet: string, limit = 25): Promise<WalletBuy[]> {
  const key = await heliusKey();
  if (!key) return [];
  try {
    const resp = await fetch(
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${key}&limit=${limit}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
    );
    if (!resp.ok) {
      logger.debug({ wallet: wallet.slice(0, 8), status: resp.status }, "helius http error");
      return [];
    }
    const txs = await resp.json() as HeliusTx[];
    const buys: WalletBuy[] = [];
    const seen = new Set<string>();
    for (const tx of Array.isArray(txs) ? txs : []) {
      if (!tx.signature || !tx.timestamp) continue;
      for (const t of tx.tokenTransfers ?? []) {
        if (!t.mint || isNoiseMint(t.mint) || isQuoteMint(t.mint)) continue;
        if (t.toUserAccount !== wallet) continue;
        if (!(Number(t.tokenAmount) > 0)) continue;
        if (!isWalletSwapBuy(tx, wallet, t.mint)) continue;
        const keySig = `${tx.signature}:${t.mint}`;
        if (seen.has(keySig)) continue;
        seen.add(keySig);
        buys.push({
          wallet, mint: t.mint, ts: tx.timestamp * 1000, sig: tx.signature, swap: true,
        });
        break;
      }
    }
    return buys;
  } catch (err) {
    logger.debug({ err, wallet: wallet.slice(0, 8) }, "helius fetch failed");
    return [];
  }
}
