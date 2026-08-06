/**
 * Helius — tracked-wallet buy detection (the human alpha source).
 * Enhanced transactions API: /v0/addresses/:wallet/transactions
 */
import { logger } from "../core/log";
import { heliusKey } from "../core/settings";

type HeliusTx = {
  signature?: string;
  timestamp?: number; // seconds
  type?: string;
  tokenTransfers?: Array<{
    mint?: string;
    toUserAccount?: string;
    fromUserAccount?: string;
    tokenAmount?: number;
  }>;
};

const IGNORED_MINTS = new Set([
  "So11111111111111111111111111111111111111112",   // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  // USDT
]);

export type WalletBuy = { wallet: string; mint: string; ts: number; sig: string };

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
    for (const tx of Array.isArray(txs) ? txs : []) {
      if (!tx.signature || !tx.timestamp) continue;
      for (const t of tx.tokenTransfers ?? []) {
        if (!t.mint || IGNORED_MINTS.has(t.mint)) continue;
        if (t.toUserAccount !== wallet) continue;
        if (!(Number(t.tokenAmount) > 0)) continue;
        buys.push({ wallet, mint: t.mint, ts: tx.timestamp * 1000, sig: tx.signature });
        break; // one buy per tx is enough
      }
    }
    return buys;
  } catch (err) {
    logger.debug({ err, wallet: wallet.slice(0, 8) }, "helius fetch failed");
    return [];
  }
}
