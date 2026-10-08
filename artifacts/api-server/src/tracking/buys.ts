export const SOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const quotes = new Set([SOL, USDC, USDT]);
type Transfer = {
  mint: string;
  fromUserAccount?: string;
  toUserAccount?: string;
  tokenAmount: number;
};
type SwapToken = {
  mint: string;
  userAccount?: string;
  rawTokenAmount?: { tokenAmount: string; decimals: number };
};
export type Transaction = {
  signature: string;
  timestamp: number;
  type?: string;
  transactionError?: unknown;
  tokenTransfers?: Transfer[];
  nativeTransfers?: {
    fromUserAccount?: string;
    toUserAccount?: string;
    amount: number;
  }[];
  events?: {
    swap?: {
      tokenInputs?: SwapToken[];
      tokenOutputs?: SwapToken[];
      nativeInput?: { account?: string; amount: string | number };
    };
  };
};
export type Buy = {
  mint: string;
  signature: string;
  timestamp: number;
  wallet: string;
  purchasePrice: number | null;
};
function quantity(t: SwapToken) {
  const raw = t.rawTokenAmount;
  return raw ? Number(raw.tokenAmount) / 10 ** raw.decimals : 0;
}
/** Match the wallet's swap output, rather than every token transferred in the transaction. */
export function extractBuys(tx: Transaction, wallet: string): Buy[] {
  if (
    !tx.signature ||
    !tx.timestamp ||
    tx.transactionError ||
    tx.type !== "SWAP"
  )
    return [];
  const swap = tx.events?.swap;
  const buys: Buy[] = [];
  if (swap) {
    const inputs = (swap.tokenInputs ?? []).filter(
      (t) => t.userAccount === wallet && quantity(t) > 0,
    );
    const nativeSpend =
      swap.nativeInput?.account === wallet &&
      Number(swap.nativeInput.amount) > 0;
    if (!inputs.length && !nativeSpend) return [];
    const outputs = (swap.tokenOutputs ?? []).filter(
      (t) => t.userAccount === wallet && quantity(t) > 0 && !quotes.has(t.mint),
    );
    for (const t of outputs) {
      // USD purchase price is exact only for one output paid wholly in USD stablecoins.
      const stableOnly =
        !nativeSpend &&
        inputs.length > 0 &&
        inputs.every((i) => i.mint === USDC || i.mint === USDT);
      const price =
        stableOnly && outputs.length === 1
          ? inputs.reduce((sum, i) => sum + quantity(i), 0) / quantity(t)
          : null;
      buys.push({
        mint: t.mint,
        signature: tx.signature,
        timestamp: tx.timestamp,
        wallet,
        purchasePrice: price && Number.isFinite(price) ? price : null,
      });
    }
  } else {
    // A conservative fallback for parsers without swap events. Ambiguous multi-mint receipts
    // are excluded: a spam transfer attached to a legitimate swap must never be admitted.
    const incoming = (tx.tokenTransfers ?? []).filter(
      (t) =>
        t.toUserAccount === wallet &&
        t.fromUserAccount !== wallet &&
        t.tokenAmount > 0 &&
        !quotes.has(t.mint),
    );
    const mints = [...new Set(incoming.map((t) => t.mint))];
    if (mints.length !== 1) return [];
    const output = incoming[0];
    if (!output.fromUserAccount) return [];
    const paid = (tx.tokenTransfers ?? []).filter(
      (t) =>
        t.fromUserAccount === wallet &&
        t.toUserAccount === output.fromUserAccount &&
        quotes.has(t.mint) &&
        t.tokenAmount > 0,
    );
    const nativePaid = (tx.nativeTransfers ?? []).some(
      (t) =>
        t.fromUserAccount === wallet &&
        t.toUserAccount === output.fromUserAccount &&
        t.amount > 0,
    );
    if (!paid.length && !nativePaid) return [];
    const amount = incoming.reduce((n, t) => n + t.tokenAmount, 0);
    const stableOnly =
      !nativePaid && paid.every((t) => t.mint === USDC || t.mint === USDT);
    const price = stableOnly
      ? paid.reduce((n, t) => n + t.tokenAmount, 0) / amount
      : null;
    buys.push({
      mint: output.mint,
      signature: tx.signature,
      timestamp: tx.timestamp,
      wallet,
      purchasePrice: price && Number.isFinite(price) ? price : null,
    });
  }
  return [...new Map(buys.map((b) => [b.mint, b])).values()];
}
