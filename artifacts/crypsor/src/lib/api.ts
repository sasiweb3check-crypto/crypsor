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

export type TokenStatus = "live" | "running" | "dead";
export type DeskLabel = "dead" | "late" | "runner" | "call" | "heat" | "watch";
export type DeskBand = "early" | "all";

export type GainMatrix = {
  n: number;
  now: Record<string, { n: number; pct: number }>;
  peak: Record<string, { n: number; pct: number }>;
};

export type TokenCard = {
  id: number;
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  detected_mc: number | null;
  last_mc: number | null;
  peak_mc: number | null;
  last_liq: number | null;
  gain_pct: number | null;
  ath_pct: number | null;
  wallet_buys: number;
  status: TokenStatus;
  label: DeskLabel;
  score: number | null;
  prev_score: number | null;
  score_at: string | null;
  discovered_at: string;
  last_scan_at: string | null;
};

export type TokenBoard = {
  at: string;
  items: TokenCard[];
  performers: TokenCard[];
  census: { all: number; live: number; running: number; dead: number; early: number };
  matrix: GainMatrix | null;
  scoreStats: ScoreStat[] | null;
  band: DeskBand;
  page: number;
  pages: number;
  total: number;
  limit: number;
};

export type ScoreStat = {
  bucket: string;
  n: number;
  hit2x: number;
  hit5x: number;
  pct2x: number;
  pct5x: number;
};

export type DeskMemory = {
  at: string;
  mc_usd: number | null;
  liq_usd: number | null;
  gain_pct: number | null;
  wallets: number | null;
  status: string | null;
  label: string | null;
  survived: boolean | null;
  score: number | null;
  prev_score: number | null;
  score_delta: number | null;
  mc_delta_pct: number | null;
  liq_delta_pct: number | null;
  wallet_delta: number | null;
  band: string | null;
};

export type NoticeItem = {
  id: number;
  tokenId: number;
  kind: string;
  title: string;
  body: string;
  lane: "early" | "high";
  score: number | null;
  at: string;
  symbol: string | null;
  mint: string | null;
};

export type NoticeBoard = {
  at: string;
  items: NoticeItem[];
  scoreStats: ScoreStat[];
};

export type TokenChart = {
  token: TokenCard;
  admissions: Array<{ wallet: string; sig: string | null; at: string; label: string | null }>;
  scans: Array<{ at: string; mc_usd: number | null; liq_usd: number | null; phase: string | null }>;
  memory: DeskMemory[];
};

export function dexTokenImage(mint: string | null | undefined): string | null {
  if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return null;
  return `https://dd.dexscreener.com/ds-data/tokens/solana/${mint}.png`;
}

export function deskImg(src: string | null | undefined, mint?: string | null): string | null {
  const u = (src && /^https:\/\//i.test(src) ? src : null) ?? dexTokenImage(mint);
  if (!u) return null;
  const m = mint ? `&m=${encodeURIComponent(mint)}` : "";
  return `${getApiBase()}api/img?u=${encodeURIComponent(u)}${m}`;
}

export function gmgnUrl(mint: string): string {
  return `https://gmgn.ai/sol/token/${mint}`;
}

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

export function fmtGainPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;
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
