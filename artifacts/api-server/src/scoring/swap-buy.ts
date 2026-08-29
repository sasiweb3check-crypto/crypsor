/**
 * Tracked-wallet buy vs receive. Helius often labels airdrops and ATA
 * creates as SWAP — type is ignored unless it is clearly a transfer.
 * Require quote/SOL spend above dust, and this mint as the only inbound
 * non-quote mint (a real swap + a spam transfer in the same tx must not
 * admit the spam).
 */

/** Above typical ATA rent (~0.00204 SOL) so a receive + rent is not a buy. */
export const MIN_SOL_SPEND_LAMPORTS = 3_000_000;

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

/** Helius kinds that are inbound transfers, not a swap. */
const RECEIVE_TYPES = new Set([
  "TRANSFER",
  "TOKEN_MINT",
  "AIRDROP",
  "NFT_MINT",
  "COMPRESSED_NFT_MINT",
  "NFT_TRANSFER",
]);

export type SwapTx = {
  type?: string | null;
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

function inboundNonQuote(tx: SwapTx, wallet: string): Set<string> {
  const mints = new Set<string>();
  for (const t of tx.tokenTransfers ?? []) {
    if (t.toUserAccount !== wallet) continue;
    if (!t.mint || QUOTE_MINTS.has(t.mint)) continue;
    if (!(Number(t.tokenAmount) > 0)) continue;
    mints.add(t.mint);
  }
  return mints;
}

/** True only when the wallet spent quote/SOL and received this mint as the swap output. */
export function isWalletSwapBuy(tx: SwapTx, wallet: string, mint: string): boolean {
  if (!wallet || !mint) return false;
  const kind = (tx.type ?? "").toUpperCase();
  if (RECEIVE_TYPES.has(kind)) return false;
  const inbound = inboundNonQuote(tx, wallet);
  if (!inbound.has(mint) || inbound.size !== 1) return false;
  return spentQuote(tx, wallet) || spentSol(tx, wallet);
}
