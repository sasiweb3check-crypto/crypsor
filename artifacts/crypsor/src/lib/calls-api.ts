/**
 * Best Calls client — FOMO-style desk cards.
 */
import { apiFetch, ApiError } from "@/lib/api-fetch";

type Envelope<T> = { ok: boolean; data?: T; error?: string };

async function callsFetch<T>(path: string): Promise<T> {
  const body = await apiFetch<Envelope<T> | T>(path);
  if (body && typeof body === "object" && "ok" in body) {
    const env = body as Envelope<T>;
    if (!env.ok || env.data === undefined) {
      throw new ApiError(env.error || "Calls API error", 0);
    }
    return env.data;
  }
  return body as T;
}

export type CallLabel = "elite" | "strong" | "watch" | "noise";

export type CallCard = {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  calledAt: string | null;
  calledMcUsd: number | null;
  currentMcUsd: number | null;
  athMcUsd: number | null;
  gainPct: number | null;
  nowMultiple: number;
  athMultiple: number;
  walletBuys: number;
  buyVolumeHintUsd: number | null;
  calledKol: number;
  calledSmart: number;
  liveKol: number;
  liveSmart: number;
  holderCount: number | null;
  avgWalletWinRate: number | null;
  holderQualityScore: number | null;
  proScore: number;
  qualityLabel: string;
  callScore: number;
  callLabel: CallLabel;
  reasons: string[];
  hit2x: boolean;
  hit5x: boolean;
  hit10x: boolean;
  volume24hUsd: number | null;
  tokenAgeMin: number | null;
  socials: { twitter?: string; telegram?: string; website?: string };
};

export type CallStats = {
  winRate: number;
  wins: number;
  signals: number;
  wins5x: number;
  wins10x: number;
  avgX: number;
  bestX: number;
  bestSymbol: string | null;
  universe?: number;
};

export type CallMode = "best" | "latest" | "hot";

export const CALLS_FEED_KEY = (mode: CallMode) => ["calls-feed", mode] as const;
export const CALLS_STATS_KEY = ["calls-stats"] as const;

export function fetchCallsFeed(mode: CallMode = "best", limit = 40) {
  return callsFetch<{
    cards: CallCard[];
    total: number;
    universe: number;
    mode: string;
    note?: string;
  }>(`api/calls/feed?mode=${mode}&limit=${limit}`);
}

export function fetchCallsStats() {
  return callsFetch<CallStats>("api/calls/stats");
}
