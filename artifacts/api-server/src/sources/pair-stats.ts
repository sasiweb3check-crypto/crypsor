/**
 * DexScreener pair fields — pure reads, no fetch.
 */
export type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  pairCreatedAt?: number;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h6?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  boosts?: { active?: number };
  labels?: string[];
  baseToken?: { address?: string; symbol?: string; name?: string };
  info?: { imageUrl?: string; header?: string };
};

export function posInt(v: unknown): number | null {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function countOf(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function mcOf(pair: DexPair | null | undefined): number | null {
  const n = Number(pair?.marketCap ?? pair?.fdv ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function vol5mOf(pair: DexPair | null | undefined): number | null {
  return posInt(pair?.volume?.m5);
}

export function liqOf(pair: DexPair | null | undefined): number | null {
  return posInt(pair?.liquidity?.usd);
}

export function volH1Of(pair: DexPair | null | undefined): number | null {
  return posInt(pair?.volume?.h1);
}

export function buys5mOf(pair: DexPair | null | undefined): number | null {
  return countOf(pair?.txns?.m5?.buys);
}

export function sells5mOf(pair: DexPair | null | undefined): number | null {
  return countOf(pair?.txns?.m5?.sells);
}

export function buysH1Of(pair: DexPair | null | undefined): number | null {
  return countOf(pair?.txns?.h1?.buys);
}

export function sellsH1Of(pair: DexPair | null | undefined): number | null {
  return countOf(pair?.txns?.h1?.sells);
}

export function priceChgM5Of(pair: DexPair | null | undefined): number | null {
  const n = Number(pair?.priceChange?.m5);
  return Number.isFinite(n) ? n : null;
}

export function priceChgH1Of(pair: DexPair | null | undefined): number | null {
  const n = Number(pair?.priceChange?.h1);
  return Number.isFinite(n) ? n : null;
}

export function boostsOf(pair: DexPair | null | undefined): number | null {
  return posInt(pair?.boosts?.active);
}

export function pairAgeHours(pair: DexPair | null | undefined, now = Date.now()): number | null {
  const at = Number(pair?.pairCreatedAt ?? 0);
  if (!Number.isFinite(at) || at <= 0) return null;
  const ms = at < 1e12 ? at * 1000 : at;
  const hours = (now - ms) / 3_600_000;
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
}
