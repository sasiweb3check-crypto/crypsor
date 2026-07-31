/**
 * Crypsor wallet behaviour scoring — OWN labels, not GMGN KOL/smart.
 *
 * Inputs come from token_holder_snapshots.holders_data (raw holder rows).
 * We deliberately ignore GMGN reputation tags when assigning ourLabel.
 */

export type CrypsorLabel =
  | "diamond"
  | "accumulator"
  | "solid"
  | "watch"
  | "flipper"
  | "dump"
  | "whale"
  | "noise";

export type RawHolderRow = {
  address?: string | null;
  account_address?: string | null;
  amount_percentage?: number | null;
  balance?: number | string | null;
  buy_tx_count_cur?: number | null;
  sell_tx_count_cur?: number | null;
  buy_count?: number | null;
  sell_count?: number | null;
  realized_profit?: number | null;
  unrealized_profit?: number | null;
  native_balance?: number | null;
  last_active_timestamp?: number | null;
};

export type CrypsorJudgment = {
  address: string;
  ourLabel: CrypsorLabel;
  behaviourScore: number;
  holdPct: number; // 0–100
  buyCount: number;
  sellCount: number;
  realizedPnl: number;
  reason: string;
  /** Immediate weight bump for this sighting (good wallets > 0) */
  weightDelta: number;
};

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** amount_percentage is usually a fraction (0.021 = 2.1%). */
export function holdPctOf(h: RawHolderRow): number {
  const raw = num(h.amount_percentage);
  if (raw <= 0) return 0;
  return Math.abs(raw) <= 1 ? raw * 100 : raw;
}

export function walletAddressOf(h: RawHolderRow): string {
  return String(h.address ?? h.account_address ?? "").trim();
}

export function judgeHolder(h: RawHolderRow): CrypsorJudgment | null {
  const address = walletAddressOf(h);
  if (!address || address.length < 20) return null;

  const holdPct = holdPctOf(h);
  const buyCount = Math.max(0, Math.round(num(h.buy_count ?? h.buy_tx_count_cur)));
  const sellCount = Math.max(0, Math.round(num(h.sell_count ?? h.sell_tx_count_cur)));
  const realizedPnl = num(h.realized_profit);
  const unrealizedPnl = num(h.unrealized_profit);

  let score = 40; // neutral base
  const bits: string[] = [];

  // Position size — mid bags healthier than micro dust or mega whales
  if (holdPct >= 0.05 && holdPct < 2) {
    score += 12;
    bits.push("mid bag");
  } else if (holdPct >= 2 && holdPct < 5) {
    score += 6;
    bits.push("sizeable");
  } else if (holdPct >= 5) {
    score -= 4;
    bits.push("whale bag");
  } else if (holdPct > 0 && holdPct < 0.02) {
    score -= 6;
    bits.push("dust");
  }

  // Buy / sell behaviour
  if (buyCount > 0 && sellCount === 0) {
    score += 18;
    bits.push("holds only");
  } else if (buyCount > sellCount * 2) {
    score += 14;
    bits.push("net accumulator");
  } else if (buyCount > sellCount) {
    score += 8;
    bits.push("more buys");
  } else if (sellCount > buyCount * 2 && buyCount > 0) {
    score -= 22;
    bits.push("heavy seller");
  } else if (sellCount > buyCount) {
    score -= 12;
    bits.push("net seller");
  } else if (buyCount === 0 && sellCount > 0) {
    score -= 18;
    bits.push("sell-only");
  }

  // PnL while still holding
  if (unrealizedPnl > 0 && holdPct >= 0.05) {
    score += 10;
    bits.push("green bag");
  }
  if (realizedPnl > 500 && sellCount > 0 && holdPct >= 0.05) {
    score += 6;
    bits.push("banked + still in");
  }
  if (realizedPnl < -200 && sellCount >= buyCount && buyCount > 0) {
    score -= 8;
    bits.push("realized loss dump");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Label priority (behaviour-first; whale is structural override at high %)
  let ourLabel: CrypsorLabel = "noise";
  if (holdPct >= 8) {
    ourLabel = "whale";
  } else if (sellCount > buyCount * 2 && buyCount > 0) {
    ourLabel = "dump";
  } else if (sellCount > buyCount && buyCount > 0) {
    ourLabel = "flipper";
  } else if (score >= 78 && sellCount === 0 && buyCount > 0) {
    ourLabel = "diamond";
  } else if (score >= 65 && buyCount > sellCount) {
    ourLabel = "accumulator";
  } else if (score >= 52) {
    ourLabel = "solid";
  } else if (score >= 38) {
    ourLabel = "watch";
  } else {
    ourLabel = "noise";
  }

  let weightDelta = 0;
  if (ourLabel === "diamond") weightDelta = 3;
  else if (ourLabel === "accumulator") weightDelta = 2;
  else if (ourLabel === "solid") weightDelta = 1;
  else if (ourLabel === "whale" && score >= 55) weightDelta = 1;
  else if (ourLabel === "dump" || ourLabel === "flipper") weightDelta = -1;

  return {
    address,
    ourLabel,
    behaviourScore: score,
    holdPct: Math.round(holdPct * 10_000) / 10_000,
    buyCount,
    sellCount,
    realizedPnl,
    reason: bits.slice(0, 3).join(" · ") || ourLabel,
    weightDelta,
  };
}

/** Good wallets we want to credit on 2× wins / penalize on losses. */
export function isQualityLabel(label: string | null | undefined): boolean {
  return label === "diamond" || label === "accumulator" || label === "solid";
}
