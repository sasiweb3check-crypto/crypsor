/**
 * Holder-supply concentration — the check GMGN labels "Holders Rug Possible".
 *
 * Mint/freeze revoked and LP burned are not inputs and cannot pass this.
 * Missing RPC is skip, never 0% as safe.
 */

export const LP_MIN_PCT = 10;
export const CLUSTER_MIN_PCT = 3;
export const CLUSTER_MAX_PCT = 12;
export const CLUSTER_RUG_N = 4;
export const TOP10_EXCL_RUG = 50;
export const TOP10_INCL_RUG = 70;
export const TOP20_RUG = 80;
export const TOP10_EXCL_CAUTION = 40;

export type HolderRugVerdict = {
  holdersRug: boolean;
  holdersCaution: boolean;
  reason: string | null;
};

export type HolderRugBook = HolderRugVerdict & {
  holders: number | null;
  top10Pct: number | null;
  top10ExclLp: number | null;
  top20Pct: number | null;
  lpPct: number | null;
  clusterN: number | null;
  /** True only when supply + largest accounts actually printed percents. */
  measured: boolean;
};

export const EMPTY_HOLDER_BOOK: HolderRugBook = {
  holders: null,
  top10Pct: null,
  top10ExclLp: null,
  top20Pct: null,
  lpPct: null,
  clusterN: null,
  holdersRug: false,
  holdersCaution: false,
  reason: null,
  measured: false,
};

function num(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

type TokenAmount = {
  amount?: string | number;
  decimals?: number;
  uiAmount?: number | null;
  uiAmountString?: string | null;
};

/** uiAmount, else amount / 10^decimals. Null if neither is usable. */
export function uiAmountOf(v: TokenAmount | null | undefined): number | null {
  if (!v || typeof v !== "object") return null;
  if (v.uiAmount != null && Number.isFinite(v.uiAmount) && v.uiAmount >= 0) return v.uiAmount;
  if (v.uiAmountString != null && v.uiAmountString !== "") {
    const n = Number(v.uiAmountString);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const raw = Number(v.amount);
  if (!Number.isFinite(raw) || raw < 0) return null;
  const dec = v.decimals;
  if (dec != null && Number.isFinite(dec) && dec >= 0) return raw / (10 ** dec);
  return raw;
}

export function parseTokenSupply(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const value = "value" in result ? (result as { value?: TokenAmount }).value : result as TokenAmount;
  return uiAmountOf(value);
}

export function parseLargestUiAmounts(result: unknown): number[] {
  if (!result || typeof result !== "object") return [];
  const value = "value" in result ? (result as { value?: unknown }).value : result;
  const rows = Array.isArray(value) ? value : [];
  const out: number[] = [];
  for (const row of rows) {
    const n = uiAmountOf(row as TokenAmount);
    if (n != null && n > 0) out.push(n);
  }
  return out;
}

export function percentsOf(amounts: number[], supply: number): number[] {
  if (!Number.isFinite(supply) || supply <= 0) return [];
  return amounts
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => (n / supply) * 100);
}

export function holderRugOf(opts: {
  top10Pct?: number | null;
  top10ExclLp?: number | null;
  top20Pct?: number | null;
  clusterN?: number | null;
}): HolderRugVerdict {
  const excl = num(opts.top10ExclLp);
  const top10 = num(opts.top10Pct);
  const top20 = num(opts.top20Pct);
  const cluster = num(opts.clusterN);

  if (excl != null && excl >= TOP10_EXCL_RUG) {
    return { holdersRug: true, holdersCaution: false, reason: `top10 excl LP ${excl.toFixed(1)}%` };
  }
  if (top10 != null && top10 >= TOP10_INCL_RUG) {
    return { holdersRug: true, holdersCaution: false, reason: `top10 ${top10.toFixed(1)}%` };
  }
  if (top20 != null && top20 >= TOP20_RUG) {
    return { holdersRug: true, holdersCaution: false, reason: `top20 ${top20.toFixed(1)}%` };
  }
  if (cluster != null && cluster >= CLUSTER_RUG_N) {
    return { holdersRug: true, holdersCaution: false, reason: `clustered wallets ${cluster}` };
  }
  if (excl != null && excl >= TOP10_EXCL_CAUTION) {
    return { holdersRug: false, holdersCaution: true, reason: `top10 excl LP ${excl.toFixed(1)}%` };
  }
  return { holdersRug: false, holdersCaution: false, reason: null };
}

export function holderBookFromPercents(
  pcts: number[],
  holderCount: number | null = null,
): HolderRugBook {
  const sorted = pcts.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => b - a);
  if (!sorted.length) {
    return { ...EMPTY_HOLDER_BOOK, holders: holderCount };
  }

  const lpPct = sorted[0] >= LP_MIN_PCT ? sorted[0] : null;
  const rest = lpPct != null ? sorted.slice(1) : sorted;
  const top10Pct = sum(sorted.slice(0, 10));
  const top10ExclLp = sum(rest.slice(0, 10));
  const top20Pct = sum(sorted.slice(0, 20));
  const clusterN = rest.filter((p) => p >= CLUSTER_MIN_PCT && p <= CLUSTER_MAX_PCT).length;
  const verdict = holderRugOf({ top10Pct, top10ExclLp, top20Pct, clusterN });

  return {
    holders: holderCount,
    top10Pct,
    top10ExclLp,
    top20Pct,
    lpPct,
    clusterN,
    measured: true,
    ...verdict,
  };
}

export function holderBookFromRpc(
  largestResult: unknown,
  supplyResult: unknown,
  holderCount: number | null = null,
): HolderRugBook {
  const supply = parseTokenSupply(supplyResult);
  const amounts = parseLargestUiAmounts(largestResult);
  if (supply == null || amounts.length === 0) {
    return { ...EMPTY_HOLDER_BOOK, holders: holderCount };
  }
  return holderBookFromPercents(percentsOf(amounts, supply), holderCount);
}

/** Product line matching the GMGN warning, driven by top-10 excl LP. */
export function holdersRugLine(opts: {
  holdersRug?: boolean | null;
  top10ExclLp?: number | null;
  reason?: string | null;
}): string | null {
  if (!opts.holdersRug) return null;
  const excl = num(opts.top10ExclLp);
  if (excl != null) return `holders rug possible · top10 excl LP ${excl.toFixed(1)}%`;
  if (opts.reason) return `holders rug possible · ${opts.reason}`;
  return "holders rug possible";
}
