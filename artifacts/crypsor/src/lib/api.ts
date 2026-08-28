/**
 * API client — same-origin /api.
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

export type Phase = "intake" | "icu" | "ward" | "recovery" | "revived" | "deceased";

export type Factor = {
  id: string;
  label: string;
  points: number;
  max: number;
  hold: boolean | null;
  reason: string;
};

export type PatientCard = {
  id: number;
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  phase: Phase;
  survival_score: number | null;
  wallet_buys: number;
  last_mc: number | null;
  peak_mc: number | null;
  admission_mc: number | null;
  last_liq: number | null;
  last_holders: number | null;
  tape_lead: string | null;
  last_verdict: string | null;
  last_reasons: { holds?: string[]; fails?: string[]; unknowns?: string[] } | null;
  discovered_at: string;
  last_scan_at: string | null;
  deceased_at: string | null;
  revived_at: string | null;
  graduated: boolean;
};

export type WardBoard = {
  census: Record<string, number>;
  stats: {
    live: number;
    deceased: number;
    survival: number | null;
    avgScore: number | null;
    trades24h: number;
  };
  patients: PatientCard[];
  weights: Record<string, number>;
};

export type ScanRow = {
  at: string;
  mc_usd: number | null;
  liq_usd: number | null;
  price_usd: number | null;
  holders: number | null;
  top10_pct: number | null;
  buys_5m: number | null;
  sells_5m: number | null;
  vol_5m: number | null;
  bundler_pct: number | null;
  sniper_pct: number | null;
  bot_pct: number | null;
  whale_pct: number | null;
  smart_count: number | null;
  kol_count: number | null;
  pass: boolean;
  fail_reasons: string[] | null;
  tape: { lead?: string; holds?: string[]; factors?: Factor[] } | null;
  score: number | null;
  phase: string | null;
};

export type PatientChart = {
  token: PatientCard & {
    mint: string;
    xFromAdmit: number | null;
    peakX: number | null;
    kill_reason: string | null;
    called_at: string | null;
    alert_mc: number | null;
  };
  lastScan: ScanRow | null;
  scans: ScanRow[];
  admissions: Array<{ wallet: string; sig: string | null; at: string; label: string | null }>;
  alerts: Array<{
    id: number; kind: string; title: string; body: string | null;
    payload: Record<string, unknown> | null; telegram_sent: boolean; at: string;
  }>;
  notes: Array<{ agent: string; action: string; detail: string; at: string }>;
  weights: Record<string, number>;
};

export type AlertRow = {
  id: number;
  token_id: number;
  kind: string;
  title: string;
  body: string | null;
  payload: Record<string, unknown> | null;
  telegram_sent: boolean;
  at: string;
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  phase: Phase;
  survival_score: number | null;
};

export type AgentsState = {
  status: {
    started: boolean;
    last: Record<string, number>;
    running: Record<string, boolean>;
    intervalsMs: Record<string, number>;
  };
  weights: Record<string, number>;
  last24h: Array<{ agent: string; last_at: string; n: number }>;
  paper: { judged: number; wins: number };
  notes: Array<{
    id: number; agent: string; action: string; token_id: number | null;
    mint: string | null; detail: string; at: string;
  }>;
};

export const PHASE_META: Record<Phase, { label: string; hint: string }> = {
  intake: { label: "Intake", hint: "Just admitted from a tracked wallet buy" },
  icu: { label: "ICU", hint: "Vitals slipping — about to die" },
  ward: { label: "Ward", hint: "Stable, under observation" },
  recovery: { label: "Recovery", hint: "Coming back from ICU" },
  revived: { label: "Revived", hint: "Was dead; a wallet bought again" },
  deceased: { label: "Deceased", hint: "LP gone, dust MC, or holder collapse" },
};

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

export function fmtX(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}×`;
}

export function fmtPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export function shortWallet(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}
