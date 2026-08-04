/**
 * GEM desk client — trusted GEM calls (survival-judged) + discovery log
 * + fast lightweight token detail with a generated story.
 */
import { apiFetch, ApiError } from "@/lib/api-fetch";

type Envelope<T> = { ok: boolean; data?: T; error?: string };

async function gemsFetch<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const body = await apiFetch<Envelope<T> | T>(path, { timeoutMs: 30_000, ...init });
  if (body && typeof body === "object" && "ok" in body) {
    const env = body as Envelope<T>;
    if (!env.ok || env.data === undefined) {
      throw new ApiError(env.error || "Gems API error", 0);
    }
    return env.data;
  }
  return body as T;
}

export type SurvivalLabel = "RUNNING" | "HOLDING" | "COOLING" | "FADING";

export type Survival = {
  score: number;
  label: SurvivalLabel;
  components: { price: number; flow: number; liq: number; holders: number };
  signals: string[];
};

export type GemCard = {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  gemScore: number;
  gemConfidence: number;
  gemComponents: Record<string, number> | null;
  calledAt: string | null;
  callMcUsd: number | null;
  currentMcUsd: number | null;
  peakMcUsd: number | null;
  gainSinceCallPct: number | null;
  peakMultiple: number | null;
  offPeakPct: number | null;
  liqUsd: number | null;
  holderCount: number | null;
  trackedWallets: number;
  minutesSinceCall: number | null;
  survival: Survival | null;
};

export type GemsPage = {
  cards: GemCard[];
  total: number;
  page: number;
  pages: number;
  limit: number;
};

export type GemLogRow = {
  id: number;
  address: string;
  symbol: string | null;
  name: string | null;
  logoUri: string | null;
  detectedAt: string | null;
  detectMcUsd: number | null;
  currentMcUsd: number | null;
  gemScore: number | null;
  gemVerdict: string | null;
  trackedWallets: number;
};

export type TokenStory = {
  mood: "bullish" | "neutral" | "bearish" | "danger";
  headline: string;
  lines: string[];
};

export type GemDetail = {
  card: GemCard & {
    gemVerdict: string | null;
    gemVetoes: string[];
    top10Pct: number | null;
    sniperCount: number | null;
    bundlerCount: number | null;
    smartCount: number | null;
    kolCount: number | null;
    vol24hUsd: number | null;
    pairAgeMin: number | null;
    detectedAt: string | null;
    socials: { twitter?: string; telegram?: string; website?: string };
  };
  spark: Array<{ t: number; mc: number }>;
  flow: { buys5m: number; sells5m: number; buys1h: number; sells1h: number } | null;
  story: TokenStory;
  live: boolean;
};

export const GEMS_PAGE_SIZE = 8;
export const GEMS_FEED_KEY = (page: number) => ["gems-feed", page] as const;
export const GEMS_LOG_KEY = ["gems-log"] as const;
export const GEM_DETAIL_KEY = (id: number) => ["gem-detail", id] as const;

export function fetchGems(page = 1, limit = GEMS_PAGE_SIZE) {
  return gemsFetch<GemsPage>(`api/gems?page=${page}&limit=${limit}`);
}

export function fetchGemsLog(limit = 25) {
  return gemsFetch<{ rows: GemLogRow[] }>(`api/gems/log?limit=${limit}`);
}

export function fetchGemDetail(id: number) {
  return gemsFetch<GemDetail>(`api/gems/token/${id}`);
}
