/**
 * Crypsor wallet intel report client — search + enrich + labels/WR.
 */
import { apiFetch, ApiError } from "@/lib/api-fetch";

type Envelope<T> = { ok: boolean; data?: T; error?: string };

async function wiFetch<T>(path: string): Promise<T> {
  const body = await apiFetch<Envelope<T> | T>(path, { timeoutMs: 45_000 });
  if (body && typeof body === "object" && "ok" in body) {
    const env = body as Envelope<T>;
    if (!env.ok || env.data === undefined) {
      throw new ApiError(env.error || "Wallet intel error", 0);
    }
    return env.data;
  }
  return body as T;
}

export type WalletGmgnProfile = {
  labels: string[];
  twitterName: string | null;
  twitterUsername: string | null;
  totalPnlUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  winRate: number | null;
  avgHoldTimeSec: number | null;
  totalTradeCount: number | null;
  solBalance: number | null;
  profileFetchedAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

export type CrypsorIntel = {
  ourLabel: string;
  behaviourScore: number;
  weightage: number;
  winRate: number | null;
  wins: number;
  losses: number;
  tokensSeen: number;
  sightings: number;
  avgHoldPct: number | null;
  lastReason: string | null;
  lastTokenId: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

export type WalletTokenEvent = {
  role: string;
  ourLabelAt: string | null;
  behaviourScoreAt: number | null;
  holdPct: number | null;
  buyCount: number | null;
  sellCount: number | null;
  realizedPnl: number | null;
  tokenId: number;
  symbol: string | null;
  name: string | null;
  tokenAddress: string | null;
  calledAt: string | null;
  athMultiple: number | null;
  hit2x: boolean | null;
  qualityLabel: string | null;
  entryServed: boolean;
  updatedAt: string | null;
};

export type WalletIntelReport = {
  walletAddress: string;
  chain: string;
  refreshed: boolean;
  enrichOk: boolean | null;
  gmgn: WalletGmgnProfile | null;
  crypsor: CrypsorIntel | null;
  liveJudgment: {
    ourLabel: string;
    behaviourScore: number;
    holdPct: number;
    buyCount: number;
    sellCount: number;
    reason: string;
    weightDelta: number;
    tokenId: number | null;
    symbol: string | null;
    note: string;
  } | null;
  summary: {
    observedTokens: number;
    winEvents: number;
    lossEvents: number;
    trackedBuys: number;
  };
  events: WalletTokenEvent[];
  trackedBuys: Array<{
    tokenId: number;
    symbol: string | null;
    tokenAddress: string | null;
    boughtAt: string | null;
    amount: string | null;
    priceUsd: string | null;
    athMultiple: number | null;
    hit2x: boolean | null;
  }>;
  note?: string;
  fetchedAt: string;
};

export const WALLET_INTEL_KEY = (address: string, refresh: boolean) =>
  ["wallet-intel", address, refresh ? "refresh" : "db"] as const;

/** Fast path — DB only (no GMGN wait). */
export function fetchWalletIntelReport(address: string, refresh = false) {
  const q = refresh ? "?refresh=1" : "";
  return wiFetch<WalletIntelReport>(
    `api/wallet-intel/${encodeURIComponent(address)}${q}`,
  );
}

/** Slow path — GMGN enrich + persist (call after UI already painted). */
export function enrichWalletIntelReport(address: string) {
  return wiFetch<WalletIntelReport>(
    `api/wallet-intel/${encodeURIComponent(address)}?refresh=1`,
  );
}
