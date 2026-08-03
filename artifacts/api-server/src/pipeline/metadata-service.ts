/**
 * Metadata Service
 *
 * Enriches newly discovered tokens with name, symbol, logo, price and
 * market cap from external sources.
 *
 * Sources (in priority order):
 *   1. DexScreener  (/latest/dex/tokens/:mint) — works once a pool exists
 *   2. PumpFun API  (/coins/:mint)             — works from day 0 (pre-DEX)
 *
 * Queue integration:
 *   • Each token:bought event enqueues a "metadata" job with a dedupKey
 *     of `metadata:<tokenId>`. If the same token triggers multiple buys
 *     in quick succession, only one enrichment runs.
 *   • The raw API payload is stored in tracked_tokens.raw_metadata (JSONB)
 *     via TokenUpdater for later re-processing / debugging.
 */

import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq, or, isNull, ne, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus, type TokenBoughtEvent } from "./event-bus";
import { healthMonitor } from "./health-monitor";
import { fetchPumpFun } from "./price-service";
import { pipelineQueue }       from "../lib/job-queue";
import { updateTokenMetadata } from "./token-updater";
import {
  evaluateDexPairs,
  isBlockedSymbol,
  isProBannedToken,
} from "../lib/solana-memecoin-gate";
import { opsLog } from "../lib/ops-log";

// ── Helius DAS — token image resolver ─────────────────────────────────────────
// Replaces the blocked PumpFun frontend-api (HTTP 530 from Cloudflare).
// Uses the getAsset DAS method which returns content.links.image or a
// json_uri we can follow to extract the image field.

function toHttpUrl(uri: string): string {
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  if (uri.startsWith("ar://"))   return `https://arweave.net/${uri.slice(5)}`;
  return uri;
}

export async function fetchSolanaAssetImage(address: string): Promise<string | null> {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) return null;
  try {
    const resp = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "1", method: "getAsset",
        params: { id: address },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const { result } = await resp.json() as {
      result?: {
        content?: {
          links?: { image?: string };
          metadata?: { image?: string };
          json_uri?: string;
        };
      };
    };

    // 1. Direct image link
    const direct = result?.content?.links?.image ?? result?.content?.metadata?.image;
    if (direct) return toHttpUrl(direct);

    // 2. Follow json_uri → parse image field
    const jsonUri = result?.content?.json_uri;
    if (jsonUri && !jsonUri.startsWith("data:")) {
      try {
        const metaResp = await fetch(toHttpUrl(jsonUri), { signal: AbortSignal.timeout(8_000) });
        if (metaResp.ok) {
          const meta = await metaResp.json() as { image?: string };
          if (meta.image) return toHttpUrl(meta.image);
        }
      } catch { /* non-fatal */ }
    }
    return null;
  } catch (err) {
    logger.debug({ err, address }, "Helius DAS asset image fetch failed");
    return null;
  }
}

const DEXCHAIN: Record<string, string> = {
  solana: "solana", eth: "ethereum", base: "base",
  bsc: "bsc", polygon: "polygon", arbitrum: "arbitrum", avalanche: "avalanche",
};

interface DexData {
  name: string | null;
  symbol: string | null;
  priceUsd: string | null;
  logoUri: string | null;
  marketCapUsd: string | null;
  fdvUsd: string | null;
  liquidityUsd: string | null;
  volume24hUsd: string | null;
  tokenCreatedAt: Date | null;
  rawPairs?: unknown;
}

// ── DexScreener ───────────────────────────────────────────────────────────────

/** DexScreener fetch with retry + exponential backoff */
export async function fetchDexScreener(
  chain: string,
  address: string,
  attempt = 0,
): Promise<DexData | null> {
  const t0 = Date.now();
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`,
      { signal: AbortSignal.timeout(12_000) },
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const json = await resp.json() as {
      pairs?: Array<{
        chainId: string;
        dexId?: string;
        baseToken: { address: string; name: string; symbol: string };
        priceUsd?: string;
        fdv?: number;
        marketCap?: number;
        liquidity?: { usd?: number };
        volume?: { h24?: number };
        pairCreatedAt?: number;
        info?: { imageUrl?: string };
      }>;
    };

    if (!json.pairs?.length) return null;
    const dexChain = DEXCHAIN[chain] ?? chain;
    const chainPairs = json.pairs.filter(p => p.chainId === dexChain);
    // Prefer Raydium pair for Solana (has better data post-migration)
    const pair = chainPairs.find(p => p.dexId === "raydium")
      ?? chainPairs[0]
      ?? json.pairs[0];
    // Circulating MC only — never store FDV as marketCap (1B-supply fake caps)
    const mc = pair.marketCap ?? null;
    const fdv = pair.fdv ?? null;

    healthMonitor.ok("metadata-service", Date.now() - t0);
    return {
      name:         pair.baseToken.name   || null,
      symbol:       pair.baseToken.symbol || null,
      priceUsd:     pair.priceUsd ?? null,
      logoUri:      pair.info?.imageUrl ?? null,
      marketCapUsd: mc !== null ? String(mc) : null,
      fdvUsd:       fdv !== null ? String(fdv) : null,
      liquidityUsd: pair.liquidity?.usd !== undefined ? String(pair.liquidity.usd) : null,
      volume24hUsd: pair.volume?.h24   !== undefined ? String(pair.volume.h24)  : null,
      tokenCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : null,
      rawPairs: json.pairs,
    };
  } catch (err) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1_500 * (attempt + 1)));
      return fetchDexScreener(chain, address, attempt + 1);
    }
    healthMonitor.error("metadata-service", err);
    return null;
  }
}

// ── Enrichment logic ──────────────────────────────────────────────────────────

interface MetadataJobData {
  tokenId:      number;
  tokenAddress: string;
  chain:        string;
  /** boughtAt from the original TokenBoughtEvent */
  boughtAt:     string;
}

/**
 * Fetch metadata for one token and persist it.
 * Sources: DexScreener → PumpFun (Solana fallback).
 * Stores raw payload in raw_metadata JSONB.
 */
async function enrichToken(job: MetadataJobData): Promise<void> {
  try {
    let data: DexData | null = await fetchDexScreener(job.chain, job.tokenAddress);

    // PumpFun fallback for Solana tokens not yet listed on any DEX aggregator
    let rawPayload: unknown = data?.rawPairs ?? null;

    if (!data && job.chain === "solana") {
      const pf = await fetchPumpFun(job.tokenAddress);
      if (pf) {
        rawPayload = pf;
        data = {
          name:          null,
          symbol:        null,
          priceUsd:      pf.price,
          logoUri:       pf.logo,
          marketCapUsd:  pf.marketCapUsd,
          fdvUsd:        pf.fdvUsd,
          liquidityUsd:  pf.liquidityUsd,
          volume24hUsd:  pf.volume24hUsd,
          tokenCreatedAt: pf.tokenCreatedAt,
        };
      }
    }

    // PumpFun coin endpoint — name/symbol/logo only. Never wipe Dex socials.
    if (job.chain === "solana" && (!data || !data.logoUri || !data.name || !data.symbol)) {
      try {
        const coinResp = await fetch(
          `https://frontend-api.pump.fun/coins/${job.tokenAddress}`,
          { signal: AbortSignal.timeout(8_000), headers: { Accept: "application/json" } },
        );
        if (coinResp.ok) {
          const coin = await coinResp.json() as {
            name?: string; symbol?: string; image_uri?: string;
            twitter?: string; telegram?: string; website?: string;
          };
          if (!data) {
            data = {
              name: coin.name ?? null, symbol: coin.symbol ?? null,
              priceUsd: null, logoUri: coin.image_uri ?? null,
              marketCapUsd: null, fdvUsd: null, liquidityUsd: null,
              volume24hUsd: null, tokenCreatedAt: null,
            };
            rawPayload = {
              pairs: [],
              pumpfun: coin,
              twitter: coin.twitter, telegram: coin.telegram, website: coin.website,
            };
          } else {
            if (!data.name && coin.name) data.name = coin.name;
            if (!data.symbol && coin.symbol) data.symbol = coin.symbol;
            if (!data.logoUri && coin.image_uri) data.logoUri = coin.image_uri;
            // Merge socials into existing Dex pairs payload without replacing it
            if (Array.isArray(rawPayload)) {
              rawPayload = {
                pairs: rawPayload,
                pumpfun: { twitter: coin.twitter, telegram: coin.telegram, website: coin.website },
                twitter: coin.twitter, telegram: coin.telegram, website: coin.website,
              };
            } else if (rawPayload && typeof rawPayload === "object") {
              rawPayload = {
                ...(rawPayload as Record<string, unknown>),
                pumpfun: { twitter: coin.twitter, telegram: coin.telegram, website: coin.website },
                twitter: coin.twitter ?? (rawPayload as Record<string, unknown>).twitter,
                telegram: coin.telegram ?? (rawPayload as Record<string, unknown>).telegram,
                website: coin.website ?? (rawPayload as Record<string, unknown>).website,
              };
            }
          }
        }
      } catch { /* non-fatal */ }
    }

    // Also wrap bare pairs array so extractSocials always sees { pairs }
    if (Array.isArray(rawPayload)) {
      rawPayload = { pairs: rawPayload };
    }

    if (!data) return;

    // Re-check SOL/USDC pair + blocked symbols once Dex lists the token.
    // Bonding tokens (no pairs yet) stay; junk majors/stables get ignored.
    if (job.chain === "solana" || job.chain === "sol") {
      const pairs = Array.isArray(data.rawPairs)
        ? (data.rawPairs as Parameters<typeof evaluateDexPairs>[1])
        : (rawPayload && typeof rawPayload === "object" && Array.isArray((rawPayload as { pairs?: unknown[] }).pairs)
          ? ((rawPayload as { pairs: Parameters<typeof evaluateDexPairs>[1] }).pairs)
          : null);
      const mcNum = data.marketCapUsd != null ? parseFloat(data.marketCapUsd) : null;
      const ban = isProBannedToken({
        address: job.tokenAddress,
        symbol: data.symbol,
        calledMcUsd: mcNum,
      });
      const gate = pairs
        ? evaluateDexPairs(job.tokenAddress, pairs)
        : { ok: !ban.banned && !isBlockedSymbol(data.symbol), reason: ban.reason ?? "ok", symbol: data.symbol };

      if (!gate.ok || ban.banned) {
        const reason = ban.reason ?? gate.reason ?? "non_meme";
        await db.update(tracked_tokens)
          .set({
            status: "ignored",
            symbol: data.symbol,
            lastStatusChangeAt: new Date(),
          })
          .where(eq(tracked_tokens.id, job.tokenId));
        opsLog("wallet_buy", "info", `Ignored non-meme after list · ${reason}`, {
          tokenId: job.tokenId,
          mint: job.tokenAddress.slice(0, 8),
          symbol: data.symbol,
        });
        return;
      }
    }

    // Write via TokenUpdater (stores raw_metadata + core fields)
    await updateTokenMetadata(job.tokenId, {
      name:           data.name,
      symbol:         data.symbol,
      logoUri:        data.logoUri,
      priceUsd:       data.priceUsd,
      marketCapUsd:   data.marketCapUsd,
      fdvUsd:         data.fdvUsd,
      liquidityUsd:   data.liquidityUsd,
      volume24hUsd:   data.volume24hUsd,
      tokenCreatedAt: data.tokenCreatedAt,
      rawPayload,
    });

    // Also update lastBuyAt (not part of updateTokenMetadata contract)
    await db.update(tracked_tokens)
      .set({ lastBuyAt: new Date(job.boughtAt) })
      .where(eq(tracked_tokens.id, job.tokenId));

  } catch (err) {
    healthMonitor.error("metadata-service", err);
    logger.warn({ err, tokenId: job.tokenId }, "Metadata enrichment failed (non-fatal)");
    throw err; // re-throw so queue can retry
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

export function startMetadataService() {
  // Register queue handler
  pipelineQueue.register<MetadataJobData>("metadata", async (data) => {
    await enrichToken(data);
  });

  // On new buy: enqueue metadata enrichment with dedup per tokenId
  eventBus.on("token:bought", (e: TokenBoughtEvent) => {
    pipelineQueue.enqueue<MetadataJobData>(
      "metadata",
      {
        tokenId:      e.tokenId,
        tokenAddress: e.tokenAddress,
        chain:        e.chain,
        boughtAt:     e.boughtAt.toISOString(),
      },
      {
        priority: 5,
        dedupKey: `metadata:${e.tokenId}`,
      },
    );
  });

  logger.info("Metadata service started (DexScreener + PumpFun fallback for Solana, queue-backed with dedup)");

  // On startup: re-queue metadata for any active token missing a logo.
  // Runs once after a 20s delay so the rest of startup settles first.
  setTimeout(async () => {
    try {
      const missing = await db
        .select({ id: tracked_tokens.id, address: tracked_tokens.address, chain: tracked_tokens.chain })
        .from(tracked_tokens)
        .where(
          and(
            or(isNull(tracked_tokens.logoUri), eq(tracked_tokens.logoUri, "")),
            ne(tracked_tokens.status, "archive"),
          )
        );
      for (const t of missing) {
        pipelineQueue.enqueue<MetadataJobData>(
          "metadata",
          { tokenId: t.id, tokenAddress: t.address, chain: t.chain, boughtAt: new Date().toISOString() },
          { priority: 1, dedupKey: `metadata:${t.id}` },
        );
      }
      if (missing.length > 0) {
        logger.info({ count: missing.length }, "Metadata: queued logo re-fetch for tokens with missing logos");
      }
    } catch (err) {
      logger.warn({ err }, "Metadata: failed to queue missing-logo tokens");
    }
  }, 20_000);
}
