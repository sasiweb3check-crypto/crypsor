/**
 * Wallet Track — holder judgment from scratch.
 *
 * Sources:
 *   - GMGN holder rows (tags, hold %, buys/sells, PnL, twitter)
 *   - Free DexScreener token metadata (optional, caller-supplied)
 *
 * Rules:
 *   - KOL / smart tags from GMGN are kept as-is (kol, renowned, smart_money, smart_degen)
 *   - No balance-bracket / cabal heuristics
 *   - Bundler / sniper / fresh come only from GMGN tags (or clear bot tags)
 *   - Our primary label is a single crypsor judgment for ranking
 */

export type GmgnHolderRaw = {
  address?: string;
  account_address?: string;
  twitter_name?: string | null;
  twitter_username?: string | null;
  tags?: string[];
  maker_token_tags?: string[];
  amount_percentage?: number | null;
  balance?: number | string | null;
  cost_usd?: number | null;
  realized_profit?: number | null;
  unrealized_profit?: number | null;
  buy_tx_count_cur?: number | null;
  buy_count?: number | null;
  sell_tx_count_cur?: number | null;
  sell_count?: number | null;
  native_balance?: number | null;
  last_active_timestamp?: number | null;
};

/** Pass-through identity tags — never rewrite these. */
export const KOL_TAGS = new Set(["kol", "renowned"]);
export const SMART_TAGS = new Set(["smart_money", "smart_degen", "pump_smart"]);

const TERMINAL_TAGS = new Set([
  "axiom", "gmgn", "trojan", "padre", "photon", "bloom", "bloom_trading",
  "bullx", "pepeboost", "maestro", "bonkbot", "banana_gun", "nova", "fomo",
]);
const BOT_TAGS = new Set([
  "dex_bot", "bot_degen", "sandwich_bot", "rat_trader", "wash_trader", "bot",
]);
const DEV_TAGS = new Set(["dev", "dev_team", "creator"]);
const FRESH_TAGS = new Set(["fresh_wallet", "fresh"]);
const SNIPER_TAGS = new Set(["sniper", "snipe_bot"]);
const BUNDLER_TAGS = new Set(["bundler"]);
const INSIDER_TAGS = new Set(["insider"]);
const DIAMOND_TAGS = new Set(["diamond_hands", "bluechip_owner"]);
const PAPER_TAGS = new Set(["paper_hands"]);

/** Our primary judgment labels (one per wallet). */
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
  /** Our single primary label */
  ourLabel: TrackLabel;
  /** 0–100 quality / trust score (higher = healthier holder for the token) */
  score: number;
  /** GMGN tags kept verbatim */
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
  /** A–F grade from holder mix */
  grade: "A" | "B" | "C" | "D" | "F";
  riskFlags: string[];
};

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** GMGN amount_percentage is usually a fraction (0.021 = 2.1%). */
export function toHoldPct(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return 0;
  // If already looks like a percent (>1 and <=100), keep; if tiny fraction, *100
  if (raw > 0 && raw <= 1) return raw * 100;
  return raw;
}

function uniqTags(h: GmgnHolderRaw): string[] {
  const raw = [...(h.tags ?? []), ...(h.maker_token_tags ?? [])]
    .map(t => String(t).trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(raw)];
}

function hasAny(tags: string[], set: Set<string>): boolean {
  return tags.some(t => set.has(t));
}

function pickPrimary(tags: string[], buys: number, sells: number): TrackLabel {
  if (hasAny(tags, DEV_TAGS)) return "dev";
  if (hasAny(tags, INSIDER_TAGS)) return "insider";
  if (hasAny(tags, KOL_TAGS)) return "kol";
  if (hasAny(tags, SMART_TAGS)) return "smart";
  if (hasAny(tags, BUNDLER_TAGS)) return "bundler";
  if (hasAny(tags, SNIPER_TAGS)) return "sniper";
  if (hasAny(tags, BOT_TAGS)) return "bot";
  if (hasAny(tags, TERMINAL_TAGS)) return "terminal";
  if (hasAny(tags, FRESH_TAGS)) return "fresh";
  if (hasAny(tags, DIAMOND_TAGS)) return "diamond";
  if (hasAny(tags, PAPER_TAGS)) return "paper";
  if (sells > 0 && sells >= buys) return "flipper";
  if (buys > 0) return "retail";
  return "unknown";
}

function scoreWallet(tags: string[], buys: number, sells: number, holdPct: number, hasTwitter: boolean): {
  score: number;
  reasons: string[];
} {
  let score = 50;
  const reasons: string[] = [];

  if (hasAny(tags, KOL_TAGS)) {
    score += 25;
    reasons.push("KOL (GMGN)");
  }
  if (hasAny(tags, SMART_TAGS)) {
    score += 20;
    reasons.push("smart money (GMGN)");
  }
  if (hasAny(tags, DIAMOND_TAGS)) {
    score += 10;
    reasons.push("diamond / bluechip");
  }
  if (hasTwitter) {
    score += 4;
    reasons.push("has twitter");
  }
  if (buys > 0 && sells === 0) {
    score += 6;
    reasons.push("holding (no sells)");
  } else if (buys > sells && sells > 0) {
    score += 2;
    reasons.push("net accumulator");
  }

  if (hasAny(tags, FRESH_TAGS)) {
    score -= 10;
    reasons.push("fresh wallet");
  }
  if (hasAny(tags, SNIPER_TAGS)) {
    score -= 14;
    reasons.push("sniper");
  }
  if (hasAny(tags, BUNDLER_TAGS)) {
    score -= 20;
    reasons.push("bundler");
  }
  if (hasAny(tags, BOT_TAGS)) {
    score -= 22;
    reasons.push("bot / rat / wash");
  }
  if (hasAny(tags, TERMINAL_TAGS) && !hasAny(tags, KOL_TAGS) && !hasAny(tags, SMART_TAGS)) {
    score -= 6;
    reasons.push("trading terminal");
  }
  if (hasAny(tags, PAPER_TAGS)) {
    score -= 8;
    reasons.push("paper hands");
  }
  if (tags.includes("transfer_in") && buys === 0) {
    score -= 12;
    reasons.push("transfer-in only");
  }
  if (hasAny(tags, INSIDER_TAGS)) {
    score -= 15;
    reasons.push("insider");
  }
  if (hasAny(tags, DEV_TAGS)) {
    // Dev holding can be ok; slight caution
    score -= 5;
    reasons.push("dev / creator");
  }
  if (sells > buys && buys > 0) {
    score -= 8;
    reasons.push("net seller");
  }
  // Very large bag without quality tags → concentration risk
  if (holdPct >= 5 && !hasAny(tags, KOL_TAGS) && !hasAny(tags, SMART_TAGS) && !hasAny(tags, DEV_TAGS)) {
    score -= 8;
    reasons.push("large anonymous bag");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  if (reasons.length === 0) reasons.push("no strong signals");
  return { score, reasons };
}

export function judgeHolder(raw: GmgnHolderRaw): JudgedWallet | null {
  const address = String(raw.address ?? "").trim();
  if (!address) return null;

  const gmgnTags = uniqTags(raw);
  const buyCount = raw.buy_tx_count_cur ?? raw.buy_count ?? 0;
  const sellCount = raw.sell_tx_count_cur ?? raw.sell_count ?? 0;
  const holdPct = toHoldPct(raw.amount_percentage ?? null);
  const twitterName = raw.twitter_name != null ? String(raw.twitter_name) : null;
  const twitterUsername = raw.twitter_username != null ? String(raw.twitter_username) : null;
  const hasTwitter = Boolean(twitterUsername || twitterName);

  const isKol = hasAny(gmgnTags, KOL_TAGS);
  const isSmart = hasAny(gmgnTags, SMART_TAGS);
  const ourLabel = pickPrimary(gmgnTags, buyCount, sellCount);
  const { score, reasons } = scoreWallet(gmgnTags, buyCount, sellCount, holdPct, hasTwitter);

  return {
    address,
    ourLabel,
    score,
    gmgnTags,
    isKol,
    isSmart,
    holdPct: Math.round(holdPct * 1000) / 1000,
    buyCount,
    sellCount,
    costUsd: num(raw.cost_usd),
    realizedPnl: num(raw.realized_profit),
    unrealizedPnl: num(raw.unrealized_profit),
    twitterName,
    twitterUsername,
    reasons,
  };
}

export function judgeHolders(list: GmgnHolderRaw[]): JudgedWallet[] {
  const out: JudgedWallet[] = [];
  const seen = new Set<string>();
  for (const row of list) {
    const j = judgeHolder(row);
    if (!j || seen.has(j.address)) continue;
    seen.add(j.address);
    out.push(j);
  }
  out.sort((a, b) => b.holdPct - a.holdPct || b.score - a.score);
  return out;
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

export function summarizeHolders(wallets: JudgedWallet[]): TokenHolderSummary {
  const analyzed = wallets.length;
  const supplyPctCovered = wallets.reduce((s, w) => s + w.holdPct, 0);
  const scores = wallets.map(w => w.score);
  const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const medianScore = median(scores);

  const kolCount = wallets.filter(w => w.isKol).length;
  const smartCount = wallets.filter(w => w.isSmart).length;
  const bundlerCount = wallets.filter(w => w.ourLabel === "bundler" || w.gmgnTags.includes("bundler")).length;
  const sniperCount = wallets.filter(w => w.ourLabel === "sniper" || w.gmgnTags.includes("sniper")).length;
  const freshCount = wallets.filter(w => w.ourLabel === "fresh" || w.gmgnTags.includes("fresh_wallet")).length;
  const botCount = wallets.filter(w => w.ourLabel === "bot").length;
  const terminalCount = wallets.filter(w => w.ourLabel === "terminal").length;
  const diamondCount = wallets.filter(w => w.ourLabel === "diamond").length;
  const retailCount = wallets.filter(w => w.ourLabel === "retail" || w.ourLabel === "unknown").length;

  const kolSupplyPct = supplyOf(wallets, w => w.isKol);
  const smartSupplyPct = supplyOf(wallets, w => w.isSmart);
  const bundlerSupplyPct = supplyOf(wallets, w => w.gmgnTags.includes("bundler"));
  const sniperSupplyPct = supplyOf(wallets, w => w.gmgnTags.includes("sniper") || w.gmgnTags.includes("snipe_bot"));
  const freshSupplyPct = supplyOf(wallets, w => w.gmgnTags.includes("fresh_wallet") || w.gmgnTags.includes("fresh"));
  const botSupplyPct = supplyOf(wallets, w => w.ourLabel === "bot");

  const riskFlags: string[] = [];
  if (bundlerSupplyPct >= 15) riskFlags.push(`bundlers hold ${bundlerSupplyPct.toFixed(1)}%`);
  if (sniperSupplyPct >= 12) riskFlags.push(`snipers hold ${sniperSupplyPct.toFixed(1)}%`);
  if (freshSupplyPct >= 20) riskFlags.push(`fresh wallets hold ${freshSupplyPct.toFixed(1)}%`);
  if (botSupplyPct >= 10) riskFlags.push(`bots hold ${botSupplyPct.toFixed(1)}%`);
  if (kolCount + smartCount === 0) riskFlags.push("no KOL/smart in sample");
  if (medianScore < 35) riskFlags.push("weak median holder score");

  // Grade from quality presence vs risk supply
  const quality = kolSupplyPct + smartSupplyPct + diamondCount * 0.5;
  const risk = bundlerSupplyPct + sniperSupplyPct * 0.8 + freshSupplyPct * 0.5 + botSupplyPct;
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
