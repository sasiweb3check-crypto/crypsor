/**
 * Wallet Track API — free holders + Crypsor labels; GMGN only for KOL/smart overlay.
 *
 * POST /api/wallet-track/analyze  { token: "<mint or tracked id>", chain?: "solana" }
 * GET  /api/wallet-track/:token   ?chain=solana
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq } from "drizzle-orm";
import { apiFail, apiOk } from "../lib/api-envelope";
import { CHAIN_MAP, gmgnFetch, nextProxy } from "../lib/gmgn-client";
import {
  classifyRunStatus,
  enrichHoldersBatch,
  estimateAthMultiple,
  fetchDexPulse,
  fetchRugSnapshot,
  fetchTopHoldersFree,
  type FreeHolder,
} from "../lib/wallet-track-free";
import {
  buildTokenBoard,
  extractGmgnOverlays,
  judgeFreeHolders,
  summarizeHolders,
  type JudgedWallet,
  type TokenBoard,
  type TokenHolderSummary,
} from "../lib/wallet-track-judge";

const router = Router();

const SOL_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** GMGN used only to tag KOL/smart among our free holder set — keep pages light. */
const GMGN_PAGE_SIZE = 20;
const GMGN_MAX_PAGES = 5;

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

/** Lightweight GMGN pull — we only keep KOL/smart overlays. */
async function fetchGmgnIdentityRows(chain: string, mint: string): Promise<{
  rows: Array<{
    address?: string;
    account_address?: string;
    twitter_name?: string | null;
    twitter_username?: string | null;
    tags?: string[];
    maker_token_tags?: string[];
  }>;
  pages: number;
  ok: boolean;
  status: number;
}> {
  const c = CHAIN_MAP[chain.toLowerCase()] ?? "sol";
  const proxy = nextProxy();
  const rows: Array<{
    address?: string;
    account_address?: string;
    twitter_name?: string | null;
    twitter_username?: string | null;
    tags?: string[];
    maker_token_tags?: string[];
  }> = [];
  let pages = 0;
  let lastStatus = 0;

  for (let page = 0; page < GMGN_MAX_PAGES; page++) {
    const offset = page * GMGN_PAGE_SIZE;
    const url = `https://gmgn.ai/vas/api/v1/token_holders/${c}/${mint}?limit=${GMGN_PAGE_SIZE}&offset=${offset}`;
    try {
      const res = await gmgnFetch(url, proxy);
      lastStatus = res.status;
      if (!res.ok) {
        return { rows, pages, ok: rows.length > 0, status: res.status };
      }
      const list: unknown[] =
        (res.data as { data?: { data?: { list?: unknown[] } } })?.data?.data?.list
        ?? (res.data as { data?: { list?: unknown[] } })?.data?.list
        ?? [];
      pages++;
      if (list.length === 0) break;
      for (const row of list) {
        rows.push(row as (typeof rows)[number]);
      }
      if (list.length < GMGN_PAGE_SIZE) break;
    } catch {
      return { rows, pages, ok: rows.length > 0, status: lastStatus || 0 };
    }
  }

  return { rows, pages, ok: true, status: lastStatus || 200 };
}

export type WalletTrackReport = {
  token: TokenMeta & {
    priceUsd: string | null;
    liquidityUsd: string | null;
    dexUrl: string | null;
    imageUrl: string | null;
  };
  board: TokenBoard;
  summary: TokenHolderSummary;
  wallets: JudgedWallet[];
  fetch: {
    holderRows: number;
    freeOk: boolean;
    gmgnOverlayRows: number;
    gmgnPages: number;
    gmgnOk: boolean;
    gmgnStatus: number;
    dexOk: boolean;
    rugOk: boolean;
    enrichedWallets: number;
  };
  note: string;
  fetchedAt: string;
};

async function analyzeToken(
  input: string,
  chain: string,
): Promise<WalletTrackReport | { error: string; code: string }> {
  const resolved = await resolveToken(input, chain);
  if (!resolved) {
    return { error: "Invalid token — paste a Solana mint or tracked token id", code: "bad_token" };
  }

  // Free path first (required)
  const [holderPack, pulse, rug] = await Promise.all([
    fetchTopHoldersFree(resolved.address, 30),
    fetchDexPulse(resolved.address),
    fetchRugSnapshot(resolved.address),
  ]);

  if (!holderPack.holders.length) {
    return {
      error: "Could not fetch holders from free Solana RPC",
      code: "free_holders_failed",
    };
  }

  // Cap enrich cost — top 20 by hold %
  const toEnrich = [...holderPack.holders]
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 20)
    .map((h) => h.wallet);

  const [onChainMap, gmgnIdentity] = await Promise.all([
    enrichHoldersBatch(toEnrich, 3),
    fetchGmgnIdentityRows(resolved.chain, resolved.address),
  ]);

  const overlays = extractGmgnOverlays(gmgnIdentity.rows);
  const runStatus = classifyRunStatus(pulse, rug);
  const athEst = estimateAthMultiple(pulse);
  const wallets = judgeFreeHolders(
    holderPack.holders as FreeHolder[],
    onChainMap,
    overlays,
    pulse?.pairCreatedAt ?? null,
  );
  const summary = summarizeHolders(wallets);
  const board = buildTokenBoard(pulse, rug, runStatus, athEst);

  // Extra board risk from rug
  if (rug.rugged) summary.riskFlags.unshift("token flagged rugged (RugCheck)");
  if (rug.mintAuthority) summary.riskFlags.push("mint authority still live");
  if (rug.freezeAuthority) summary.riskFlags.push("freeze authority still live");
  if ((rug.top10Pct ?? 0) >= 40) summary.riskFlags.push(`top10 hold ~${rug.top10Pct!.toFixed(0)}%`);

  return {
    token: {
      ...resolved,
      name: resolved.name ?? pulse?.name ?? null,
      symbol: resolved.symbol ?? pulse?.symbol ?? null,
      marketCapUsd:
        resolved.marketCapUsd
        ?? (pulse?.marketCap != null ? String(pulse.marketCap) : null),
      priceUsd: pulse?.priceUsd != null ? String(pulse.priceUsd) : null,
      liquidityUsd: pulse?.liquidityUsd != null ? String(pulse.liquidityUsd) : null,
      dexUrl: pulse?.pairAddress
        ? `https://dexscreener.com/solana/${pulse.pairAddress}`
        : null,
      imageUrl: pulse?.imageUrl ?? null,
      status: resolved.status ?? runStatus,
    },
    board,
    summary,
    wallets,
    fetch: {
      holderRows: holderPack.holders.length,
      freeOk: true,
      gmgnOverlayRows: overlays.size,
      gmgnPages: gmgnIdentity.pages,
      gmgnOk: gmgnIdentity.ok,
      gmgnStatus: gmgnIdentity.status,
      dexOk: Boolean(pulse),
      rugOk: rug.score != null || rug.risks.length > 0,
      enrichedWallets: onChainMap.size,
    },
    note:
      "Holders from free Solana RPC. Labels/scores are Crypsor model (age, funding cluster, sniper timing, concentration). GMGN used only for KOL/smart overlay.",
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
