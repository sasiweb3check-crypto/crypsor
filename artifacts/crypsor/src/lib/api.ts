/**
 * Tiny API client — same-origin /api on Vercel (see api-base.ts).
 */
import { getApiBase } from "./api-base";

type Envelope<T> = { ok: boolean; data?: T; error?: string };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getApiBase();
  const url = `${base}${path.startsWith("/") ? path.slice(1) : path}`;
  const resp = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  const body = await resp.json() as Envelope<T>;
  if (!resp.ok || !body.ok || body.data === undefined) {
    throw new Error(body.error || `HTTP ${resp.status}`);
  }
  return body.data;
}

export function sseUrl(): string {
  return `${getApiBase()}api/events`;
}

// ── shapes ──────────────────────────────────────────────────────────────────

export type VaultCall = {
  id: number;
  token_id: number;
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  source: string;
  wallet_buys: number;
  called_at: string;
  alert_mc: number;
  peak_mc: number;
  peak_at: string | null;
  last_mc: number | null;
  safe: boolean;
  peak_x: number | null;
};

export type VaultStats = {
  signals: number;
  winners2x: number;
  winners5x: number;
  winners10x: number;
  avgReturn: number | null;
  bestX: number | null;
  bestSymbol: string | null;
  winRate: number | null;
  matured: number;
};

export type FunnelState = {
  counts: Record<string, number>;
  tracking: Array<{
    id: number; mint: string; symbol: string | null; source: string;
    wallet_buys: number; pass_streak: number; scans_total: number;
    discovered_at: string; mc_usd: number | null; holders: number | null;
    top10_pct: number | null; pass: boolean | null; fail_reasons: string[] | null;
  }>;
  recentKills: Array<{ mint: string; symbol: string | null; kill_reason: string; discovered_at: string }>;
  killReasons: Array<{ reason: string; n: number }>;
  thresholds: Record<string, number | boolean>;
};

export type TokenDetail = {
  token: Record<string, unknown> & {
    id: number; mint: string; symbol: string | null; name: string | null;
    image: string | null; source: string; stage: string; kill_reason: string | null;
    wallet_buys: number; discovered_at: string;
    call_id: number | null; called_at: string | null; alert_mc: number | null;
    peak_mc: number | null; last_mc: number | null; safe: boolean | null;
    deep: { reasons?: string[]; intel?: Record<string, number | null>; security?: Record<string, unknown> } | null;
  };
  scans: Array<{
    at: string; mc_usd: number | null; liq_usd: number | null; holders: number | null;
    top10_pct: number | null; buys_5m: number | null; sells_5m: number | null;
    bundler_pct: number | null; smart_count: number | null; kol_count: number | null;
    pass: boolean; fail_reasons: string[] | null;
  }>;
  journal: Array<{
    at: string; price_usd: number | null; mc_usd: number | null; liq_usd: number | null;
    holders: number | null; bot_pct: number | null; smart_count: number | null;
    whale_pct: number | null; buys_5m: number | null; sells_5m: number | null;
  }>;
};

// ── formatting ──────────────────────────────────────────────────────────────

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
}

export function fmtX(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}×`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit" })
    + " " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}
