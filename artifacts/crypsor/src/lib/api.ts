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
export type DeskLabel = "dead" | "late" | "runner" | "call" | "heat" | "watch" | "hot" | "setup" | "dump" | "rug" | "caution";
export type RugKind = "none" | "caution" | "dump" | "rug";
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
  rug: RugKind;
  entry_mc: number | null;
  holders: number | null;
  holders_rug?: boolean;
  top10_excl_lp?: number | null;
  cluster_n?: number | null;
  discovered_at: string;
  last_scan_at: string | null;
};

export type TokenBoard = {
  at: string;
  items: TokenCard[];
  performers: TokenCard[];
  census: {
    all: number;
    live: number;
    running: number;
    dead: number;
    early: number;
    active?: number;
    high?: number;
    score40?: number;
    score60?: number;
    score80?: number;
    rugs?: number;
  };
  matrix: GainMatrix | null;
  scoreStats: ScoreStat[] | null;
  band: DeskBand;
  scoreMin?: number;
  gainMin?: number;
  sort?: "score" | "gain" | "ath" | "new";
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
  catalyst: string | null;
  factors: Record<string, number> | null;
  vol_5m: number | null;
  vol_h1: number | null;
  buys_5m: number | null;
  sells_5m: number | null;
  holders: number | null;
  buy_ratio: number | null;
  boosts: number | null;
  replies: number | null;
  price_chg_m5: number | null;
  rug: string | null;
  survival: Record<string, unknown> | null;
  top10_pct?: number | null;
  top10_excl_lp?: number | null;
  cluster_n?: number | null;
  holders_rug?: boolean | null;
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

export function gmgnWalletUrl(wallet: string): string {
  return `https://gmgn.ai/sol/address/${wallet}`;
}

export function gmgnTxUrl(sig: string): string {
  return `https://gmgn.ai/sol/tx/${sig}`;
}

export function rhTxUrl(hash: string): string {
  return `https://robinhoodchain.blockscout.com/tx/${hash}`;
}

export function rhAddressUrl(addr: string): string {
  return `https://robinhoodchain.blockscout.com/address/${addr}`;
}

export function isSolanaAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
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

export type ScoutWalletRow = {
  wallet: string;
  status: "hold" | "partial" | "sold_all";
  balance: number;
  investedUsd: number;
  proceedsUsd: number;
  remainingUsd: number;
  remainingTokens: number;
  avgBuy: number | null;
  avgSell: number | null;
  realizedRoi: number | null;
  overallRoi: number | null;
  profitUsd: number;
  winrate: number | null;
  cycles: number;
  closedCycles: number;
  avgHoldMs: number | null;
  legs: number;
  buys: number;
  sells: number;
  minBuyMc: number | null;
  buyMcs: number[];
  firstAt: number | null;
  lastAt: number | null;
  lpLike: boolean;
  labels: string[];
  gap?: boolean;
  gmgnLegs?: number;
};

export type ScoutTokenMeta = {
  mint: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  decimals: number | null;
  supply: number | null;
  priceUsd: number | null;
  mcUsd: number | null;
  liqUsd: number | null;
  createdAt: string | null;
  launchpad: string | null;
  pairAddress: string | null;
  bondingCurve: string | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  solUsd: number | null;
  notes: string[];
};

export type ScoutJob = {
  id: number;
  mint: string;
  status: "queued" | "running" | "done" | "error";
  phase: string | null;
  detail: string | null;
  progress_n: number | null;
  progress_of: number | null;
  token: ScoutTokenMeta | null;
  wallets: ScoutWalletRow[] | null;
  fills_n: number | null;
  notes: string[] | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type IntelChain = "sol" | "robinhood";
export type IntelKind = "fund" | "buy" | "sell" | "deploy";

export type IntelEvent = {
  id: number;
  chain: IntelChain | string;
  kind: IntelKind | string;
  at: string;
  wallet: string;
  counterparty: string | null;
  mint: string | null;
  symbol: string | null;
  name: string | null;
  usd: number | null;
  nativeAmt: number | null;
  tx: string;
  rumor: string | null;
  tags: string[];
  detail: string | null;
};

export type MovesBoard = {
  at: string;
  items: IntelEvent[];
  total: number;
  page: number;
  pages: number;
  limit: number;
};
