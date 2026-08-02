/**
 * Best Calls client — lightweight paginated table desk.
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
  volumeIntensityScore: number | null;
  /** 1h MC % change vs snapshot — independent of entry */
  gain1hPct: number | null;
  momentum1h: number;
  momentum6h: number;
  tokenAgeMin: number | null;
  ctoFlag: boolean | null;
  creatorClose: boolean | null;
  creatorAddress: string | null;
  creatorCreatedCount: number | null;
  socials: { twitter?: string; telegram?: string; website?: string };
  entryServed?: boolean;
  properServe?: boolean;
  /** Present on Waiting lane */
  runnerPhase?: string;
  runnerScore?: number;
  runnerLabel?: string;
  alertEligible?: boolean;
  blockers?: string[];
  snapCount?: number;
  snapsNeeded?: number;
  observationReady?: boolean;
  holdReason?: string;
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
  deskRaw?: number;
  telegramN?: number;
  note?: string;
  universe?: number;
};

export type CallMode = "best" | "latest" | "hot" | "waiting";

export type FeedFilters = {
  label?: string;
  quality?: string;
  minScore?: number;
  minVol1h?: number;
  minGain1h?: number;
  minMom1h?: number;
  minMom6h?: number;
};

export type FeedPage = {
  cards: CallCard[];
  total: number;
  page: number;
  pages: number;
  limit: number;
  universe: number;
  mode: string;
  note?: string;
  pendingFirstCalls?: number;
};

export const PAGE_SIZE = 20;

export const CALLS_FEED_KEY = (
  mode: CallMode,
  page: number,
  filters: FeedFilters,
) => ["calls-feed", mode, page, filters] as const;

export const CALLS_STATS_KEY = (period: StatsPeriod = "7d") => ["calls-stats", period] as const;
export const CALLS_WAITING_KEY = ["calls-waiting"] as const;

function buildFeedQs(
  mode: CallMode,
  page: number,
  limit: number,
  filters: FeedFilters,
): string {
  const qs = new URLSearchParams();
  qs.set("mode", mode);
  qs.set("page", String(page));
  qs.set("limit", String(limit));
  if (filters.label && filters.label !== "all") qs.set("label", filters.label);
  if (filters.quality && filters.quality !== "all") qs.set("quality", filters.quality);
  if (filters.minScore != null) qs.set("minScore", String(filters.minScore));
  if (filters.minVol1h != null) qs.set("minVol1h", String(filters.minVol1h));
  if (filters.minGain1h != null) qs.set("minGain1h", String(filters.minGain1h));
  if (filters.minMom1h != null) qs.set("minMom1h", String(filters.minMom1h));
  if (filters.minMom6h != null) qs.set("minMom6h", String(filters.minMom6h));
  return qs.toString();
}

export function fetchCallsFeed(
  mode: CallMode = "best",
  page = 1,
  limit = PAGE_SIZE,
  filters: FeedFilters = {},
) {
  return callsFetch<FeedPage>(`api/calls/feed?${buildFeedQs(mode, page, limit, filters)}`);
}

export function fetchCallsWaiting(limit = PAGE_SIZE, page = 1, filters: FeedFilters = {}) {
  const qs = new URLSearchParams();
  qs.set("page", String(page));
  qs.set("limit", String(limit));
  if (filters.label && filters.label !== "all") qs.set("label", filters.label);
  if (filters.quality && filters.quality !== "all") qs.set("quality", filters.quality);
  if (filters.minScore != null) qs.set("minScore", String(filters.minScore));
  if (filters.minVol1h != null) qs.set("minVol1h", String(filters.minVol1h));
  if (filters.minGain1h != null) qs.set("minGain1h", String(filters.minGain1h));
  if (filters.minMom1h != null) qs.set("minMom1h", String(filters.minMom1h));
  if (filters.minMom6h != null) qs.set("minMom6h", String(filters.minMom6h));
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
  gainPct: number | null;
  kol: number | null;
  smart: number | null;
};

/** Crypsor-owned labels — not GMGN KOL/smart */
export type CrypsorWalletRow = {
  address: string;
  ourLabel: string;
  behaviourScore: number;
  weightage: number;
  winRate: number | null;
  wins: number;
  losses: number;
  tokensSeen: number;
  sightings: number;
  holdPct: number | null;
  buyCount: number | null;
  sellCount: number | null;
  realizedPnl: number | null;
  reason: string | null;
  lastSeenAt: string | null;
};

export const CALLS_TOKEN_KEY = (id: number, winrate = false) =>
  ["calls-token", id, winrate ? "wr" : "lite"] as const;

/** Detail is lite by default; pass winrate=true to pull buyer/Crypsor WR. */
export function fetchCallDetail(tokenId: number, opts?: { winrate?: boolean }) {
  const qs = opts?.winrate ? "?winrate=1" : "";
  return callsFetch<{
    card: CallCard | null;
    buyers: CallBuyer[];
    snaps: CallSnap[];
    crypsorWallets?: CrypsorWalletRow[];
    winrateLoaded?: boolean;
    walletBuysNote?: string;
    crypsorNote?: string;
  }>(`api/calls/token/${tokenId}${qs}`);
}
