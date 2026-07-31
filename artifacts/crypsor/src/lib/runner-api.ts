/**
 * Standardized Runner API client — production envelope { ok, data, meta }.
 */
import { getApiBase } from "@/lib/api-base";

export type RunnerPhase = "radar" | "heating" | "entry" | "fading" | "dead";

export type RunnerInfo = {
  score: number;
  phase: RunnerPhase;
  label: string;
  alertEligible: boolean;
  reasons: string[];
  blockers: string[];
  sizeLabel: string;
  signals: {
    velocity: number;
    gainPct: number;
    taggedOk: boolean;
    mintOk: boolean;
    freshnessOk: boolean;
    snapCount?: number;
    observationReady?: boolean;
  };
};

export type RunnerToken = {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  calledAt: string | null;
  calledMcUsd: number | null;
  currentMcUsd: number | null;
  calledIntel: number | null;
  calledSmart: number;
  calledKol: number;
  gainPct: number | null;
  athMultiple: number;
  velocity: number;
  proScore: number;
  qualityLabel: string;
  runStatus: string;
  hit2x: boolean;
  hit5x: boolean;
  hit10x: boolean;
  runnerAlertSentAt: string | null;
  secMintRenounced: boolean | null;
  secIsHoneypot: boolean | null;
  socials: { twitter?: string; telegram?: string; website?: string };
  outcome?: { code: string; label: string; detail: string } | null;
  runner: RunnerInfo;
};

export type RunnerStats = {
  desk: number;
  entriesSent: number;
  entryWinRate2x: number;
  entryWinRate5x: number;
  entryWinRate10x: number;
  x2Count: number;
  x5Count: number;
  x10Count: number;
  liveEntry: number;
  liveHeating: number;
  liveRadar: number;
  bestAth: number | null;
};

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: string;
  meta?: { ts?: string; version?: string };
};

async function runnerFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as Envelope<T> | T;
  if (body && typeof body === "object" && "ok" in body) {
    const env = body as Envelope<T>;
    if (!env.ok || env.data === undefined) {
      throw new Error(env.error || "Runner API error");
    }
    return env.data;
  }
  return body as T;
}

export const RUNNER_FEED_KEY = ["runner-feed"] as const;
export const RUNNER_STATS_KEY = ["runner-stats"] as const;
export const RUNNER_ALERTS_KEY = ["runner-alerts"] as const;

export function fetchRunnerFeed(limit = 200) {
  return runnerFetch<{ tokens: RunnerToken[]; total: number; totalAll: number }>(
    `api/runner/feed?limit=${limit}`,
  );
}

export function fetchRunnerStats() {
  return runnerFetch<RunnerStats>("api/runner/stats");
}

export function fetchRunnerAlerts() {
  return runnerFetch<{
    stats: {
      sent: number;
      winRate2x: number;
      winRate5x: number;
      winRate10x: number;
      x2Count: number;
      x5Count: number;
      x10Count: number;
      liveEntry: number;
      liveHeating: number;
    };
    sent: RunnerToken[];
    entry: RunnerToken[];
    heating: RunnerToken[];
  }>("api/runner/alerts");
}

export function fetchRunnerToken(id: number) {
  return runnerFetch<{
    token: RunnerToken | null;
    velocitySeries: Array<{
      at: string | null;
      mcUsd: number | null;
      athMultiple: number | null;
      gainPct: number | null;
      kol?: number;
      smart?: number;
      intel?: number | null;
      proScore?: number | null;
      runStatus?: string | null;
      runnerScore?: number | null;
      runnerPhase?: string | null;
      velocity?: number | null;
      phaseChanged?: boolean;
    }>;
  }>(`api/runner/token/${id}`);
}
