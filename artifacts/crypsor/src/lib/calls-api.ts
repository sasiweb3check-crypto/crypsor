/**
 * Pump-SDK desk client — buy-sourced tokens + pump-fullend scoring/filters.
 * Crypsor elite/strong scoring is legacy (not used on the active desk).
 */
import { apiFetch, ApiError } from "@/lib/api-fetch";

type Envelope<T> = { ok: boolean; data?: T; error?: string };

async function callsFetch<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const body = await apiFetch<Envelope<T> | T>(path, { timeoutMs: 45_000, ...init });
  if (body && typeof body === "object" && "ok" in body) {
    const env = body as Envelope<T>;
    if (!env.ok || env.data === undefined) {
      throw new ApiError(env.error || "Calls API error", 0);
    }
    return env.data;
  }
  return body as T;
}

export type PumpGrade = "S" | "A" | "B" | "C" | "D";
export type PumpBuySignal = "STRONG_BUY" | "WATCH";
export type PumpIntraSignal = "INTRA_NOW" | "INTRA_SOON";
export type PumpTag = { label: string; type: "positive" | "warning" | "negative" };

export type PumpFilterId =
  | "all" | "top" | "intra" | "buy" | "watch"
  | "micro" | "new" | "volume" | "dev" | "gained";

export type PumpSortId =
  | "score" | "gain_now" | "ath_gain" | "volume"
  | "price_change" | "newest" | "oldest_detect" | "txns";

/** @deprecated Crypsor label — kept for type compat only */
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
  volumeIntensityScore: number | null;
  gain1hPct: number | null;
  mc1hUsd?: number | null;
  momentum1h: number;
  momentum6h: number;
  tokenAgeMin: number | null;
  ctoFlag: boolean | null;
  creatorClose: boolean | null;
  creatorAddress: string | null;
  creatorCreatedCount: number | null;
  graduated?: boolean;
  creatorUsername?: string | null;
  pumpAthMcUsd?: number | null;
  socials: { twitter?: string; telegram?: string; website?: string };
  entryServed?: boolean;
  properServe?: boolean;
  pumpScore?: number | null;
  pumpGrade?: PumpGrade | null;
  pumpBuySignal?: PumpBuySignal | null;
  pumpIntraSignal?: PumpIntraSignal | null;
  pumpTags?: PumpTag[];
  pumpRecommendation?: string | null;
  pumpMarketCap?: number | null;
  pumpLiquidityUsd?: number | null;
  pumpVolume24h?: number | null;
  pumpTxns24h?: number | null;
  pumpPairCreatedAt?: number | null;
  pumpPriceChange24h?: number | null;
  pumpGainSinceDetection?: number | null;
  pumpAthGain?: number | null;
  pumpDetectedAt?: number | null;
  pumpPriceAtDetection?: number | null;
  pumpMcAtDetection?: number | null;
  pumpAthMc?: number | null;
  pumpMcGainSinceDetection?: number | null;
  pumpAthMcGain?: number | null;
  pumpSocialSignal?: number | null;
  pumpFreshness?: number | null;
  pumpBuyPassCount?: number | null;
  pumpIntraPassCount?: number | null;
};

export type StatsPeriod = "1d" | "3d" | "5d" | "7d" | "30d";

export type CallStats = {
  period?: StatsPeriod | string;
  days?: number;
  scope?: string;
  winRate: number;
  wins: number;
  signals: number;
  wins5x: number;
  wins10x: number;
  avgX: number;
  bestX: number;
  bestSymbol: string | null;
  note?: string;
  universe?: number;
};

/** Filter presets — pump-fullend FilterBar (compact labels for mobile) */
export const PUMP_FILTER_PRESETS: { id: PumpFilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "top", label: "S+A" },
  { id: "intra", label: "Intra" },
  { id: "buy", label: "Buy" },
  { id: "watch", label: "Watch" },
  { id: "micro", label: "Micro" },
  { id: "new", label: "New" },
  { id: "volume", label: "Vol" },
  { id: "dev", label: "Dev" },
  { id: "gained", label: "Gained" },
];

export const PUMP_SORT_OPTIONS: { id: PumpSortId; label: string }[] = [
  { id: "score", label: "Score" },
  { id: "gain_now", label: "Gain" },
  { id: "ath_gain", label: "ATH" },
  { id: "newest", label: "Created" },
  { id: "oldest_detect", label: "Detected" },
  { id: "volume", label: "Volume" },
  { id: "txns", label: "Txns" },
  { id: "price_change", label: "Price %" },
];

/** Pair / creation age caps (minutes). 0 = any */
export const PAIR_AGE_OPTIONS: { id: number; label: string }[] = [
  { id: 0, label: "Any age" },
  { id: 15, label: "<15m" },
  { id: 60, label: "<1h" },
  { id: 360, label: "<6h" },
  { id: 1440, label: "<24h" },
];

/** Detection age caps (minutes). 0 = any */
export const DETECT_AGE_OPTIONS: { id: number; label: string }[] = [
  { id: 0, label: "Any detect" },
  { id: 30, label: "Detect <30m" },
  { id: 120, label: "Detect <2h" },
  { id: 360, label: "Detect <6h" },
  { id: 1440, label: "Detect <24h" },
];

export const FILTER_BLURB: Record<PumpFilterId, string> = {
  all: "Buy-sourced · pump score",
  top: "S + A grade",
  intra: "Intraday window",
  buy: "Ready to buy",
  watch: "Watch closely",
  micro: "Under $50K MC",
  new: "Created <2h",
  volume: "Vol ≥ $50K",
  dev: "Dev narrative",
  gained: "≥50% since detect",
};

export type FeedPage = {
  cards: CallCard[];
  total: number;
  page: number;
  pages: number;
  limit: number;
  universe: number;
  mode: string;
  filter?: string;
  sort?: string;
  minScore?: number;
  maxPairAgeMin?: number | null;
  maxDetectAgeMin?: number | null;
  note?: string;
  pendingFirstCalls?: number;
};

/** Keep pages small for mobile + SSE friendliness */
export const PAGE_SIZE = 12;

export const CALLS_FEED_KEY = (
  filter: PumpFilterId,
  sort: PumpSortId,
  page: number,
  minScore: number,
  maxPairAgeMin = 0,
  maxDetectAgeMin = 0,
) => ["calls-feed", "pump", filter, sort, page, minScore, maxPairAgeMin, maxDetectAgeMin] as const;

export const CALLS_STATS_KEY = (period: StatsPeriod = "7d") => ["calls-stats", period] as const;
export const CALLS_WAITING_KEY = ["calls-waiting"] as const;

export function fetchCallsFeed(
  filter: PumpFilterId = "all",
  page = 1,
  limit = PAGE_SIZE,
  sort: PumpSortId = "score",
  minScore = 0,
  maxPairAgeMin = 0,
  maxDetectAgeMin = 0,
) {
  const qs = new URLSearchParams();
  qs.set("filter", filter);
  qs.set("sort", sort);
  qs.set("page", String(page));
  qs.set("limit", String(limit));
  if (minScore > 0) qs.set("minScore", String(minScore));
  if (maxPairAgeMin > 0) qs.set("maxPairAgeMin", String(maxPairAgeMin));
  if (maxDetectAgeMin > 0) qs.set("maxDetectAgeMin", String(maxDetectAgeMin));
  return callsFetch<FeedPage>(`api/calls/feed?${qs.toString()}`);
}

/** Legacy waiting lane — still used by Ops panel (Crypsor ENTRY hold queue). */
export function fetchCallsWaiting(limit = PAGE_SIZE, page = 1) {
  const qs = new URLSearchParams();
  qs.set("page", String(page));
  qs.set("limit", String(limit));
  return callsFetch<{
    cards: CallCard[];
    total: number;
    page: number;
    pages: number;
    limit: number;
    pendingFirstCalls: number;
    note?: string;
  }>(`api/calls/waiting?${qs.toString()}`);
}

export function fetchCallsStats(period: StatsPeriod = "7d") {
  return callsFetch<CallStats>(`api/calls/stats?period=${period}`);
}

export type CallBuyer = {
  walletId: number;
  address: string;
  label: string;
  boughtAt: string | null;
  winRate: number | null;
  amount: string | null;
  priceUsd: string | null;
};

export type CallSnap = {
  at: string | null;
  mcUsd: number | null;
  athMultiple: number | null;
  kol: number | null;
  smart: number | null;
};

export type CrypsorWalletRow = {
  walletAddress: string;
  ourLabel: string;
  behaviourScore: number;
  weightage: number;
  winRate: number | null;
};

export const CALLS_TOKEN_KEY = (id: number, winrate = false) =>
  ["calls-token", id, winrate ? "wr" : "lite"] as const;

export function fetchCallDetail(tokenId: number, opts?: { winrate?: boolean }) {
  const qs = opts?.winrate ? "?winrate=1" : "";
  return callsFetch<{
    card: CallCard | null;
    buyers: CallBuyer[];
    snaps: CallSnap[];
    crypsorWallets?: CrypsorWalletRow[];
    winrateLoaded?: boolean;
  }>(`api/calls/token/${tokenId}${qs}`);
}

/** Client-side re-sort helper (SSE MC patches). */
export function sortByPumpScore(cards: CallCard[]): CallCard[] {
  return [...cards].sort((a, b) => (b.pumpScore ?? 0) - (a.pumpScore ?? 0));
}
