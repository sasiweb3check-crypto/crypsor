/**
 * Tracked-wallet buy vs receive. Helius often labels airdrops and ATA
 * creates as SWAP — type is ignored. Require quote/SOL spend above dust.
 */

/** Above typical ATA rent (~0.00204 SOL) so a receive + rent is not a buy. */
export const MIN_SOL_SPEND_LAMPORTS = 3_000_000;

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

export type SwapTx = {
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
  accountData?: Array<{
    account?: string;
    nativeBalanceChange?: number;
  }>;
};

function spentSol(tx: SwapTx, wallet: string): boolean {
  const nativeOut = (tx.nativeTransfers ?? []).some((n) =>
    n.fromUserAccount === wallet && Number(n.amount) >= MIN_SOL_SPEND_LAMPORTS,
  );
  if (nativeOut) return true;
  const change = (tx.accountData ?? []).find((a) => a.account === wallet)?.nativeBalanceChange;
  return Number(change) <= -MIN_SOL_SPEND_LAMPORTS;
}

function spentQuote(tx: SwapTx, wallet: string): boolean {
  return (tx.tokenTransfers ?? []).some((t) =>
    t.fromUserAccount === wallet && Boolean(t.mint && QUOTE_MINTS.has(t.mint)) && Number(t.tokenAmount) > 0,
  );
}

function receivedMint(tx: SwapTx, wallet: string, mint: string): boolean {
  return (tx.tokenTransfers ?? []).some((t) =>
    t.toUserAccount === wallet && t.mint === mint && Number(t.tokenAmount) > 0,
  );
}

/** True only when the wallet spent quote/SOL and received this mint. */
export function isWalletSwapBuy(tx: SwapTx, wallet: string, mint: string): boolean {
  if (!wallet || !mint) return false;
  return receivedMint(tx, wallet, mint) && (spentQuote(tx, wallet) || spentSol(tx, wallet));
}
