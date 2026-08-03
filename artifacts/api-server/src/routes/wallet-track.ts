/**
 * Wallet Track API — enter a token mint, fetch GMGN holders, judge from scratch.
 *
 * POST /api/wallet-track/analyze  { token: "<mint or tracked id>", chain?: "solana" }
 * GET  /api/wallet-track/:token   ?chain=solana
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq } from "drizzle-orm";
import { apiFail, apiOk } from "../lib/api-envelope";
import {
  CHAIN_MAP,
  gmgnFetch,
  nextProxy,
} from "../lib/gmgn-client";
import {
  judgeHolders,
  summarizeHolders,
  type GmgnHolderRaw,
  type JudgedWallet,
  type TokenHolderSummary,
} from "../lib/wallet-track-judge";

const router = Router();

const SOL_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const GMGN_PAGE_SIZE = 20;
const GMGN_MAX_PAGES = 10; // up to 200 holders per analyze

type TokenMeta = {
  id: number | null;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  marketCapUsd: string | null;
  status: string | null;
};

async function resolveToken(input: string, chainHint: string): Promise<TokenMeta | null> {
  const raw = input.trim();
  if (!raw) return null;

  // Numeric tracked id
  if (/^\d+$/.test(raw)) {
    const id = Number(raw);
    const [row] = await db.select().from(tracked_tokens).where(eq(tracked_tokens.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id,
      address: row.address,
      chain: row.chain,
      name: row.name,
      symbol: row.symbol,
      marketCapUsd: row.marketCapUsd,
      status: row.status,
    };
  }

  if (!SOL_MINT_RE.test(raw)) return null;

  const [existing] = await db
    .select()
    .from(tracked_tokens)
    .where(eq(tracked_tokens.address, raw))
    .limit(1);

  if (existing) {
    return {
      id: existing.id,
      address: existing.address,
      chain: existing.chain,
      name: existing.name,
      symbol: existing.symbol,
      marketCapUsd: existing.marketCapUsd,
      status: existing.status,
    };
  }

  // Not in DB — still allow analyze by mint (GMGN only)
  return {
    id: null,
    address: raw,
    chain: chainHint || "solana",
    name: null,
    symbol: null,
    marketCapUsd: null,
    status: null,
  };
}

async function fetchDexMeta(mint: string): Promise<{
  name: string | null;
  symbol: string | null;
  marketCapUsd: string | null;
  priceUsd: string | null;
  liquidityUsd: string | null;
  dexUrl: string | null;
} | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const body = await res.json() as {
      pairs?: Array<{
        baseToken?: { name?: string; symbol?: string; address?: string };
        marketCap?: number;
        fdv?: number;
        priceUsd?: string;
        liquidity?: { usd?: number };
        url?: string;
      }>;
    };
    const pair = (body.pairs ?? []).find(p =>
      (p.baseToken?.address ?? "").toLowerCase() === mint.toLowerCase(),
    ) ?? body.pairs?.[0];
    if (!pair) return null;
    const mc = pair.marketCap ?? pair.fdv;
    return {
      name: pair.baseToken?.name ?? null,
      symbol: pair.baseToken?.symbol ?? null,
      marketCapUsd: mc != null ? String(mc) : null,
      priceUsd: pair.priceUsd ?? null,
      liquidityUsd: pair.liquidity?.usd != null ? String(pair.liquidity.usd) : null,
      dexUrl: pair.url ?? null,
    };
  } catch {
    return null;
  }
}

async function fetchGmgnHolders(chain: string, mint: string): Promise<{
  holders: GmgnHolderRaw[];
  pages: number;
  ok: boolean;
  status: number;
  error?: string;
}> {
  const c = CHAIN_MAP[chain.toLowerCase()] ?? "sol";
  const proxy = nextProxy();
  const holders: GmgnHolderRaw[] = [];
  let pages = 0;
  let lastStatus = 0;

  for (let page = 0; page < GMGN_MAX_PAGES; page++) {
    const offset = page * GMGN_PAGE_SIZE;
    const url = `https://gmgn.ai/vas/api/v1/token_holders/${c}/${mint}?limit=${GMGN_PAGE_SIZE}&offset=${offset}`;
    const res = await gmgnFetch(url, proxy);
    lastStatus = res.status;
    if (!res.ok) {
      return {
        holders,
        pages,
        ok: holders.length > 0,
        status: res.status,
        error: holders.length === 0
          ? `GMGN holders fetch failed (HTTP ${res.status})`
          : undefined,
      };
    }

    const list: unknown[] =
      (res.data as { data?: { data?: { list?: unknown[] } } })?.data?.data?.list
      ?? (res.data as { data?: { list?: unknown[] } })?.data?.list
      ?? [];

    pages++;
    if (list.length === 0) break;
    for (const row of list) holders.push(row as GmgnHolderRaw);
    if (list.length < GMGN_PAGE_SIZE) break;
  }

  return { holders, pages, ok: true, status: lastStatus || 200 };
}

async function fetchHolderStat(chain: string, mint: string): Promise<Record<string, unknown> | null> {
  const c = CHAIN_MAP[chain.toLowerCase()] ?? "sol";
  const proxy = nextProxy();
  const res = await gmgnFetch(`https://gmgn.ai/vas/api/v1/token_holder_stat/${c}/${mint}`, proxy);
  if (!res.ok) return null;
  const root = res.data as { data?: { data?: Record<string, unknown>; stat?: Record<string, unknown> } };
  return (root?.data?.data ?? root?.data?.stat ?? root?.data ?? null) as Record<string, unknown> | null;
}

export type WalletTrackReport = {
  token: TokenMeta & {
    priceUsd: string | null;
    liquidityUsd: string | null;
    dexUrl: string | null;
  };
  summary: TokenHolderSummary;
  wallets: JudgedWallet[];
  gmgnStat: Record<string, unknown> | null;
  fetch: {
    holderRows: number;
    pages: number;
    gmgnOk: boolean;
    gmgnStatus: number;
    dexOk: boolean;
  };
  note: string;
  fetchedAt: string;
};

async function analyzeToken(input: string, chain: string): Promise<WalletTrackReport | { error: string; code: string }> {
  const resolved = await resolveToken(input, chain);
  if (!resolved) {
    return { error: "Invalid token — paste a Solana mint or tracked token id", code: "bad_token" };
  }

  const [dex, gmgnHolders, gmgnStat] = await Promise.all([
    fetchDexMeta(resolved.address),
    fetchGmgnHolders(resolved.chain, resolved.address),
    fetchHolderStat(resolved.chain, resolved.address),
  ]);

  if (!gmgnHolders.ok && gmgnHolders.holders.length === 0) {
    return {
      error: gmgnHolders.error ?? "Could not fetch holders from GMGN",
      code: "gmgn_holders_failed",
    };
  }

  const wallets = judgeHolders(gmgnHolders.holders);
  const summary = summarizeHolders(wallets);

  return {
    token: {
      ...resolved,
      name: resolved.name ?? dex?.name ?? null,
      symbol: resolved.symbol ?? dex?.symbol ?? null,
      marketCapUsd: resolved.marketCapUsd ?? dex?.marketCapUsd ?? null,
      priceUsd: dex?.priceUsd ?? null,
      liquidityUsd: dex?.liquidityUsd ?? null,
      dexUrl: dex?.dexUrl ?? null,
    },
    summary,
    wallets,
    gmgnStat,
    fetch: {
      holderRows: gmgnHolders.holders.length,
      pages: gmgnHolders.pages,
      gmgnOk: gmgnHolders.ok,
      gmgnStatus: gmgnHolders.status,
      dexOk: Boolean(dex),
    },
    note: "KOL/smart labels are GMGN pass-through. Score/label otherwise are Crypsor Wallet Track (no cabal/balance-bracket).",
    fetchedAt: new Date().toISOString(),
  };
}

router.post("/wallet-track/analyze", async (req, res) => {
  try {
    const token = String(req.body?.token ?? req.body?.mint ?? "").trim();
    const chain = String(req.body?.chain ?? "solana").trim() || "solana";
    if (!token) {
      res.status(400).json(apiFail("token is required", "bad_request"));
      return;
    }
    const result = await analyzeToken(token, chain);
    if ("error" in result) {
      res.status(result.code === "bad_token" ? 400 : 502).json(apiFail(result.error, result.code));
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=15");
    res.json(apiOk(result));
  } catch (err) {
    console.error("wallet-track analyze error", err);
    res.status(500).json(apiFail("Internal server error", "internal"));
  }
});

router.get("/wallet-track/:token", async (req, res) => {
  try {
    const token = String(req.params.token ?? "").trim();
    const chain = String(req.query.chain ?? "solana").trim() || "solana";
    if (!token) {
      res.status(400).json(apiFail("token is required", "bad_request"));
      return;
    }
    const result = await analyzeToken(token, chain);
    if ("error" in result) {
      res.status(result.code === "bad_token" ? 400 : 502).json(apiFail(result.error, result.code));
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=15");
    res.json(apiOk(result));
  } catch (err) {
    console.error("wallet-track get error", err);
    res.status(500).json(apiFail("Internal server error", "internal"));
  }
});

export default router;
