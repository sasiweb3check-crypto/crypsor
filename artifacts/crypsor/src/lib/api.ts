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

export type TapeWindow = {
  buys: number | null;
  sells: number | null;
  volUsd: number | null;
  changePct: number | null;
};

export type Prognosis = { id: string; label: string };

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
  last_quality?: number | null;
  cap_band?: "low" | "mid" | "mega" | null;
  last_suggestion?: string | null;
  prognosis?: Prognosis;
};

export type AgentVote = {
  agent: string;
  vote: "yes" | "no" | "hold";
  reason: string;
};

export type WatchCard = {
  token_id: number;
  status: string;
  yes_votes: number;
  no_votes: number;
  hold_votes: number;
  agreed: boolean;
  entry_ok: boolean;
  headline: string | null;
  votes: AgentVote[] | null;
  last_mc: number | null;
  last_liq: number | null;
  last_score: number | null;
  seen_at: string;
  updated_at: string;
  locked_at?: string | null;
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  phase: Phase;
  wallet_buys: number;
  last_holders: number | null;
};

export type TradeCard = {
  id: number;
  token_id: number;
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  wallet_buys: number;
  phase: Phase;
  entry_mc: number;
  entry_liq: number | null;
  entry_holders: number | null;
  entry_score: number | null;
  called_at: string;
  peak_mc: number | null;
  last_mc: number | null;
  last_liq: number | null;
  last_holders: number | null;
  status: "open" | "trim" | "exit" | "dead";
  exit_action: "hold" | "trim" | "exit" | null;
  exit_take_pct: number | null;
  exit_title: string | null;
  exit_body: string | null;
  gain_x: number | null;
  ath_x: number | null;
  closed_at: string | null;
  close_mc: number | null;
};

export type DeskState = {
  open: TradeCard[];
  watch?: WatchCard[];
  performers: TradeCard[];
  paper: { n: number; wins: number; open: number; avgAth: number | null; avgGain: number | null };
  page?: number;
  pages?: number;
  total?: number;
  limit?: number;
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
  suggestions?: Suggestion[];
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
  tape: {
    lead?: string;
    holds?: string[];
    fails?: string[];
    factors?: Factor[];
    m5?: TapeWindow;
    h1?: TapeWindow;
    h6?: TapeWindow;
    chase?: boolean;
    dead?: boolean;
    tradeOk?: boolean;
  } | null;
  score: number | null;
  phase: string | null;
  quality?: number | null;
  sources?: { used?: Record<string, string | null>; flags?: string[] } | null;
};

export type Suggestion = {
  id: string;
  severity: "info" | "watch" | "act";
  title: string;
  body: string;
};

export type SnapshotRow = {
  at: string;
  band: string;
  kind?: "pulse" | "confirm" | string;
  mc_usd: number | null;
  liq_usd: number | null;
  holders: number | null;
  top10_pct: number | null;
  score: number | null;
  phase: string | null;
  quality: number | null;
  tape_lead: string | null;
  mc_slope: number | null;
  liq_slope: number | null;
  holder_slope: number | null;
  flags: string[] | null;
  suggestions: Suggestion[] | null;
  narrative?: string | null;
  incomplete?: boolean | null;
  filled?: { mc?: string; liq?: string; holders?: string } | null;
};

export type SourceReadRow = {
  source: string;
  ok: boolean;
  mc_usd: number | null;
  liq_usd: number | null;
  holders: number | null;
  top10_pct: number | null;
  latency_ms: number | null;
  extra: Record<string, unknown> | null;
  at: string;
};

export type PatientChart = {
  token: PatientCard & {
    mint: string;
    xFromAdmit: number | null;
    peakX: number | null;
    kill_reason: string | null;
    called_at: string | null;
    alert_mc: number | null;
    prognosis?: Prognosis;
  };
  lastScan: ScanRow | null;
  scans: ScanRow[];
  course: Array<{ phase: string; at: string; score: number | null }>;
  admissions: Array<{ wallet: string; sig: string | null; at: string; label: string | null }>;
  alerts: Array<{
    id: number; kind: string; title: string; body: string | null;
    payload: Record<string, unknown> | null; telegram_sent: boolean; at: string;
  }>;
  notes: Array<{ agent: string; action: string; detail: string; at: string }>;
  snapshots?: SnapshotRow[];
  pulse?: SnapshotRow | null;
  confirm?: SnapshotRow | null;
  sources?: SourceReadRow[];
  suggestions?: Suggestion[];
  trade?: TradeCard | null;
  watch?: WatchCard | null;
  narrative?: string | null;
  memory?: {
    caution?: { notes?: string[]; dumps?: number; missingHolders?: number; missingMc?: number };
    narrative?: string | null;
    updated_at?: string;
  } | null;
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

export type AlertPage = {
  items: AlertRow[];
  page: number;
  pages: number;
  total: number;
  limit: number;
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
  report: {
    census: Record<string, number>;
    survival: number | null;
    trades_24h: number;
    paper: { judged?: number; wins?: number };
    detail: string;
    suggestions?: Suggestion[];
    quality?: Record<string, unknown>;
    at: string;
  } | null;
  quality?: {
    sources?: Array<{ source: string; n: number; ok: number; avg_ms: number | null }>;
    snapshots?: Array<{ band: string; n: number }>;
    bands?: Array<{ band: string; n: number; q?: number | null }>;
    snapshots6h?: number;
  } | null;
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
  return `${v.toFixed(2)}×`;
}

export function fmtSignedX(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v >= 1 ? "+" : "";
  return `${sign}${v.toFixed(2)}×`;
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

export function gmgnUrl(mint: string): string {
  return `https://gmgn.ai/sol/token/${mint}`;
}
