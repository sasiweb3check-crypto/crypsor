/**
 * Ops / Logs API client — shared by Logs page + nav prefetch.
 */
import { apiFetch } from "@/lib/api-fetch";

export const OPS_SUMMARY_KEY = ["opsSummary"] as const;
export const OPS_PING_KEY = ["opsPing"] as const;
export const OPS_LOG_KEY = (kind: string) => ["opsLog", kind] as const;
export const OPS_GMGN_KEY = ["opsGmgnCheck"] as const;

export type OpsLevel = "info" | "warn" | "error";
export type OpsKind =
  | "helius" | "wallet_buy" | "scan" | "pro_qualify"
  | "telegram" | "blocker" | "api" | "cto" | "runner" | "all";

export interface OpsEvent {
  id: number;
  ts: string;
  kind: string;
  level: OpsLevel;
  msg: string;
  meta?: Record<string, unknown>;
  latencyMs?: number;
}

export interface OpsSummary {
  ts: string;
  inventory?: {
    tokensTracked: number;
    tokensActive: number;
    buysTotal: number;
    walletsTracked: number;
  };
  helius: {
    configured: boolean;
    lastError: string | null;
    lastOkAt: string | null;
    lastLatencyMs: number | null;
    status?: string;
  };
  scan: {
    running: boolean;
    cycleCount: number;
    lastScanAt: string | null;
    nextScanAt: string | null;
    lastDurationMs: number | null;
    lastBuysDetected: number;
    totalBuysAllTime: number;
    walletsTracked: number;
    scanAgeSec: number | null;
    delayed: boolean;
    stopped: boolean;
    walletErrors: Array<{ label: string; address: string; status: string; error: string | null }>;
  };
  telegram: {
    configured: boolean;
    lastOkAt: string | null;
    lastError: string | null;
    pendingFirstCalls: number;
    pendingMilestones: number;
  };
  pro: {
    lastQualifyAt: string | null;
    insertedTotal: number;
    qualityBelowRecent: number;
  };
  buys: { sessionCount: number; lastBuyAt: string | null };
  blockers: Array<{ code: string; level: OpsLevel; msg: string }>;
}

export type OpsGmgnCheck = {
  ok: boolean;
  latencyMs: number;
  note: string;
  openApi?: {
    configured: boolean;
    ok: boolean;
    status: number;
    error?: string;
    host: string;
  };
  scrape?: {
    proxy: string;
    okCount: number;
    results: Array<{ name: string; ok: boolean; status: number; blocked?: boolean }>;
  };
  results?: Array<{ name: string; ok: boolean; status: number; blocked?: boolean }>;
};

export async function fetchOpsSummary() {
  return apiFetch<OpsSummary>("api/ops/summary");
}

export async function fetchOpsLog(kind: string) {
  return apiFetch<{ events: OpsEvent[] }>(`api/ops/log?limit=80&kind=${kind}`);
}

export async function fetchOpsPing() {
  return apiFetch<{ ok: boolean; ts: string }>("api/ops/ping", { timeoutMs: 12_000 });
}

export async function fetchOpsGmgn() {
  return apiFetch<OpsGmgnCheck>("api/ops/gmgn-check", { timeoutMs: 45_000 });
}
