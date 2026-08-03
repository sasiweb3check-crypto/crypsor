/**
 * Wallet Track client — paste a mint, fetch + judge holders.
 */
import { apiFetch, ApiError } from "@/lib/api-fetch";

type Envelope<T> = { ok: boolean; data?: T; error?: string; code?: string };

async function wtFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const body = await apiFetch<Envelope<T> | T>(path, { ...init, timeoutMs: 90_000 });
  if (body && typeof body === "object" && "ok" in body) {
    const env = body as Envelope<T>;
    if (!env.ok || env.data === undefined) {
      throw new ApiError(env.error || "Wallet track error", 0);
    }
    return env.data;
  }
  return body as T;
}

export type TrackLabel =
  | "kol"
  | "smart"
  | "dev"
  | "insider"
  | "bundler"
  | "sniper"
  | "bot"
  | "terminal"
  | "fresh"
  | "diamond"
  | "flipper"
  | "paper"
  | "retail"
  | "unknown";

export type JudgedWallet = {
  address: string;
  ourLabel: TrackLabel;
  score: number;
  gmgnTags: string[];
  isKol: boolean;
  isSmart: boolean;
  holdPct: number;
  buyCount: number;
  sellCount: number;
  costUsd: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  twitterName: string | null;
  twitterUsername: string | null;
  reasons: string[];
};

export type TokenHolderSummary = {
  analyzed: number;
  supplyPctCovered: number;
  kolCount: number;
  smartCount: number;
  bundlerCount: number;
  sniperCount: number;
  freshCount: number;
  botCount: number;
  terminalCount: number;
  diamondCount: number;
  retailCount: number;
  kolSupplyPct: number;
  smartSupplyPct: number;
  bundlerSupplyPct: number;
  sniperSupplyPct: number;
  freshSupplyPct: number;
  botSupplyPct: number;
  avgScore: number;
  medianScore: number;
  grade: "A" | "B" | "C" | "D" | "F";
  riskFlags: string[];
};

export type WalletTrackReport = {
  token: {
    id: number | null;
    address: string;
    chain: string;
    name: string | null;
    symbol: string | null;
    marketCapUsd: string | null;
    status: string | null;
    priceUsd: string | null;
    liquidityUsd: string | null;
    dexUrl: string | null;
  };
  summary: TokenHolderSummary;
  wallets: JudgedWallet[];
  gmgnStat: Record<string, unknown> | null;
  fetch: {
    holderRows: number;
    pages: number;
    gmgnOk: boolean;
    gmgnStatus: number;
    dexOk: boolean;
  };
  note: string;
  fetchedAt: string;
};

export const WALLET_TRACK_KEY = (token: string) =>
  ["wallet-track", token] as const;

export function analyzeWalletTrack(token: string, chain = "solana") {
  return wtFetch<WalletTrackReport>("api/wallet-track/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, chain }),
  });
}
