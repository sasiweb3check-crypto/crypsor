/**
 * Crypsor Token Intelligence Pipeline
 *
 * Architecture:
 *   Wallet Scheduler → Worker Pool → Trade Events → Event Bus
 *   Event Bus → Price Service | Metadata Service | Lifecycle Engine | Momentum Engine
 *
 * Wallets are sensors. Tokens are the primary entity.
 */

import { db } from "@workspace/db";
import { walletdatasource, tracked_tokens, token_buys, token_sells, settings } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { logger } from "./logger";
import { eventBus } from "../pipeline/event-bus";
import { nextJob, markScanned, markFailed, startScheduler } from "../pipeline/scheduler";
import { startPriceService } from "../pipeline/price-service";
import { startMetadataService } from "../pipeline/metadata-service";
import { startLifecycleEngine } from "../pipeline/lifecycle-engine";
import { startMomentumEngine } from "../pipeline/momentum-engine";
import { startProjectionEngine } from "../pipeline/projection-engine";
import { startImageService } from "../pipeline/image-service";
import { startSseGateway } from "../pipeline/sse-gateway";
import { startMigrationChecker } from "../pipeline/migration-checker";
import { startHoldersRefresh } from "../pipeline/holders-refresh";
import { startTokenUpdater } from "../pipeline/token-updater";
import { startIntelligenceEngine } from "../pipeline/intelligence-engine";
import { startSecurityService } from "../pipeline/security-service";
import { healthMonitor } from "../pipeline/health-monitor";
import { fetchDexScreener } from "../pipeline/metadata-service";
import { pipelineQueue } from "../lib/job-queue";

// ── Ignore lists ──────────────────────────────────────────────────────────────

const SOLANA_IGNORE = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj",
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
  "he1iusmfkpAdwvxLNGV8Y1iSbj4rAyfzmiUEqLdjoxc",
  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
]);

const EVM_IGNORE = new Set([
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0xdac17f958d2ee523a2206206994597c13d831ec7",
  "0x6b175474e89094c44da98b954eedeac495271d0f",
  "0x4fabb145d64652a948d72533023f6e7a623c7c53",
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
  "0x853d955acef822db058eb8505911ed77f175b99e",
  "0x4200000000000000000000000000000000000006",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
]);

// ── Live status (exported for /api/monitor/status) ────────────────────────────

export interface WalletScanResult {
  address: string; chain: string; label: string;
  status: "ok" | "error" | "no_key" | "pending";
  buysFound: number; lastError: string | null;
}

export interface MonitorStatus {
  running: boolean;
  heliusConfigured: boolean;
  heliusLastError: string | null;
  lastScanAt: string | null;
  nextScanAt: string | null;
  lastScanDurationMs: number | null;
  lastBuysDetected: number;
  totalBuysAllTime: number;
  cycleCount: number;
  walletsTracked: number;
  lastScannedWallets: WalletScanResult[];
  pipeline: { queueSize: number; services: ReturnType<typeof healthMonitor.getAll> };
}

export const monitorStatus: MonitorStatus = {
  running: false, heliusConfigured: false, heliusLastError: null,
  lastScanAt: null, nextScanAt: null, lastScanDurationMs: null,
  lastBuysDetected: 0, totalBuysAllTime: 0, cycleCount: 0,
  walletsTracked: 0, lastScannedWallets: [],
  pipeline: { queueSize: 0, services: [] },
};

// ── Helius (Solana) ───────────────────────────────────────────────────────────

interface HeliusTx {
  signature: string; timestamp: number; type: string;
  tokenTransfers?: Array<{ mint: string; fromUserAccount: string; toUserAccount: string; tokenAmount: number }>;
}

async function fetchHeliusTxs(
  address: string,
  apiKey: string,
  limit = 100,
  attempt = 0,
): Promise<{ txs: HeliusTx[]; error: string | null }> {
  const MAX_ATTEMPTS = 3;
  // Use an explicit AbortController so we can clearTimeout after success,
  // avoiding the "MaxListenersExceededWarning" that leaks with AbortSignal.timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Helius request timed out")), 28_000);
  try {
    const params = new URLSearchParams({ "api-key": apiKey, limit: String(limit) });
    const resp = await fetch(
      `https://api.helius.xyz/v0/addresses/${address}/transactions?${params}`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const isRetryable = resp.status === 429 || resp.status >= 500;
      if (isRetryable && attempt < MAX_ATTEMPTS - 1) {
        const delay = (attempt + 1) * 2_000;
        await new Promise(r => setTimeout(r, delay));
        return fetchHeliusTxs(address, apiKey, limit, attempt + 1);
      }
      return { txs: [], error: `Helius HTTP ${resp.status}: ${text.slice(0, 120)}` };
    }
    const txs = await resp.json() as HeliusTx[];
    return { txs: Array.isArray(txs) ? txs : [], error: null };
  } catch (err: unknown) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError" || err.message.includes("timed out"));
    if (isAbort && attempt < MAX_ATTEMPTS - 1) {
      logger.warn({ wallet: address, attempt }, "Helius request timed out — retrying");
      await new Promise(r => setTimeout(r, (attempt + 1) * 3_000));
      return fetchHeliusTxs(address, apiKey, limit, attempt + 1);
    }
    return { txs: [], error: isAbort ? "Helius request timed out" : String(err) };
  }
}

// ── EVM ───────────────────────────────────────────────────────────────────────

interface EtherscanTx {
  hash: string; to: string; timeStamp: string;
  tokenSymbol?: string; tokenName?: string; contractAddress?: string;
}

function explorerBase(chain: string): string {
  switch (chain) {
    case "base":      return "https://api.basescan.org/api";
    case "bsc":       return "https://api.bscscan.com/api";
    case "polygon":   return "https://api.polygonscan.com/api";
    case "arbitrum":  return "https://api.arbiscan.io/api";
    case "avalanche": return "https://api.snowtrace.io/api";
    default:          return "https://api.etherscan.io/api";
  }
}

async function fetchEvmTxs(address: string, chain: string): Promise<{ txs: EtherscanTx[]; error: string | null }> {
  try {
    const url = `${explorerBase(chain)}?module=account&action=tokentx&address=${address}&sort=desc&page=1&offset=100`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return { txs: [], error: `HTTP ${resp.status}` };
    const json = await resp.json() as { status: string; result: EtherscanTx[]; message?: string };
    if (json.status !== "1") return { txs: [], error: json.message ?? "No results" };
    const incoming = json.result.filter(
      tx => tx.to?.toLowerCase() === address.toLowerCase()
         && tx.contractAddress
         && !EVM_IGNORE.has(tx.contractAddress.toLowerCase()),
    );
    return { txs: incoming, error: null };
  } catch (err) {
    return { txs: [], error: String(err) };
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

const lastSigByWallet = new Map<number, string>();

async function upsertToken(address: string, chain: string, meta: {
  name?: string | null; symbol?: string | null; logoUri?: string | null; priceUsd?: string | null;
}): Promise<number> {
  const existing = await db
    .select({ id: tracked_tokens.id, marketCapUsd: tracked_tokens.marketCapUsd })
    .from(tracked_tokens)
    .where(and(eq(tracked_tokens.address, address), eq(tracked_tokens.chain, chain)))
    .limit(1);

  if (existing.length > 0) {
    const { id, marketCapUsd } = existing[0];
    // Back-fill missing metadata asynchronously
    if (!marketCapUsd) {
      fetchDexScreener(chain, address).then(dex => {
        if (!dex) return;
        return db.update(tracked_tokens).set({
          ...(dex.name        ? { name:        dex.name }        : {}),
          ...(dex.symbol      ? { symbol:      dex.symbol }      : {}),
          ...(dex.logoUri     ? { logoUri:     dex.logoUri }     : {}),
          ...(dex.priceUsd    ? { currentPriceUsd: dex.priceUsd, priceUpdatedAt: new Date() } : {}),
          ...(dex.marketCapUsd ? { marketCapUsd: dex.marketCapUsd } : {}),
          ...(dex.fdvUsd      ? { fdvUsd:      dex.fdvUsd }      : {}),
        }).where(eq(tracked_tokens.id, id));
      }).catch(() => {});
    }
    return id;
  }

  // New token — fetch full metadata immediately
  const dex = await fetchDexScreener(chain, address);
  const [row] = await db.insert(tracked_tokens).values({
    address, chain,
    name:             dex?.name        ?? meta.name        ?? null,
    symbol:           dex?.symbol      ?? meta.symbol      ?? null,
    logoUri:          dex?.logoUri     ?? meta.logoUri     ?? null,
    detectedPriceUsd: dex?.priceUsd    ?? meta.priceUsd    ?? null,
    currentPriceUsd:  dex?.priceUsd    ?? meta.priceUsd    ?? null,
    athPriceUsd:      dex?.priceUsd    ?? meta.priceUsd    ?? null,
    marketCapUsd:     dex?.marketCapUsd ?? null,
    fdvUsd:           dex?.fdvUsd       ?? null,
    liquidityUsd:     dex?.liquidityUsd ?? null,
    volume24hUsd:     dex?.volume24hUsd ?? null,
    tokenCreatedAt:   dex?.tokenCreatedAt ?? null,
    priceUpdatedAt:   dex?.priceUsd ? new Date() : null,
    status:           "new",
    lastBuyAt:        new Date(),
  })
  .onConflictDoUpdate({
    target: [tracked_tokens.address, tracked_tokens.chain],
    set: { name: dex?.name ?? meta.name ?? null, symbol: dex?.symbol ?? meta.symbol ?? null },
  })
  .returning({ id: tracked_tokens.id });

  return row.id;
}

async function recordBuy(opts: {
  walletId: number; tokenId: number;
  priceUsd?: string | null; amount?: string | null;
  txHash?: string | null; boughtAt?: Date;
}): Promise<boolean> {
  if (opts.txHash) {
    const dup = await db.select({ id: token_buys.id }).from(token_buys)
      .where(eq(token_buys.txHash, opts.txHash)).limit(1);
    if (dup.length > 0) return false;
  }
  await db.insert(token_buys).values({
    walletId: opts.walletId, tokenId: opts.tokenId,
    priceUsd: opts.priceUsd ?? null, amount: opts.amount ?? null,
    txHash: opts.txHash ?? null, boughtAt: opts.boughtAt ?? new Date(),
  });
  return true;
}

// ── Per-chain scanners ────────────────────────────────────────────────────────

async function scanSolanaWallet(
  wallet: { id: number; address: string; label: string }, heliusKey: string,
): Promise<WalletScanResult> {
  const result: WalletScanResult = {
    address: wallet.address, chain: "solana", label: wallet.label,
    status: "pending", buysFound: 0, lastError: null,
  };

  const { txs, error } = await fetchHeliusTxs(wallet.address, heliusKey, 100);
  if (error) {
    result.status = "error";
    result.lastError = error;
    monitorStatus.heliusLastError = error;
    logger.warn({ error, wallet: wallet.address }, "Helius fetch error");
    return result;
  }

  monitorStatus.heliusLastError = null;
  const lastKnown = lastSigByWallet.get(wallet.id);

  for (const tx of txs) {
    if (lastKnown && tx.signature === lastKnown) break;
    if (!tx.tokenTransfers?.length) continue;

    const received = tx.tokenTransfers.filter(
      t => t.toUserAccount === wallet.address && t.mint && !SOLANA_IGNORE.has(t.mint),
    );

    for (const transfer of received) {
      const dex = await fetchDexScreener("solana", transfer.mint);
      const tokenId = await upsertToken(transfer.mint, "solana", {
        priceUsd: dex?.priceUsd, name: dex?.name,
        symbol: dex?.symbol, logoUri: dex?.logoUri,
      });
      const boughtAt = tx.timestamp ? new Date(tx.timestamp * 1000) : new Date();
      const recorded = await recordBuy({
        walletId: wallet.id, tokenId,
        priceUsd: dex?.priceUsd ?? null,
        amount: transfer.tokenAmount != null ? String(transfer.tokenAmount) : null,
        txHash: tx.signature, boughtAt,
      });
      if (recorded) {
        result.buysFound++;
        eventBus.emit("token:bought", {
          tokenId, tokenAddress: transfer.mint, chain: "solana",
          walletId: wallet.id, priceUsd: dex?.priceUsd ?? null,
          amount: transfer.tokenAmount != null ? String(transfer.tokenAmount) : null,
          txHash: tx.signature, boughtAt,
        });
      }
    }

    // ── Sell detection (fromUserAccount === wallet) ───────────────────────
    const sold = tx.tokenTransfers.filter(
      t => t.fromUserAccount === wallet.address && t.mint && !SOLANA_IGNORE.has(t.mint),
    );

    for (const transfer of sold) {
      // Only record sells for tokens we already track
      const existing = await db
        .select({ id: tracked_tokens.id })
        .from(tracked_tokens)
        .where(and(eq(tracked_tokens.address, transfer.mint), eq(tracked_tokens.chain, "solana")))
        .limit(1);
      if (!existing.length) continue;

      const tokenId = existing[0].id;
      const soldAt  = tx.timestamp ? new Date(tx.timestamp * 1000) : new Date();

      // Dedup by txHash
      if (tx.signature) {
        const dup = await db.select({ id: token_sells.id }).from(token_sells)
          .where(eq(token_sells.txHash, tx.signature)).limit(1);
        if (dup.length) continue;
      }

      const dex = await fetchDexScreener("solana", transfer.mint).catch(() => null);
      await db.insert(token_sells).values({
        walletId: wallet.id, tokenId,
        priceUsd: dex?.priceUsd ?? null,
        amount:   transfer.tokenAmount != null ? String(transfer.tokenAmount) : null,
        txHash:   tx.signature ?? null,
        soldAt,
      }).onConflictDoNothing();

      await db.update(tracked_tokens)
        .set({ lastSellAt: soldAt })
        .where(eq(tracked_tokens.id, tokenId));

      eventBus.emit("token:sold", {
        tokenId, tokenAddress: transfer.mint, chain: "solana",
        walletId: wallet.id, priceUsd: dex?.priceUsd ?? null,
        amount: transfer.tokenAmount != null ? String(transfer.tokenAmount) : null,
        txHash: tx.signature ?? null, soldAt,
      });
    }
  }

  if (txs[0]) lastSigByWallet.set(wallet.id, txs[0].signature);
  result.status = "ok";
  return result;
}

async function scanEvmWallet(
  wallet: { id: number; address: string; chain: string; label: string },
): Promise<WalletScanResult> {
  const result: WalletScanResult = {
    address: wallet.address, chain: wallet.chain, label: wallet.label,
    status: "pending", buysFound: 0, lastError: null,
  };
  const { txs, error } = await fetchEvmTxs(wallet.address, wallet.chain);
  if (error) { result.status = "error"; result.lastError = error; return result; }

  for (const tx of txs) {
    if (!tx.contractAddress) continue;
    const tokenAddr = tx.contractAddress.toLowerCase();
    const dex = await fetchDexScreener(wallet.chain, tokenAddr);
    const tokenId = await upsertToken(tokenAddr, wallet.chain, {
      name: tx.tokenName ?? dex?.name, symbol: tx.tokenSymbol ?? dex?.symbol,
      logoUri: dex?.logoUri, priceUsd: dex?.priceUsd,
    });
    const boughtAt = tx.timeStamp ? new Date(Number(tx.timeStamp) * 1000) : new Date();
    const recorded = await recordBuy({
      walletId: wallet.id, tokenId, priceUsd: dex?.priceUsd ?? null,
      txHash: tx.hash, boughtAt,
    });
    if (recorded) {
      result.buysFound++;
      eventBus.emit("token:bought", {
        tokenId, tokenAddress: tokenAddr, chain: wallet.chain,
        walletId: wallet.id, priceUsd: dex?.priceUsd ?? null,
        amount: null, txHash: tx.hash, boughtAt,
      });
    }
  }
  result.status = "ok";
  return result;
}

// ── Main scan cycle ───────────────────────────────────────────────────────────

async function getHeliusKey(): Promise<string | null> {
  const rows = await db.select({ value: settings.value }).from(settings)
    .where(eq(settings.key, "helius_api_key")).limit(1);
  return rows[0]?.value?.trim() || process.env.HELIUS_API_KEY?.trim() || null;
}

export async function runScan(): Promise<void> {
  const [allWallets, heliusKey] = await Promise.all([
    db.select().from(walletdatasource),
    getHeliusKey(),
  ]);
  monitorStatus.walletsTracked = allWallets.length;
  monitorStatus.heliusConfigured = !!heliusKey;
  if (!allWallets.length) return;

  const results: WalletScanResult[] = [];
  let cycleBuys = 0;

  // Concurrent scanning — all wallets in parallel
  await Promise.allSettled(allWallets.map(async (w) => {
    try {
      let r: WalletScanResult;
      if (w.chain === "solana") {
        if (!heliusKey) {
          r = { address: w.address, chain: "solana", label: w.label,
                status: "no_key", buysFound: 0, lastError: "Helius API key not configured" };
          await markFailed(w.id, "no_key");
        } else {
          r = await scanSolanaWallet(w, heliusKey);
          if (r.status === "ok") await markScanned(w.id);
          else await markFailed(w.id, r.lastError ?? "unknown");
        }
      } else {
        r = await scanEvmWallet(w);
        if (r.status === "ok") await markScanned(w.id);
        else await markFailed(w.id, r.lastError ?? "unknown");
      }
      results.push(r);
      cycleBuys += r.buysFound;
    } catch (err) {
      logger.error({ err, walletId: w.id }, "Wallet scan threw");
      results.push({ address: w.address, chain: w.chain, label: w.label,
                     status: "error", buysFound: 0, lastError: String(err) });
      await markFailed(w.id, String(err));
    }
  }));

  const [totalRow] = await db.select({ c: count() }).from(token_buys);
  monitorStatus.totalBuysAllTime = Number(totalRow?.c ?? 0);
  monitorStatus.lastBuysDetected = cycleBuys;
  monitorStatus.lastScannedWallets = results;
  monitorStatus.pipeline = {
    queueSize: pipelineQueue.totalWaiting(),
    services: healthMonitor.getAll(),
  };
}

// ── Startup ───────────────────────────────────────────────────────────────────

const CYCLE_MS = 2 * 60 * 1000;

export function startMonitor(): void {
  monitorStatus.running = true;

  // Start all pipeline services
  startTokenUpdater();
  startScheduler();
  startPriceService();
  startMetadataService();
  startLifecycleEngine();
  startMomentumEngine();
  startProjectionEngine();
  startImageService();
  startSseGateway();
  startMigrationChecker();
  startHoldersRefresh();
  startIntelligenceEngine();
  startSecurityService();

  logger.info("Token Intelligence Pipeline started");

  const loop = async (): Promise<void> => {
    const start = Date.now();
    monitorStatus.cycleCount++;
    logger.info({ cycle: monitorStatus.cycleCount }, "Scan cycle starting");

    try {
      await runScan();
    } catch (err) {
      logger.error({ err }, "Scan cycle error");
    }

    const elapsed = Date.now() - start;
    const waitMs  = Math.max(0, CYCLE_MS - elapsed);
    monitorStatus.lastScanAt  = new Date().toISOString();
    monitorStatus.lastScanDurationMs = elapsed;
    monitorStatus.nextScanAt  = new Date(Date.now() + waitMs).toISOString();

    logger.info({ cycle: monitorStatus.cycleCount, elapsedMs: elapsed, buysFound: monitorStatus.lastBuysDetected }, "Scan cycle complete");
    setTimeout(loop, waitMs);
  };

  setTimeout(loop, 5_000);
}
