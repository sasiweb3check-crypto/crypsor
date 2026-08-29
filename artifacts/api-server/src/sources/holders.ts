/**
 * Holder count (DAS total) + top-holder percents (largest 20 + supply).
 * One JSON-RPC batch per mint. Missing total or percents = skip, never invent 0.
 */
import { logger } from "../core/log";
import { heliusKey } from "../core/settings";
import { holderBookFromRpc, type HolderRugBook } from "../scoring/holder-rug";
import { pace } from "./pace";

type RpcRow = {
  id?: string | number;
  result?: unknown;
  error?: unknown;
};

type DasPage = {
  result?: {
    total?: number;
    token_accounts?: unknown[];
  };
};

function dasTotal(row: RpcRow | undefined): number | null {
  const result = row?.result as DasPage["result"] | undefined;
  const total = Number(result?.total);
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}

function pick(batch: RpcRow[], id: string): RpcRow | undefined {
  return batch.find((r) => String(r.id) === id);
}

export async function holderBooks(mints: string[]): Promise<Map<string, HolderRugBook>> {
  const out = new Map<string, HolderRugBook>();
  const key = await heliusKey();
  const uniq = [...new Set(mints.filter(Boolean))];
  if (!key || !uniq.length) return out;

  let i = 0;
  const worker = async () => {
    while (i < uniq.length) {
      const mint = uniq[i++];
      await pace("helius-holders", 80);
      try {
        const resp = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify([
            { jsonrpc: "2.0", id: "das", method: "getTokenAccounts", params: { mint, page: 1, limit: 1 } },
            { jsonrpc: "2.0", id: "largest", method: "getTokenLargestAccounts", params: [mint] },
            { jsonrpc: "2.0", id: "supply", method: "getTokenSupply", params: [mint] },
          ]),
          signal: AbortSignal.timeout(8_000),
        });
        if (!resp.ok) continue;
        const json = await resp.json() as RpcRow | RpcRow[];
        const batch = Array.isArray(json) ? json : [json];
        const holders = dasTotal(pick(batch, "das"));
        const book = holderBookFromRpc(
          pick(batch, "largest")?.result,
          pick(batch, "supply")?.result,
          holders,
        );
        if (book.measured || holders != null) out.set(mint, book);
      } catch (err) {
        logger.debug({ err, mint: mint.slice(0, 8) }, "holder book failed");
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, uniq.length) }, () => worker()));
  return out;
}

export async function holderCounts(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const books = await holderBooks(mints);
  for (const [mint, book] of books) {
    if (book.holders != null) out.set(mint, book.holders);
  }
  return out;
}
