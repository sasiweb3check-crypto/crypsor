/**
 * Wallet Track client — free holders + Crypsor labels; GMGN KOL/smart overlay only.
 */
import { apiFetch, ApiError } from "@/lib/api-fetch";

type Envelope<T> = { ok: boolean; data?: T; error?: string; code?: string };

async function wtFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const body = await apiFetch<Envelope<T> | T>(path, { ...init, timeoutMs: 120_000 });
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
  | "cex_funded"
  | "whale"
  | "retail"
  | "unknown";

export type RunStatus = "running" | "fading" | "dead" | "unknown";

export type JudgedWallet = {
  address: string;
  ourLabel: TrackLabel;
  score: number;
  ourTags: string[];
  gmgnTags: string[];
  isKol: boolean;
  isSmart: boolean;
  holdPct: number;
  amountUi: number;
  rank: number;
  ageDays: number | null;
  fundedBy: string | null;
  solBalance: number | null;
  signatureCountSample: number;
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
  cexFundedCount: number;
  whaleCount: number;
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

export type TokenBoard = {
  runStatus: RunStatus;
  athMultipleEst: number | null;
  rugScore: number | null;
  rugged: boolean;
  top10Pct: number | null;
  lpLockedPct: number | null;
  mintAuthorityLive: boolean;
  freezeAuthorityLive: boolean;
  liquidityUsd: number | null;
  volume24h: number | null;
  priceChange1h: number | null;
  priceChange24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  pairAgeHours: number | null;
  socialCount: number;
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
    imageUrl: string | null;
  };
  board: TokenBoard;
  summary: TokenHolderSummary;
  wallets: JudgedWallet[];
  fetch: {
    holderRows: number;
    freeOk: boolean;
    gmgnOverlayRows: number;
    gmgnPages: number;
    gmgnOk: boolean;
    gmgnStatus: number;
    dexOk: boolean;
    rugOk: boolean;
    enrichedWallets: number;
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
