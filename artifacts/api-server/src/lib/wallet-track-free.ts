/**
 * Free-resource Wallet Track enrichers.
 * Solana RPC + RugCheck + DexScreener — no GMGN for labels/scoring.
 */

import { logger } from "./logger";

const HELIUS_RPC =
  process.env.HELIUS_RPC_URL ||
  process.env.SOLANA_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const EXCHANGE_FUNDERS = new Set([
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
  "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2",
  "2ojv9BAiHUrvsm9gfxFo7gPswMjjtpbwjGTASRAZuYUE",
  "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dQKvM",
  "GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21wxeRgfTQ1BC",
  "uNrix3Q5g51MCEUrIBB5ZhNhDA64SAStL2o5u6K5oT",
  "FWznbcNXWQuHTawe9RxvQ2LdCHDdXtbXjZ2ssLgQZTq",
  "A77HErqtfN1hLLpvZ9pCtu66FEtM8BvekaYd8BPGspa",
]);

export type FreeHolder = {
  wallet: string;
  amountUi: number;
  pct: number;
  rank: number;
};

export type TokenPulse = {
  symbol: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange6h: number | null;
  priceChange24h: number | null;
  pairCreatedAt: number | null;
  dexId: string | null;
  pairAddress: string | null;
  websites: string[];
  socials: string[];
};

export type RugSnapshot = {
  score: number | null;
  rugged: boolean;
  risks: string[];
  mintAuthority: string | null;
  freezeAuthority: string | null;
  top10Pct: number | null;
  lpLockedPct: number | null;
};

export type WalletOnChain = {
  wallet: string;
  firstSeenAt: number | null;
  ageDays: number | null;
  fundedBy: string | null;
  fundedByIsExchange: boolean;
  fundedByIsSameCluster: boolean;
  solBalance: number | null;
  signatureCountSample: number;
};

export type RunStatus = "running" | "fading" | "dead" | "unknown";

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(HELIUS_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Top N holders via largest account owners — free Solana RPC. */
export async function fetchTopHoldersFree(
  mint: string,
  limit = 40,
): Promise<{ holders: FreeHolder[]; totalSupplyUi: number }> {
  try {
    const result = (await rpc("getTokenLargestAccounts", [mint])) as {
      value?: Array<{ address: string; uiAmount?: number | null; amount?: string; decimals?: number }>;
    };
    if (result?.value?.length) {
      const rows = result.value.slice(0, Math.min(limit, 20));
      const addrs = rows.map((v) => v.address);
      const infos = (await rpc("getMultipleAccounts", [
        addrs,
        { encoding: "jsonParsed" },
      ])) as {
        value?: Array<{
          data?: { parsed?: { info?: { owner?: string; tokenAmount?: { uiAmount?: number } } } };
        } | null>;
      };

      const holders: FreeHolder[] = [];
      let total = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const info = infos.value?.[i]?.data?.parsed?.info;
        const owner = info?.owner;
        const amt = Number(info?.tokenAmount?.uiAmount ?? row.uiAmount ?? 0);
        if (!owner || !Number.isFinite(amt) || amt <= 0) continue;
        if (owner === mint) continue;
        holders.push({ wallet: owner, amountUi: amt, pct: 0, rank: holders.length + 1 });
        total += amt;
      }
      let supplyUi = total;
      try {
        const sup = (await rpc("getTokenSupply", [mint])) as {
          value?: { uiAmount?: number | null };
        };
        if (sup?.value?.uiAmount && Number.isFinite(sup.value.uiAmount)) {
          supplyUi = Number(sup.value.uiAmount);
        }
      } catch {
        /* keep sum */
      }
      for (const h of holders) {
        h.pct = supplyUi > 0 ? (h.amountUi / supplyUi) * 100 : 0;
      }
      if (holders.length) return { holders, totalSupplyUi: supplyUi };
    }
  } catch (err) {
    logger.warn({ err, mint }, "getTokenLargestAccounts failed");
  }

  // Fallback: getProgramAccounts (heavier) — try classic + token-2022
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
    try {
      const filters: Array<Record<string, unknown>> = [{ memcmp: { offset: 0, bytes: mint } }];
      if (programId === TOKEN_PROGRAM) filters.unshift({ dataSize: 165 });

      const result = (await rpc("getProgramAccounts", [
        programId,
        { encoding: "jsonParsed", filters },
      ])) as Array<{
        account?: { data?: { parsed?: { info?: { owner?: string; tokenAmount?: { uiAmount?: number } } } } };
      }>;

      const map = new Map<string, number>();
      for (const row of result || []) {
        const info = row.account?.data?.parsed?.info;
        const owner = info?.owner;
        const amt = Number(info?.tokenAmount?.uiAmount ?? 0);
        if (!owner || !Number.isFinite(amt) || amt <= 0) continue;
        map.set(owner, (map.get(owner) || 0) + amt);
      }
      if (!map.size) continue;

      let supplyUi = 0;
      try {
        const sup = (await rpc("getTokenSupply", [mint])) as { value?: { uiAmount?: number | null } };
        supplyUi = Number(sup?.value?.uiAmount ?? 0);
      } catch {
        supplyUi = [...map.values()].reduce((a, b) => a + b, 0);
      }
      const holders = [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([wallet, amountUi], i) => ({
          wallet,
          amountUi,
          pct: supplyUi > 0 ? (amountUi / supplyUi) * 100 : 0,
          rank: i + 1,
        }));
      return { holders, totalSupplyUi: supplyUi };
    } catch (err) {
      logger.warn({ err, mint, programId }, "getProgramAccounts holders failed");
    }
  }
  return { holders: [], totalSupplyUi: 0 };
}

export async function fetchDexPulse(mint: string): Promise<TokenPulse | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      pairs?: Array<{
        chainId?: string;
        dexId?: string;
        pairAddress?: string;
        baseToken?: { address?: string; symbol?: string; name?: string };
        priceUsd?: string;
        marketCap?: number;
        fdv?: number;
        liquidity?: { usd?: number };
        volume?: { h24?: number };
        txns?: { h24?: { buys?: number; sells?: number } };
        priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
        pairCreatedAt?: number;
        info?: {
          imageUrl?: string;
          websites?: Array<{ url?: string }>;
          socials?: Array<{ url?: string }>;
        };
      }>;
    };
    const pairs = (json.pairs || []).filter((p) => p.chainId === "solana");
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0]!;
    return {
      symbol: p.baseToken?.symbol || "?",
      name: p.baseToken?.name || "?",
      imageUrl: p.info?.imageUrl || null,
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      marketCap: p.marketCap ?? p.fdv ?? null,
      liquidityUsd: p.liquidity?.usd ?? null,
      volume24h: p.volume?.h24 ?? null,
      buys24h: p.txns?.h24?.buys ?? null,
      sells24h: p.txns?.h24?.sells ?? null,
      priceChange5m: p.priceChange?.m5 ?? null,
      priceChange1h: p.priceChange?.h1 ?? null,
      priceChange6h: p.priceChange?.h6 ?? null,
      priceChange24h: p.priceChange?.h24 ?? null,
      pairCreatedAt: p.pairCreatedAt ?? null,
      dexId: p.dexId || null,
      pairAddress: p.pairAddress || null,
      websites: (p.info?.websites || []).map((w) => w.url || "").filter(Boolean),
      socials: (p.info?.socials || []).map((s) => s.url || "").filter(Boolean),
    };
  } catch (err) {
    logger.warn({ err, mint }, "dexscreener pulse failed");
    return null;
  }
}

export async function fetchRugSnapshot(mint: string): Promise<RugSnapshot> {
  const empty: RugSnapshot = {
    score: null,
    rugged: false,
    risks: [],
    mintAuthority: null,
    freezeAuthority: null,
    top10Pct: null,
    lpLockedPct: null,
  };
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return empty;
    const j = (await res.json()) as {
      score?: number;
      rugged?: boolean;
      risks?: Array<{ name?: string; level?: string }>;
      tokenMeta?: { mintAuthority?: string | null; freezeAuthority?: string | null };
      topHolders?: Array<{ pct?: number }>;
      markets?: Array<{ lp?: { lpLockedPct?: number } }>;
    };
    const top10 = (j.topHolders || []).slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0);
    const lpLocked = j.markets?.[0]?.lp?.lpLockedPct ?? null;
    return {
      score: j.score ?? null,
      rugged: Boolean(j.rugged),
      risks: (j.risks || []).map((r) => r.name || r.level || "risk").filter(Boolean),
      mintAuthority: j.tokenMeta?.mintAuthority ?? null,
      freezeAuthority: j.tokenMeta?.freezeAuthority ?? null,
      top10Pct: top10 || null,
      lpLockedPct: lpLocked,
    };
  } catch (err) {
    logger.warn({ err, mint }, "rugcheck failed");
    return empty;
  }
}

export function classifyRunStatus(pulse: TokenPulse | null, rug: RugSnapshot): RunStatus {
  if (rug.rugged) return "dead";
  if (!pulse) return "unknown";
  const liq = pulse.liquidityUsd ?? 0;
  const vol = pulse.volume24h ?? 0;
  const ch24 = pulse.priceChange24h ?? 0;
  const ch1h = pulse.priceChange1h ?? 0;
  if (liq < 800 && vol < 500) return "dead";
  if (ch24 <= -70 || (ch1h <= -40 && ch24 <= -50)) return "dead";
  if (ch24 <= -35 || (liq < 5_000 && ch1h < -15)) return "fading";
  if (vol > 2_000 || liq > 8_000) return "running";
  return "fading";
}

/** First funding + age from free RPC signatures. */
export async function enrichWalletOnChain(
  wallet: string,
  peerFunders: Set<string>,
): Promise<WalletOnChain> {
  const base: WalletOnChain = {
    wallet,
    firstSeenAt: null,
    ageDays: null,
    fundedBy: null,
    fundedByIsExchange: false,
    fundedByIsSameCluster: false,
    solBalance: null,
    signatureCountSample: 0,
  };

  try {
    const bal = (await rpc("getBalance", [wallet])) as { value?: number };
    base.solBalance = typeof bal?.value === "number" ? bal.value / 1e9 : null;
  } catch {
    /* ignore */
  }

  try {
    // Oldest activity sample: fetch recent then walk with before if needed
    const sigs = (await rpc("getSignaturesForAddress", [
      wallet,
      { limit: 1000 },
    ])) as Array<{ signature: string; blockTime?: number | null; err?: unknown }>;
    base.signatureCountSample = sigs?.length || 0;
    if (!sigs?.length) return base;

    const oldest = sigs[sigs.length - 1];
    const firstTs = oldest?.blockTime ? oldest.blockTime * 1000 : null;
    base.firstSeenAt = firstTs;
    if (firstTs) {
      base.ageDays = Math.max(0, (Date.now() - firstTs) / 86_400_000);
    }

    // Funding: look at oldest successful tx for SOL transfer in
    const oldestSig = oldest?.signature;
    if (oldestSig) {
      try {
        const tx = (await rpc("getTransaction", [
          oldestSig,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ])) as {
          meta?: {
            preBalances?: number[];
            postBalances?: number[];
            err?: unknown;
          };
          transaction?: {
            message?: {
              accountKeys?: Array<string | { pubkey?: string }>;
            };
          };
        };
        const keys = (tx?.transaction?.message?.accountKeys || []).map((k) =>
          typeof k === "string" ? k : k.pubkey || "",
        );
        const pre = tx?.meta?.preBalances || [];
        const post = tx?.meta?.postBalances || [];
        const idx = keys.indexOf(wallet);
        if (idx >= 0 && pre[idx] !== undefined && post[idx] !== undefined) {
          const delta = (post[idx]! - pre[idx]!) / 1e9;
          if (delta > 0.001) {
            // Find largest SOL decrease among others = likely funder
            let bestI = -1;
            let bestDrop = 0;
            for (let i = 0; i < keys.length; i++) {
              if (i === idx) continue;
              const drop = ((pre[i] || 0) - (post[i] || 0)) / 1e9;
              if (drop > bestDrop) {
                bestDrop = drop;
                bestI = i;
              }
            }
            if (bestI >= 0 && bestDrop > 0.001) {
              const funder = keys[bestI]!;
              base.fundedBy = funder;
              base.fundedByIsExchange = EXCHANGE_FUNDERS.has(funder);
              base.fundedByIsSameCluster = peerFunders.has(funder) && !EXCHANGE_FUNDERS.has(funder);
            }
          }
        }
      } catch {
        /* ignore tx parse */
      }
    }
  } catch (err) {
    logger.warn({ err, wallet }, "wallet on-chain enrich failed");
  }

  return base;
}

export async function enrichHoldersBatch(
  wallets: string[],
  concurrency = 3,
): Promise<Map<string, WalletOnChain>> {
  const out = new Map<string, WalletOnChain>();
  // First pass: ages only to discover funders
  const firstPass: WalletOnChain[] = [];
  for (let i = 0; i < wallets.length; i += concurrency) {
    const chunk = wallets.slice(i, i + concurrency);
    const rows = await Promise.all(chunk.map((w) => enrichWalletOnChain(w, new Set())));
    firstPass.push(...rows);
    if (i + concurrency < wallets.length) await sleep(120);
  }
  const funderCounts = new Map<string, number>();
  for (const r of firstPass) {
    if (r.fundedBy && !r.fundedByIsExchange) {
      funderCounts.set(r.fundedBy, (funderCounts.get(r.fundedBy) || 0) + 1);
    }
  }
  const clusterFunders = new Set(
    [...funderCounts.entries()].filter(([, n]) => n >= 2).map(([f]) => f),
  );
  for (const r of firstPass) {
    r.fundedByIsSameCluster = Boolean(
      r.fundedBy && clusterFunders.has(r.fundedBy) && !EXCHANGE_FUNDERS.has(r.fundedBy),
    );
    out.set(r.wallet, r);
  }
  return out;
}

export function estimateAthMultiple(pulse: TokenPulse | null): number | null {
  if (!pulse?.priceChange24h && pulse?.priceChange24h !== 0) return null;
  // Rough ATH proxy from available free data: peak of recent windows vs now
  const drops = [pulse.priceChange5m, pulse.priceChange1h, pulse.priceChange6h, pulse.priceChange24h]
    .filter((x): x is number => typeof x === "number");
  if (!drops.length) return null;
  const worst = Math.min(...drops);
  // If down 80% from a window, ATH multiple from that window ≈ 1 / (1 + change/100)
  if (worst >= 0) return 1;
  const fromPeak = 1 / (1 + worst / 100);
  return Number.isFinite(fromPeak) ? Math.min(fromPeak, 50) : null;
}
