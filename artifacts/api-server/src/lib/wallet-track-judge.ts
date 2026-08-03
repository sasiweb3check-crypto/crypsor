/**
 * Wallet Track judge — Crypsor own model from free on-chain signals.
 *
 * GMGN is used ONLY to overlay KOL / smart_money identity.
 * Fresh / bundler / sniper / diamond / paper / retail come from our calculations.
 */

import type { FreeHolder, WalletOnChain, TokenPulse, RugSnapshot, RunStatus } from "./wallet-track-free";

/** Pass-through identity tags from GMGN only. */
export const KOL_TAGS = new Set(["kol", "renowned"]);
export const SMART_TAGS = new Set(["smart_money", "smart_degen", "pump_smart"]);

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

export type GmgnOverlay = {
  address: string;
  isKol: boolean;
  isSmart: boolean;
  twitterName: string | null;
  twitterUsername: string | null;
  /** Only kol/smart-related tags kept for display */
  identityTags: string[];
};

export type JudgedWallet = {
  address: string;
  ourLabel: TrackLabel;
  score: number;
  /** Crypsor-computed signal tags (not GMGN dump) */
  ourTags: string[];
  /** GMGN identity only (kol/smart) */
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

function hasAny(tags: string[], set: Set<string>): boolean {
  return tags.some((t) => set.has(t));
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function supplyOf(wallets: JudgedWallet[], pred: (w: JudgedWallet) => boolean): number {
  return wallets.filter(pred).reduce((s, w) => s + w.holdPct, 0);
}

/** Build GMGN overlay map — only KOL/smart identity extracted. */
export function extractGmgnOverlays(
  rows: Array<{
    address?: string;
    account_address?: string;
    twitter_name?: string | null;
    twitter_username?: string | null;
    tags?: string[];
    maker_token_tags?: string[];
  }>,
): Map<string, GmgnOverlay> {
  const out = new Map<string, GmgnOverlay>();
  for (const row of rows) {
    const address = String(row.address ?? row.account_address ?? "").trim();
    if (!address) continue;
    const tags = [...(row.tags ?? []), ...(row.maker_token_tags ?? [])]
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean);
    const isKol = hasAny(tags, KOL_TAGS);
    const isSmart = hasAny(tags, SMART_TAGS);
    if (!isKol && !isSmart) continue; // ignore everything else from GMGN
    const identityTags = tags.filter((t) => KOL_TAGS.has(t) || SMART_TAGS.has(t));
    out.set(address, {
      address,
      isKol,
      isSmart,
      twitterName: row.twitter_name != null ? String(row.twitter_name) : null,
      twitterUsername: row.twitter_username != null ? String(row.twitter_username) : null,
      identityTags,
    });
  }
  return out;
}

type JudgeInput = {
  holder: FreeHolder;
  onChain: WalletOnChain | null;
  overlay: GmgnOverlay | null;
  pairCreatedAt: number | null;
};

function computeOurTags(input: JudgeInput): { label: TrackLabel; tags: string[]; reasons: string[] } {
  const { holder, onChain, overlay, pairCreatedAt } = input;
  const tags: string[] = [];
  const reasons: string[] = [];
  const age = onChain?.ageDays ?? null;
  const holdPct = holder.pct;

  // GMGN identity wins primary when present
  if (overlay?.isKol) {
    tags.push("kol");
    reasons.push("KOL (GMGN identity)");
  }
  if (overlay?.isSmart) {
    tags.push("smart");
    reasons.push("smart money (GMGN identity)");
  }

  // Cluster funding → bundler / coordinated
  if (onChain?.fundedByIsSameCluster) {
    tags.push("cluster_funded");
    reasons.push("same non-CEX funder as peers");
  }

  if (onChain?.fundedByIsExchange) {
    tags.push("cex_funded");
    reasons.push("funded from known exchange");
  }

  // Fresh wallet
  if (age != null && age < 3) {
    tags.push("fresh");
    reasons.push(`wallet age ${age.toFixed(1)}d`);
  } else if (age != null && age < 14) {
    tags.push("young");
    reasons.push(`wallet age ${age.toFixed(0)}d`);
  }

  // Sniper: wallet born near pair launch + meaningful bag
  if (pairCreatedAt && onChain?.firstSeenAt) {
    const deltaH = Math.abs(onChain.firstSeenAt - pairCreatedAt) / 3_600_000;
    if (deltaH <= 6 && holdPct >= 0.3) {
      tags.push("sniper");
      reasons.push(`active within ${deltaH.toFixed(1)}h of pair create`);
    }
  } else if (age != null && age < 1 && holdPct >= 1) {
    tags.push("sniper");
    reasons.push("sub-day wallet with ≥1% bag");
  }

  // Whale concentration
  if (holdPct >= 5) {
    tags.push("whale");
    reasons.push(`holds ${holdPct.toFixed(1)}%`);
  } else if (holdPct >= 2) {
    tags.push("large_bag");
    reasons.push(`holds ${holdPct.toFixed(1)}%`);
  }

  // Diamond: older wallet, not dumping signals, still meaningful
  if (age != null && age >= 90 && holdPct >= 0.2 && !tags.includes("cluster_funded")) {
    tags.push("diamond");
    reasons.push("seasoned wallet still holding");
  }

  // Thin / dormant
  if (onChain?.solBalance != null && onChain.solBalance < 0.02) {
    tags.push("thin_sol");
    reasons.push("very low SOL");
  }
  if (onChain && onChain.signatureCountSample < 5 && (age == null || age < 30)) {
    tags.push("low_activity");
    reasons.push("few on-chain signatures");
  }

  // Primary label priority
  let label: TrackLabel = "retail";
  if (overlay?.isKol) label = "kol";
  else if (overlay?.isSmart) label = "smart";
  else if (tags.includes("sniper")) label = "sniper";
  else if (tags.includes("cluster_funded")) label = "bundler";
  else if (tags.includes("fresh")) label = "fresh";
  else if (tags.includes("cex_funded") && holdPct >= 1) label = "cex_funded";
  else if (tags.includes("diamond")) label = "diamond";
  else if (tags.includes("whale")) label = "whale";
  else if (age == null && !overlay) label = "unknown";
  else label = "retail";

  if (reasons.length === 0) reasons.push("no strong free signals");
  return { label, tags, reasons };
}

function scoreFromSignals(
  label: TrackLabel,
  tags: string[],
  holdPct: number,
  overlay: GmgnOverlay | null,
): number {
  let score = 52;

  if (overlay?.isKol) score += 24;
  if (overlay?.isSmart) score += 18;
  if (tags.includes("diamond")) score += 10;
  if (tags.includes("cex_funded") && !tags.includes("cluster_funded")) score += 4;
  if (tags.includes("young") && !tags.includes("fresh")) score -= 3;
  if (tags.includes("fresh")) score -= 12;
  if (tags.includes("sniper")) score -= 16;
  if (tags.includes("cluster_funded")) score -= 22;
  if (tags.includes("thin_sol")) score -= 4;
  if (tags.includes("low_activity")) score -= 5;
  if (tags.includes("whale") && !overlay?.isKol && !overlay?.isSmart && !tags.includes("diamond")) {
    score -= 8;
  }
  if (holdPct >= 8 && label !== "kol" && label !== "smart" && label !== "dev") {
    score -= 6;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function judgeFreeHolder(input: JudgeInput): JudgedWallet {
  const { holder, onChain, overlay } = input;
  const { label, tags, reasons } = computeOurTags(input);
  const score = scoreFromSignals(label, tags, holder.pct, overlay);

  return {
    address: holder.wallet,
    ourLabel: label,
    score,
    ourTags: tags,
    gmgnTags: overlay?.identityTags ?? [],
    isKol: Boolean(overlay?.isKol),
    isSmart: Boolean(overlay?.isSmart),
    holdPct: Math.round(holder.pct * 1000) / 1000,
    amountUi: holder.amountUi,
    rank: holder.rank,
    ageDays: onChain?.ageDays ?? null,
    fundedBy: onChain?.fundedBy ?? null,
    solBalance: onChain?.solBalance ?? null,
    signatureCountSample: onChain?.signatureCountSample ?? 0,
    buyCount: 0,
    sellCount: 0,
    costUsd: null,
    realizedPnl: null,
    unrealizedPnl: null,
    twitterName: overlay?.twitterName ?? null,
    twitterUsername: overlay?.twitterUsername ?? null,
    reasons,
  };
}

export function judgeFreeHolders(
  holders: FreeHolder[],
  onChainMap: Map<string, WalletOnChain>,
  overlays: Map<string, GmgnOverlay>,
  pairCreatedAt: number | null,
): JudgedWallet[] {
  const out: JudgedWallet[] = [];
  const seen = new Set<string>();
  for (const h of holders) {
    if (seen.has(h.wallet)) continue;
    seen.add(h.wallet);
    out.push(
      judgeFreeHolder({
        holder: h,
        onChain: onChainMap.get(h.wallet) ?? null,
        overlay: overlays.get(h.wallet) ?? null,
        pairCreatedAt,
      }),
    );
  }
  out.sort((a, b) => b.holdPct - a.holdPct || b.score - a.score);
  return out;
}

export function summarizeHolders(wallets: JudgedWallet[]): TokenHolderSummary {
  const analyzed = wallets.length;
  const supplyPctCovered = wallets.reduce((s, w) => s + w.holdPct, 0);
  const scores = wallets.map((w) => w.score);
  const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const medianScore = median(scores);

  const kolCount = wallets.filter((w) => w.isKol).length;
  const smartCount = wallets.filter((w) => w.isSmart).length;
  const bundlerCount = wallets.filter((w) => w.ourLabel === "bundler" || w.ourTags.includes("cluster_funded")).length;
  const sniperCount = wallets.filter((w) => w.ourLabel === "sniper" || w.ourTags.includes("sniper")).length;
  const freshCount = wallets.filter((w) => w.ourLabel === "fresh" || w.ourTags.includes("fresh")).length;
  const botCount = wallets.filter((w) => w.ourLabel === "bot").length;
  const terminalCount = wallets.filter((w) => w.ourLabel === "terminal").length;
  const diamondCount = wallets.filter((w) => w.ourLabel === "diamond" || w.ourTags.includes("diamond")).length;
  const cexFundedCount = wallets.filter((w) => w.ourLabel === "cex_funded" || w.ourTags.includes("cex_funded")).length;
  const whaleCount = wallets.filter((w) => w.ourLabel === "whale" || w.ourTags.includes("whale")).length;
  const retailCount = wallets.filter((w) => w.ourLabel === "retail" || w.ourLabel === "unknown").length;

  const kolSupplyPct = supplyOf(wallets, (w) => w.isKol);
  const smartSupplyPct = supplyOf(wallets, (w) => w.isSmart);
  const bundlerSupplyPct = supplyOf(wallets, (w) => w.ourLabel === "bundler" || w.ourTags.includes("cluster_funded"));
  const sniperSupplyPct = supplyOf(wallets, (w) => w.ourLabel === "sniper" || w.ourTags.includes("sniper"));
  const freshSupplyPct = supplyOf(wallets, (w) => w.ourLabel === "fresh" || w.ourTags.includes("fresh"));
  const botSupplyPct = supplyOf(wallets, (w) => w.ourLabel === "bot");

  const riskFlags: string[] = [];
  if (bundlerSupplyPct >= 12) riskFlags.push(`cluster-funded hold ${bundlerSupplyPct.toFixed(1)}%`);
  if (sniperSupplyPct >= 10) riskFlags.push(`sniper-pattern hold ${sniperSupplyPct.toFixed(1)}%`);
  if (freshSupplyPct >= 18) riskFlags.push(`fresh wallets hold ${freshSupplyPct.toFixed(1)}%`);
  if (kolCount + smartCount === 0) riskFlags.push("no KOL/smart overlay in sample");
  if (medianScore < 35) riskFlags.push("weak median holder score");

  const quality = kolSupplyPct + smartSupplyPct + diamondCount * 0.4;
  const risk = bundlerSupplyPct + sniperSupplyPct * 0.85 + freshSupplyPct * 0.5;
  let grade: TokenHolderSummary["grade"] = "C";
  if (quality >= 8 && risk < 15 && medianScore >= 55) grade = "A";
  else if (quality >= 3 && risk < 25 && medianScore >= 45) grade = "B";
  else if (risk >= 40 || medianScore < 30) grade = "F";
  else if (risk >= 25 || medianScore < 40) grade = "D";

  return {
    analyzed,
    supplyPctCovered: Math.round(supplyPctCovered * 10) / 10,
    kolCount,
    smartCount,
    bundlerCount,
    sniperCount,
    freshCount,
    botCount,
    terminalCount,
    diamondCount,
    cexFundedCount,
    whaleCount,
    retailCount,
    kolSupplyPct: Math.round(kolSupplyPct * 10) / 10,
    smartSupplyPct: Math.round(smartSupplyPct * 10) / 10,
    bundlerSupplyPct: Math.round(bundlerSupplyPct * 10) / 10,
    sniperSupplyPct: Math.round(sniperSupplyPct * 10) / 10,
    freshSupplyPct: Math.round(freshSupplyPct * 10) / 10,
    botSupplyPct: Math.round(botSupplyPct * 10) / 10,
    avgScore: Math.round(avgScore * 10) / 10,
    medianScore: Math.round(medianScore * 10) / 10,
    grade,
    riskFlags,
  };
}

export function buildTokenBoard(
  pulse: TokenPulse | null,
  rug: RugSnapshot,
  runStatus: RunStatus,
  athMultipleEst: number | null,
): TokenBoard {
  const pairAgeHours =
    pulse?.pairCreatedAt != null
      ? Math.max(0, (Date.now() - pulse.pairCreatedAt) / 3_600_000)
      : null;
  return {
    runStatus,
    athMultipleEst,
    rugScore: rug.score,
    rugged: rug.rugged,
    top10Pct: rug.top10Pct,
    lpLockedPct: rug.lpLockedPct,
    mintAuthorityLive: Boolean(rug.mintAuthority),
    freezeAuthorityLive: Boolean(rug.freezeAuthority),
    liquidityUsd: pulse?.liquidityUsd ?? null,
    volume24h: pulse?.volume24h ?? null,
    priceChange1h: pulse?.priceChange1h ?? null,
    priceChange24h: pulse?.priceChange24h ?? null,
    buys24h: pulse?.buys24h ?? null,
    sells24h: pulse?.sells24h ?? null,
    pairAgeHours: pairAgeHours != null ? Math.round(pairAgeHours * 10) / 10 : null,
    socialCount: (pulse?.websites.length ?? 0) + (pulse?.socials.length ?? 0),
  };
}
