/**
 * Pump-desk alerts client — notification center + stats.
 */
import { apiFetch, ApiError } from "@/lib/api-fetch";

type Envelope<T> = { ok: boolean; data?: T; error?: string };

async function alertsFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const body = await apiFetch<Envelope<T> | T>(path, { timeoutMs: 30_000, ...init });
  if (body && typeof body === "object" && "ok" in body) {
    const env = body as Envelope<T>;
    if (!env.ok || env.data === undefined) {
      throw new ApiError(env.error || "Alerts API error", 0);
    }
    return env.data;
  }
  return body as T;
}

export type PumpAlertKind =
  | "STRONG_BUY"
  | "INTRA_NOW"
  | "GRADE_S"
  | "GRADE_A"
  | "EEI"
  | "LARRY"
  | "GAIN_50"
  | "ATH_2X"
  | "ATH_5X"
  | "ATH_10X"
  | string;

export type PumpAlert = {
  id: number;
  tokenId: number;
  kind: PumpAlertKind;
  label: string;
  title: string;
  body: string | null;
  score: number | null;
  grade: string | null;
  buySignal: string | null;
  intraSignal: string | null;
  marketCapUsd: number | null;
  mcAtDetection: number | null;
  gainPct: number | null;
  athGainPct: number | null;
  symbol: string | null;
  name: string | null;
  address: string | null;
  telegramSent: boolean;
  telegramError: string | null;
  readAt: string | null;
  createdAt: string;
};

export type AlertsPage = {
  alerts: PumpAlert[];
  total: number;
  page: number;
  pages: number;
  limit: number;
  unread: number;
};

export type AlertsStats = {
  total: number;
  unread: number;
  telegramSent: number;
  last24h: number;
  strongBuy: number;
  intraNow: number;
  gradeSa: number;
  eei: number;
  gain50: number;
  ath2x: number;
  ath5x: number;
  ath10x: number;
  milestones: number;
  byKind: Array<{ kind: string; count: number }>;
  note?: string;
};

export const ALERTS_FEED_KEY = (page: number, unreadOnly: boolean, kind: string) =>
  ["pump-alerts", page, unreadOnly, kind] as const;
export const ALERTS_STATS_KEY = ["pump-alerts-stats"] as const;
export const ALERTS_UNREAD_KEY = ["pump-alerts-unread"] as const;

export function fetchAlerts(opts?: {
  page?: number;
  limit?: number;
  unread?: boolean;
  kind?: string;
}) {
  const qs = new URLSearchParams();
  qs.set("page", String(opts?.page ?? 1));
  qs.set("limit", String(opts?.limit ?? 12));
  if (opts?.unread) qs.set("unread", "1");
  if (opts?.kind) qs.set("kind", opts.kind);
  return alertsFetch<AlertsPage>(`api/alerts?${qs.toString()}`);
}

export function fetchAlertsStats() {
  return alertsFetch<AlertsStats>("api/alerts/stats");
}

export function markAlertsRead(opts: { ids?: number[]; all?: boolean }) {
  return alertsFetch<{ ok: boolean; unread: number }>("api/alerts/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
}

export function alertAccent(kind: string): string {
  if (kind === "STRONG_BUY") return "var(--cryp-gain)";
  if (kind === "INTRA_NOW") return "#ea580c";
  if (kind.startsWith("ATH_") || kind === "GAIN_50") return "var(--cryp-accent)";
  if (kind === "LARRY" || kind === "EEI") return "#0ea5e9";
  if (kind.startsWith("GRADE_")) return "var(--cryp-accent)";
  return "var(--cryp-text)";
}
