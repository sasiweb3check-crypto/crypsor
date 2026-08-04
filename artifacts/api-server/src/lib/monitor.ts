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
import { eq, and, count, gte, lte } from "drizzle-orm";
import { logger } from "./logger";
import { eventBus } from "../pipeline/event-bus";
import { claimDueBatch, markScanned, markFailed, startScheduler } from "../pipeline/scheduler";
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
import { startCtoScan } from "../pipeline/cto-scan";
import { startCallerAlerts } from "../pipeline/caller-alerts";
import { startProScanner }  from "../pipeline/pro-scanner";
import { startProSnapshots } from "../pipeline/pro-snapshots";
import { startDexAgent } from "../pipeline/dex-agent";
import { startPumpBuyScanner } from "../pipeline/pump-buy-scanner";
import { startPumpAlerts } from "../pipeline/pump-alerts";
import { healthMonitor } from "../pipeline/health-monitor";
import { fetchDexScreener } from "../pipeline/metadata-service";
import { pipelineQueue } from "../lib/job-queue";
import { opsLog } from "./ops-log";
import {
  SOLANA_BLOCKED_MINTS,
  checkSolanaMemecoinBuy,
  isBlockedMint,
  isTransientDexGateReason,
} from "./solana-memecoin-gate";

// ── Ignore lists ──────────────────────────────────────────────────────────────

const SOLANA_IGNORE = SOLANA_BLOCKED_MINTS;

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
  /** Permanent memecoin-gate rejects (blocked / no SOL-USDC / MC). */
  gateSkipped?: number;
  /** Buys recorded while Dex was down/rate-limited (fail-open). */
  gateFailOpen?: number;
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
): Promise<{ txs: HeliusTx[]; error: string | null; latencyMs: number }> {
  const MAX_ATTEMPTS = 3;
  const t0 = Date.now();
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
    const latencyMs = Date.now() - t0;
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const isRetryable = resp.status === 429 || resp.status >= 500;
      if (isRetryable && attempt < MAX_ATTEMPTS - 1) {
        const delay = (attempt + 1) * 2_000;
        await new Promise(r => setTimeout(r, delay));
        return fetchHeliusTxs(address, apiKey, limit, attempt + 1);
      }
      const error = `Helius HTTP ${resp.status}: ${text.slice(0, 120)}`;
      opsLog("helius", "error", error, { wallet: address.slice(0, 8), status: resp.status }, latencyMs);
      healthMonitor.error("helius-scanner", error);
      return { txs: [], error, latencyMs };
    }
    const txs = await resp.json() as HeliusTx[];
    healthMonitor.ok("helius-scanner", latencyMs);
    // Success is aggregated in scan-cycle opsLog — avoid flooding per wallet
    if (latencyMs > 8_000) {
      opsLog("helius", "warn", `Helius slow · ${latencyMs}ms`, { wallet: address.slice(0, 8) }, latencyMs);
    }
    return { txs: Array.isArray(txs) ? txs : [], error: null, latencyMs };
  } catch (err: unknown) {
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;
    const isAbort = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError" || err.message.includes("timed out"));
    if (isAbort && attempt < MAX_ATTEMPTS - 1) {
      logger.warn({ wallet: address, attempt }, "Helius request timed out — retrying");
      await new Promise(r => setTimeout(r, (attempt + 1) * 3_000));
      return fetchHeliusTxs(address, apiKey, limit, attempt + 1);
    }
    const error = isAbort ? "Helius request timed out" : String(err);
    opsLog("helius", "error", error, { wallet: address.slice(0, 8) }, latencyMs);
    healthMonitor.error("helius-scanner", error);
    return { txs: [], error, latencyMs };
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
const CURSOR_KEY = (walletId: number) => `helius_cursor:${walletId}`;

async function loadHeliusCursor(walletId: number): Promise<string | null> {
  const mem = lastSigByWallet.get(walletId);
  if (mem) return mem;
  try {
    const rows = await db.select({ value: settings.value }).from(settings)
      .where(eq(settings.key, CURSOR_KEY(walletId))).limit(1);
    const sig = rows[0]?.value?.trim() || null;
    if (sig) lastSigByWallet.set(walletId, sig);
    return sig;
  } catch {
    return null;
  }
}

async function saveHeliusCursor(walletId: number, signature: string): Promise<void> {
  lastSigByWallet.set(walletId, signature);
  try {
    await db.insert(settings).values({
      key: CURSOR_KEY(walletId),
      value: signature,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: settings.key,
      set: { value: signature, updatedAt: new Date() },
    });
  } catch {
    /* non-fatal — memory cursor still advances this process */
  }
}

function enrichTokenAsync(tokenId: number, chain: string, address: string): void {
  fetchDexScreener(chain, address).then(dex => {
    if (!dex) return;
    return db.update(tracked_tokens).set({
      ...(dex.name         ? { name: dex.name } : {}),
      ...(dex.symbol       ? { symbol: dex.symbol } : {}),
      ...(dex.logoUri      ? { logoUri: dex.logoUri } : {}),
      ...(dex.priceUsd     ? {
        detectedPriceUsd: dex.priceUsd,
        currentPriceUsd: dex.priceUsd,
        athPriceUsd: dex.priceUsd,
        priceUpdatedAt: new Date(),
      } : {}),
      ...(dex.marketCapUsd ? { marketCapUsd: dex.marketCapUsd } : {}),
      ...(dex.fdvUsd       ? { fdvUsd: dex.fdvUsd } : {}),
      ...(dex.liquidityUsd ? { liquidityUsd: dex.liquidityUsd } : {}),
      ...(dex.volume24hUsd ? { volume24hUsd: dex.volume24hUsd } : {}),
      ...(dex.tokenCreatedAt ? { tokenCreatedAt: dex.tokenCreatedAt } : {}),
    }).where(eq(tracked_tokens.id, tokenId));
  }).catch(() => {});
}

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
    // Re-buy: keep lastBuyAt fresh so desk/intel see ongoing activity
    await db.update(tracked_tokens).set({
      lastBuyAt: new Date(),
      ...(meta.symbol ? { symbol: meta.symbol } : {}),
      ...(meta.name ? { name: meta.name } : {}),
      ...(meta.logoUri ? { logoUri: meta.logoUri } : {}),
    }).where(eq(tracked_tokens.id, id)).catch(() => {});
    // Back-fill missing metadata asynchronously — never block the scan loop
    if (!marketCapUsd) enrichTokenAsync(id, chain, address);
    return id;
  }

  // Insert immediately. Dex enrichment is async so cold-start / many new mints
  // cannot hang the wallet scan (previously awaited DexScreener 12s×3 each).
  const [row] = await db.insert(tracked_tokens).values({
    address, chain,
    name:             meta.name        ?? null,
    symbol:           meta.symbol      ?? null,
    logoUri:          meta.logoUri     ?? null,
    detectedPriceUsd: meta.priceUsd    ?? null,
    currentPriceUsd:  meta.priceUsd    ?? null,
    athPriceUsd:      meta.priceUsd    ?? null,
    marketCapUsd:     null,
    fdvUsd:           null,
    liquidityUsd:     null,
    volume24hUsd:     null,
    tokenCreatedAt:   null,
    priceUpdatedAt:   meta.priceUsd ? new Date() : null,
    status:           "new",
    lastBuyAt:        new Date(),
  })
  .onConflictDoUpdate({
    target: [tracked_tokens.address, tracked_tokens.chain],
    // Never null-out enriched name/symbol on a race with a partial meta insert
    set: {
      lastBuyAt: new Date(),
      ...(meta.name ? { name: meta.name } : {}),
      ...(meta.symbol ? { symbol: meta.symbol } : {}),
    },
  })
  .returning({ id: tracked_tokens.id });

  enrichTokenAsync(row.id, chain, address);
  return row.id;
}

async function recordBuy(opts: {
  walletId: number; tokenId: number;
  priceUsd?: string | null; amount?: string | null;
  txHash?: string | null; boughtAt?: Date;
}): Promise<boolean> {
  try {
    if (opts.txHash) {
      // One Solana tx can include multiple mints — dedup per wallet+token+tx
      const dup = await db.select({ id: token_buys.id }).from(token_buys)
        .where(and(
          eq(token_buys.walletId, opts.walletId),
          eq(token_buys.tokenId, opts.tokenId),
          eq(token_buys.txHash, opts.txHash),
        )).limit(1);
      if (dup.length > 0) return false;
    } else if (opts.boughtAt) {
      // No signature — soft-dedup same wallet/token within 2s window
      const windowStart = new Date(opts.boughtAt.getTime() - 2_000);
      const windowEnd = new Date(opts.boughtAt.getTime() + 2_000);
      const dup = await db.select({ id: token_buys.id }).from(token_buys)
        .where(and(
          eq(token_buys.walletId, opts.walletId),
          eq(token_buys.tokenId, opts.tokenId),
          gte(token_buys.boughtAt, windowStart),
          lte(token_buys.boughtAt, windowEnd),
        )).limit(1);
      if (dup.length > 0) return false;
    }
    await db.insert(token_buys).values({
      walletId: opts.walletId, tokenId: opts.tokenId,
      priceUsd: opts.priceUsd ?? null, amount: opts.amount ?? null,
      txHash: opts.txHash ?? null, boughtAt: opts.boughtAt ?? new Date(),
    });
    return true;
  } catch (err) {
    // Transient DB blips (connection drop mid-dedup) must not fail the whole wallet scan.
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate|unique/i.test(msg)) return false;
    logger.warn(
      { err: msg.slice(0, 180), walletId: opts.walletId, tokenId: opts.tokenId },
      "recordBuy failed — skip tx, continue scan",
    );
    opsLog("helius", "warn", `Buy record fail · wallet ${opts.walletId}`, {
      tokenId: opts.tokenId,
      err: msg.slice(0, 100),
    });
    return false;
  }
}

// ── Per-chain scanners ────────────────────────────────────────────────────────

async function scanSolanaWallet(
  wallet: { id: number; address: string; label: string }, heliusKey: string,
): Promise<WalletScanResult> {
  const result: WalletScanResult = {
    address: wallet.address, chain: "solana", label: wallet.label,
    status: "pending", buysFound: 0, lastError: null,
    gateSkipped: 0, gateFailOpen: 0,
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
  const lastKnown = await loadHeliusCursor(wallet.id);
  // True cold start = never seen this wallet (no persisted cursor). Seed only
  // a small window so we do not re-walk history after every deploy.
  // After restart with a persisted cursor, process everything newer than it.
  const coldStart = !lastKnown;
  if (coldStart && txs[0]) {
    await saveHeliusCursor(wallet.id, txs[0].signature);
  }
  let walked = 0;
  const maxWalk = coldStart ? 12 : 100;
  /** If a soft-deny still happens, do not advance cursor past that sig. */
  let holdCursor = false;

  for (const tx of txs) {
    if (!coldStart && lastKnown && tx.signature === lastKnown) break;
    if (walked >= maxWalk) break;
    walked++;
    if (!tx.tokenTransfers?.length) continue;

    const received = tx.tokenTransfers.filter(
      t => t.toUserAccount === wallet.address && t.mint && !SOLANA_IGNORE.has(t.mint),
    );

    for (const transfer of received) {
      if (isBlockedMint(transfer.mint)) continue;
      // SOL/USDC pair + symbol/MC gate — skip stables, cbBTC, USD1, etc.
      const gate = await checkSolanaMemecoinBuy(transfer.mint);
      if (!gate.ok) {
        // Belt: never permanently drop on a transient Dex failure via cursor advance.
        if (isTransientDexGateReason(gate.reason)) {
          holdCursor = true;
          opsLog("wallet_buy", "warn", `Hold cursor · transient Dex · ${gate.reason}`, {
            mint: transfer.mint.slice(0, 8),
            walletId: wallet.id,
          });
          continue;
        }
        result.gateSkipped = (result.gateSkipped ?? 0) + 1;
        opsLog("wallet_buy", "info", `Skipped non-meme · ${gate.reason}`, {
          mint: transfer.mint.slice(0, 8),
          symbol: gate.symbol ?? null,
        });
        continue;
      }
      if (gate.reason?.includes("failopen")) {
        result.gateFailOpen = (result.gateFailOpen ?? 0) + 1;
      }
      // No Dex await for enrich — upsert enriches async; metadata-service also listens.
      const tokenId = await upsertToken(transfer.mint, "solana", {
        symbol: gate.symbol ?? null,
      });
      const boughtAt = tx.timestamp ? new Date(tx.timestamp * 1000) : new Date();
      const recorded = await recordBuy({
        walletId: wallet.id, tokenId,
        priceUsd: null,
        amount: transfer.tokenAmount != null ? String(transfer.tokenAmount) : null,
        txHash: tx.signature, boughtAt,
      });
      if (recorded) {
        result.buysFound++;
        opsLog("wallet_buy", "info", `Buy · ${wallet.label || wallet.address.slice(0, 6)}`, {
          mint: transfer.mint.slice(0, 8),
          walletId: wallet.id,
          symbol: gate.symbol ?? null,
          failOpen: gate.reason?.includes("failopen") ?? false,
        });
        eventBus.emit("token:bought", {
          tokenId, tokenAddress: transfer.mint, chain: "solana",
          walletId: wallet.id, priceUsd: null,
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

      await db.insert(token_sells).values({
        walletId: wallet.id, tokenId,
        priceUsd: null,
        amount:   transfer.tokenAmount != null ? String(transfer.tokenAmount) : null,
        txHash:   tx.signature ?? null,
        soldAt,
      }).onConflictDoNothing();

      await db.update(tracked_tokens)
        .set({ lastSellAt: soldAt })
        .where(eq(tracked_tokens.id, tokenId));

      eventBus.emit("token:sold", {
        tokenId, tokenAddress: transfer.mint, chain: "solana",
        walletId: wallet.id, priceUsd: null,
        amount: transfer.tokenAmount != null ? String(transfer.tokenAmount) : null,
        txHash: tx.signature ?? null, soldAt,
      });
    }
  }

  // Never advance past buys we could not classify due to Dex outages.
  if (txs[0] && !holdCursor) await saveHeliusCursor(wallet.id, txs[0].signature);
  else if (holdCursor) {
    opsLog("helius", "warn", `Cursor held · Dex transient on ${wallet.label || wallet.address.slice(0, 6)}`, {
      walletId: wallet.id,
    });
  }
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

const MAX_WALLETS_PER_CYCLE = 30;

export async function runScan(): Promise<void> {
  monitorStatus.pipeline = {
    queueSize: pipelineQueue.totalWaiting(),
    services: healthMonitor.getAll(),
  };
  const [walletCountRow, heliusKey, dueWallets] = await Promise.all([
    db.select({ c: count() }).from(walletdatasource),
    getHeliusKey(),
    claimDueBatch(MAX_WALLETS_PER_CYCLE),
  ]);
  monitorStatus.walletsTracked = Number(walletCountRow[0]?.c ?? 0);
  monitorStatus.heliusConfigured = !!heliusKey;
  // Heartbeat so Ops does not look "blank" while a long cycle runs
  monitorStatus.lastScanAt = monitorStatus.lastScanAt ?? new Date().toISOString();
  if (!monitorStatus.walletsTracked) return;

  const results: WalletScanResult[] = [];
  let cycleBuys = 0;

  // Due wallets only (scheduler next_scan_at + backoff) — not all wallets every cycle
  await Promise.allSettled(dueWallets.map(async (w) => {
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

  const errWallets = results.filter(r => r.status === "error" || r.status === "no_key");
  const gateSkipped = results.reduce((n, r) => n + (r.gateSkipped ?? 0), 0);
  const gateFailOpen = results.reduce((n, r) => n + (r.gateFailOpen ?? 0), 0);
  opsLog(
    "scan",
    errWallets.length || gateFailOpen > 0 ? "warn" : "info",
    `Scan cycle · ${cycleBuys} new buys · ${results.length}/${monitorStatus.walletsTracked} due wallets` +
      (errWallets.length ? ` · ${errWallets.length} errors` : "") +
      (gateSkipped ? ` · ${gateSkipped} non-meme skipped` : "") +
      (gateFailOpen ? ` · ${gateFailOpen} Dex fail-open` : ""),
    {
      buys: cycleBuys,
      wallets: results.length,
      tracked: monitorStatus.walletsTracked,
      errors: errWallets.length,
      sampleError: errWallets[0]?.lastError ?? null,
      gateSkipped,
      gateFailOpen,
    },
  );
  if (!heliusKey) {
    const last = (runScan as { _lastNoKey?: number })._lastNoKey ?? 0;
    if (Date.now() - last > 300_000) {
      (runScan as { _lastNoKey?: number })._lastNoKey = Date.now();
      opsLog("blocker", "error", "Helius key missing — Solana buys silent", {
        wallets: dueWallets.filter(w => w.chain === "solana").length,
      });
    }
  }
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
  // ── LEGACY BACKUP (Crypsor scoring + GMGN) — off by default ──────────────
  // Set CRYPSOR_LEGACY_PIPELINE=1 to re-enable holders GMGN / intel / pro / dex.
  // Active desk uses pump-buy-scanner only (pump-fullend scoring).
  const legacyOn = process.env.CRYPSOR_LEGACY_PIPELINE === "1";
  if (legacyOn) {
    startHoldersRefresh();
    startIntelligenceEngine();
    startSecurityService();
    startCtoScan();
    startCallerAlerts();
    startProScanner();
    startProSnapshots();
    startDexAgent();
    logger.warn("CRYPSOR_LEGACY_PIPELINE=1 — GMGN + Crypsor scoring services enabled");
  } else {
    logger.info("Legacy GMGN/Crypsor scoring pipeline DISABLED — pump-sdk desk active");
  }
  startPumpBuyScanner();
  startPumpAlerts();
  healthMonitor.startWatchdog();

  logger.info("Token Intelligence Pipeline started (pump-sdk primary)");

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
