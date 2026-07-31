/**
 * Dex Autopilot client — server-side automated paper agent.
 */
import { apiFetch, ApiError } from "@/lib/api-fetch";

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

async function traderFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const body = await apiFetch<Envelope<T>>(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!body.ok || body.data === undefined) {
    throw new ApiError(body.error || "Trader API error", 0);
  }
  return body.data;
}

export type DexStatus = {
  enabled: boolean;
  bankrollUsd: number;
  openMarkUsd: number;
  equityUsd: number;
  realizedPnlUsd: number;
  tradesOpened: number;
  tradesClosed: number;
  hits3x: number;
  openCount: number;
  mode: string;
  rules: {
    takeProfit: string;
    moonBag: string;
    observationSnaps: number;
    maxOpen: number;
  };
  lastTickAt: string | null;
  tickAgeSec: number | null;
  runtimeNote?: string;
  updatedAt: string | null;
};

export type DexPosition = {
  id: number;
  tokenId: number;
  address: string;
  symbol: string | null;
  stakeUsd: number;
  remainingStakeUsd: number;
  entryMcUsd: number;
  liveMcUsd: number;
  multiple: number;
  markUsd: number;
  entryAt: string | null;
  entryPhase: string | null;
  entryScore: number | null;
  entryVelocity: number | null;
  entrySnapCount: number | null;
  patternKey: string | null;
  peakMultiple: number;
  moonBagTaken: boolean;
  status: string;
  exitReason: string | null;
  exitAt: string | null;
  realizedPnlUsd: number;
  runnerPhase: string | null;
  entryFeedback?: Record<string, unknown> | null;
  exitFeedback?: Record<string, unknown> | null;
};

export type DexEvent = {
  id: number;
  at: string | null;
  kind: string;
  level: string;
  msg: string;
  tokenId: number | null;
  symbol: string | null;
  meta: Record<string, unknown> | null;
};

export type DexPattern = {
  key: string;
  samples: number;
  wins3x: number;
  losses: number;
  winRate: number;
  avgExit: number;
  bestMultiple: number;
  lastSeenAt: string | null;
};

export const DEX_STATUS_KEY = ["dex-status"] as const;
export const DEX_POSITIONS_KEY = ["dex-positions"] as const;
export const DEX_EVENTS_KEY = ["dex-events"] as const;
export const DEX_PATTERNS_KEY = ["dex-patterns"] as const;

export function fetchDexStatus() {
  return traderFetch<DexStatus>("api/trader/status");
}

export function fetchDexPositions() {
  return traderFetch<{ positions: DexPosition[] }>("api/trader/positions");
}

export function fetchDexEvents(limit = 40) {
  return traderFetch<{ events: DexEvent[] }>(`api/trader/events?limit=${limit}`);
}

export function fetchDexPatterns() {
  return traderFetch<{ patterns: DexPattern[] }>("api/trader/patterns");
}

export function setDexEnabled(enabled: boolean) {
  return traderFetch<{ enabled: boolean }>("api/trader/enabled", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}
