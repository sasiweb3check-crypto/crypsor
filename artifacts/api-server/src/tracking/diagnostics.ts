import { extractBuys, SOL, USDC, USDT, type Transaction } from "./buys.ts";
const quotes = new Set([SOL, USDC, USDT]);
export function scanDiagnostics(transactions: Transaction[], wallet: string) {
  const reasons: Record<string, number> = {};
  const samples: Record<string, unknown>[] = [];
  for (const tx of transactions) {
    const buys = extractBuys(tx, wallet);
    const output = (tx.events?.swap?.tokenOutputs ?? []).some(
      (t) => t.userAccount === wallet && !quotes.has(t.mint),
    );
    const incoming = (tx.tokenTransfers ?? []).some(
      (t) =>
        t.toUserAccount === wallet && !quotes.has(t.mint) && t.tokenAmount > 0,
    );
    const reason = buys.length
      ? "purchase-recognized"
      : tx.transactionError
        ? "failed-transaction"
        : tx.type !== "SWAP"
          ? "not-a-swap"
          : tx.events?.swap
            ? output
              ? "wallet-payment-not-recognized"
              : "no-nonquote-wallet-output"
            : incoming
              ? "swap-routing-not-recognized"
              : "no-nonquote-wallet-output";
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (
      !buys.length &&
      samples.length < 4 &&
      !samples.some((s) => s.reason === reason)
    ) {
      const detail = tx as Transaction & { source?: string; feePayer?: string };
      samples.push({
        reason,
        signature: tx.signature,
        type: tx.type,
        source: detail.source,
        feePayer: detail.feePayer,
        swap: tx.events?.swap ?? null,
        tokenTransfers: (tx.tokenTransfers ?? []).slice(0, 30),
        nativeTransfers: (tx.nativeTransfers ?? []).slice(0, 30),
      });
    }
  }
  return { parser: "buys-v2", checked: transactions.length, reasons, samples };
}
