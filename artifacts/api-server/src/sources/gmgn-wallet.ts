/**
 * GMGN labels only. Never read PnL / ROI / buy averages from GMGN.
 */
import { logger } from "../core/log";
import { pace } from "./pace";

const UA = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; Crypsor/scout)",
  Referer: "https://gmgn.ai/",
  Origin: "https://gmgn.ai",
};

const KNOWN = new Set([
  "smart_degen", "smart", "degen", "kol", "sniper", "whale", "fresh",
  "fresh_wallet", "smart_money", "dev", "insider", "bundle", "bot",
  "paper", "bluechip", "renowned",
]);

function asLabels(v: unknown): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim().toLowerCase().replace(/\s+/g, "_");
    if (t && t.length < 40) out.push(t);
  };
  if (Array.isArray(v)) {
    for (const x of v) {
      if (typeof x === "string") push(x);
      else if (x && typeof x === "object" && "name" in x && typeof (x as { name: unknown }).name === "string") {
        push((x as { name: string }).name);
      }
    }
  } else if (typeof v === "string") {
    for (const part of v.split(/[,|]/)) push(part);
  }
  return [...new Set(out)].slice(0, 12);
}

type GmgnJson = {
  data?: {
    tags?: unknown;
    tag?: unknown;
    labels?: unknown;
    maker_name?: string;
    twitter_name?: string;
    name?: string;
    pnl?: unknown;
    realized_profit?: unknown;
    total_profit?: unknown;
  };
};

export async function gmgnWalletLabels(wallet: string): Promise<{ labels: string[]; note: string | null }> {
  const urls = [
    `https://gmgn.ai/defi/quotation/v1/smartmoney/sol/walletNew/${encodeURIComponent(wallet)}?period=7d`,
    `https://gmgn.ai/vas/api/v1/wallet/sol/${encodeURIComponent(wallet)}`,
  ];
  for (const url of urls) {
    try {
      await pace("gmgn", 1_200);
      const resp = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8_000) });
      if (!resp.ok) continue;
      const json = await resp.json() as GmgnJson;
      const data = json?.data ?? json;
      if (!data || typeof data !== "object") continue;
      const rec = data as GmgnJson["data"] & Record<string, unknown>;
      const labels = [
        ...asLabels(rec?.tags),
        ...asLabels(rec?.tag),
        ...asLabels(rec?.labels),
      ].filter((l) => KNOWN.has(l) || l.includes("smart") || l.includes("kol") || l.includes("snipe") || l.includes("whale") || l.includes("fresh"));
      const name = rec?.maker_name || rec?.twitter_name || rec?.name;
      if (typeof name === "string" && name.trim()) labels.unshift(`name:${name.trim().slice(0, 32)}`);
      if (labels.length) return { labels: [...new Set(labels)].slice(0, 10), note: null };
      return { labels: [], note: "GMGN returned no tags for this wallet." };
    } catch (err) {
      logger.debug({ err, wallet: wallet.slice(0, 6) }, "gmgn labels failed");
    }
  }
  return { labels: [], note: "GMGN blocked or rate-limited the label fetch. Use the GMGN icon." };
}
