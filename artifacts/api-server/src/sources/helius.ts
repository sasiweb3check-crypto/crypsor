/**
 * Helius — tracked-wallet buy detection (the human alpha source).
 * Enhanced transactions API: /v0/addresses/:wallet/transactions
 *
 * A transfer into the wallet is not enough. We want a swap-shaped buy
 * (token in, quote out) and we drop majors / LSTs at the mint.
 */
import { logger } from "../core/log";
import { heliusKey } from "../core/settings";
import { isNoiseMint, isQuoteMint } from "../scoring/noise";

type HeliusTx = {
  signature?: string;
  timestamp?: number;
  type?: string;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    amount?: number;
  }>;
  tokenTransfers?: Array<{
    mint?: string;
    toUserAccount?: string;
    fromUserAccount?: string;
    tokenAmount?: number;
  }>;
};

export type WalletBuy = { wallet: string; mint: string; ts: number; sig: string; swap: boolean };

function looksLikeSwap(tx: HeliusTx, wallet: string, mint: string): boolean {
  const type = (tx.type ?? "").toUpperCase();
  if (type.includes("SWAP")) return true;
  const spentQuote = (tx.tokenTransfers ?? []).some((t) =>
    t.fromUserAccount === wallet && isQuoteMint(t.mint) && Number(t.tokenAmount) > 0,
  );
  const spentSol = (tx.nativeTransfers ?? []).some((n) =>
    n.fromUserAccount === wallet && Number(n.amount) > 0,
  );
  const gotMint = (tx.tokenTransfers ?? []).some((t) =>
    t.toUserAccount === wallet && t.mint === mint && Number(t.tokenAmount) > 0,
  );
  return gotMint && (spentQuote || spentSol);
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
        if (!looksLikeSwap(tx, wallet, t.mint)) continue;
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
