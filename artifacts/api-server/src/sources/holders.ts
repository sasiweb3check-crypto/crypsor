/**
 * Holder count — one DAS page, read `total`. Not a full account crawl.
 * Missing total = skip the holders factor. Never invent a count.
 */
import { logger } from "../core/log";
import { heliusKey } from "../core/settings";
import { pace } from "./pace";

type DasPage = {
  result?: {
    total?: number;
    token_accounts?: unknown[];
  };
};

export async function holderCounts(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
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
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "holders",
            method: "getTokenAccounts",
            params: { mint, page: 1, limit: 1 },
          }),
          signal: AbortSignal.timeout(6_000),
        });
        if (!resp.ok) continue;
        const json = await resp.json() as DasPage;
        const total = Number(json?.result?.total);
        if (Number.isFinite(total) && total > 0) out.set(mint, Math.round(total));
      } catch (err) {
        logger.debug({ err, mint: mint.slice(0, 8) }, "holder count failed");
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, uniq.length) }, () => worker()));
  return out;
}
