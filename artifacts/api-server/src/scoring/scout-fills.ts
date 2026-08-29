/**
 * Reconstruct this-token fills into cycles, averages, and ROI.
 * GMGN fills may be merged in as src "gmgn"; GMGN PnL fields never belong here.
 */
import { isQuoteMint } from "./noise.ts";

const WSOL = "So11111111111111111111111111111111111111112";

export type FillSide = "buy" | "sell";

export type TokenFill = {
  wallet: string;
  side: FillSide;
  tokenAmt: number;
  usd: number | null;
  at: number;
  sig: string;
  mc: number | null;
  src: string;
};

export type ClosedCycle = {
  invested: number;
  proceeds: number;
  profit: number;
  holdMs: number;
  openedAt: number;
  closedAt: number;
};

export type WalletClass = "hold" | "partial" | "sold_all";

export type ScoutWallet = {
  wallet: string;
  status: WalletClass;
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
  gap: boolean;
  gmgnLegs: number;
  tape: ScoutFillTape[];
};

export type ScoutFillTape = {
  side: FillSide;
  tokenAmt: number;
  usd: number | null;
  at: number;
  sig: string;
  mc: number | null;
  src: string;
};

export function isGmgnSrc(src: string): boolean {
  return src === "gmgn" || src.startsWith("gmgn");
}

export function compactTape(fills: TokenFill[], cap = 40): ScoutFillTape[] {
  return fills.slice(0, cap).map(({ side, tokenAmt, usd, at, sig, mc, src }) => ({
    side, tokenAmt, usd, at, sig, mc, src,
  }));
}

export function expandTape(wallet: string, tape: ScoutFillTape[] | undefined): TokenFill[] {
  return (tape ?? []).map((f) => ({ wallet, ...f }));
}

export type HeliusLikeTx = {
  signature?: string;
  timestamp?: number;
  feePayer?: string;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    amount?: number;
  }>;
  tokenTransfers?: Array<{
    mint?: string;
    toUserAccount?: string;
    fromUserAccount?: string;
    tokenAmount?: number;
  }>;
  accountData?: Array<{
    account?: string;
    nativeBalanceChange?: number;
  }>;
};

const DUST = 1e-8;

export function fillKey(f: TokenFill): string {
  const sig = f.sig || `nosig:${f.at}:${f.tokenAmt}`;
  return `${sig}:${f.wallet}:${f.side}`;
}

export function dedupeFills(fills: TokenFill[]): TokenFill[] {
  const seen = new Set<string>();
  const out: TokenFill[] = [];
  for (const f of fills) {
    if (!(f.tokenAmt > 0) || !f.wallet) continue;
    const k = fillKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out.sort((a, b) => a.at - b.at || a.sig.localeCompare(b.sig));
}

/** Keep primary identity; copy missing usd/mc from extra. Extra-only rows are appended. */
export function mergeFillGaps(primary: TokenFill[], extra: TokenFill[]): TokenFill[] {
  const map = new Map<string, TokenFill>();
  for (const f of primary) {
    if (!(f.tokenAmt > 0) || !f.wallet) continue;
    map.set(fillKey(f), f);
  }
  for (const f of extra) {
    if (!(f.tokenAmt > 0) || !f.wallet) continue;
    const k = fillKey(f);
    const cur = map.get(k);
    if (!cur) {
      map.set(k, f);
      continue;
    }
    map.set(k, {
      ...cur,
      usd: cur.usd != null && cur.usd > 0 ? cur.usd : f.usd,
      mc: cur.mc != null && cur.mc > 0 ? cur.mc : f.mc,
    });
  }
  return [...map.values()].sort((a, b) => a.at - b.at || a.sig.localeCompare(b.sig));
}

function quoteFlowUsd(
  tx: HeliusLikeTx,
  wallet: string,
  solUsd: number | null,
  dir: "in" | "out",
): number | null {
  let usd = 0;
  let hit = false;
  const nativeHit = dir === "out"
    ? (n: { fromUserAccount?: string }) => n.fromUserAccount === wallet
    : (n: { toUserAccount?: string }) => n.toUserAccount === wallet;
  const tokenHit = dir === "out"
    ? (t: { fromUserAccount?: string }) => t.fromUserAccount === wallet
    : (t: { toUserAccount?: string }) => t.toUserAccount === wallet;

  for (const n of tx.nativeTransfers ?? []) {
    if (!nativeHit(n)) continue;
    const sol = Number(n.amount) / 1e9;
    if (!(sol > 0) || solUsd == null) continue;
    usd += sol * solUsd;
    hit = true;
  }
  for (const t of tx.tokenTransfers ?? []) {
    if (!tokenHit(t) || !t.mint || !isQuoteMint(t.mint)) continue;
    const amt = Number(t.tokenAmount);
    if (!(amt > 0)) continue;
    if (t.mint === WSOL) {
      if (solUsd == null) continue;
      usd += amt * solUsd;
    } else {
      usd += amt;
    }
    hit = true;
  }
  return hit ? usd : null;
}

function quoteOutUsd(tx: HeliusLikeTx, wallet: string, solUsd: number | null): number | null {
  return quoteFlowUsd(tx, wallet, solUsd, "out");
}

function quoteInUsd(tx: HeliusLikeTx, wallet: string, solUsd: number | null): number | null {
  return quoteFlowUsd(tx, wallet, solUsd, "in");
}

/**
 * One Helius enhanced tx → this-mint buy/sell legs.
 * Pool / curve / program addresses in `skip` are never wallets.
 */
export function fillsFromHeliusTx(
  tx: HeliusLikeTx,
  mint: string,
  opts: { skip?: Set<string>; solUsd?: number | null; src?: string },
): TokenFill[] {
  const skip = opts.skip ?? new Set();
  const at = Number(tx.timestamp ?? 0) * (Number(tx.timestamp) > 1e12 ? 1 : 1000);
  const sig = tx.signature || "";
  const src = opts.src ?? "pool";
  const solUsd = opts.solUsd ?? null;
  const out: TokenFill[] = [];

  for (const t of tx.tokenTransfers ?? []) {
    if (t.mint !== mint) continue;
    const amt = Number(t.tokenAmount);
    if (!(amt > 0)) continue;
    const from = t.fromUserAccount || "";
    const to = t.toUserAccount || "";
    const fromSkip = !from || skip.has(from);
    const toSkip = !to || skip.has(to);

    if (!toSkip && fromSkip) {
      out.push({
        wallet: to,
        side: "buy",
        tokenAmt: amt,
        usd: quoteOutUsd(tx, to, solUsd),
        at: Number.isFinite(at) && at > 0 ? at : 0,
        sig,
        mc: null,
        src,
      });
    } else if (!fromSkip && toSkip) {
      out.push({
        wallet: from,
        side: "sell",
        tokenAmt: amt,
        usd: quoteInUsd(tx, from, solUsd),
        at: Number.isFinite(at) && at > 0 ? at : 0,
        sig,
        mc: null,
        src,
      });
    } else if (!fromSkip && !toSkip && tx.feePayer) {
      const payer = tx.feePayer;
      if (skip.has(payer)) continue;
      if (to === payer) {
        out.push({
          wallet: payer,
          side: "buy",
          tokenAmt: amt,
          usd: quoteOutUsd(tx, payer, solUsd),
          at: Number.isFinite(at) && at > 0 ? at : 0,
          sig,
          mc: null,
          src,
        });
      } else if (from === payer) {
        out.push({
          wallet: payer,
          side: "sell",
          tokenAmt: amt,
          usd: quoteInUsd(tx, payer, solUsd),
          at: Number.isFinite(at) && at > 0 ? at : 0,
          sig,
          mc: null,
          src,
        });
      }
    }
  }
  return out;
}

export function attachMc(fill: TokenFill, mc: number | null): TokenFill {
  if (mc == null || !Number.isFinite(mc) || mc <= 0) return fill;
  return { ...fill, mc };
}

export function usdFromMc(tokenAmt: number, mc: number | null, supply: number | null): number | null {
  if (mc == null || supply == null || !(supply > 0) || !(tokenAmt > 0) || !(mc > 0)) return null;
  return (tokenAmt / supply) * mc;
}

type Lot = { tokens: number; cost: number; at: number };

export function classify(bought: number, remaining: number): WalletClass {
  if (!(bought > 0)) return remaining > DUST ? "hold" : "sold_all";
  if (remaining <= Math.max(DUST, bought * 0.02)) return "sold_all";
  if (remaining >= bought * 0.95) return "hold";
  return "partial";
}

export function bookWallet(
  wallet: string,
  fills: TokenFill[],
  opts: {
    balance?: number | null;
    priceUsd?: number | null;
    supply?: number | null;
    labels?: string[];
  } = {},
): ScoutWallet {
  const rows = dedupeFills(fills.filter((f) => f.wallet === wallet));
  const labels = [...new Set(opts.labels ?? [])].slice(0, 12);
  const das = opts.balance != null && Number.isFinite(opts.balance) ? Math.max(0, opts.balance) : null;
  if (!rows.length) {
    const remainingTokens = das ?? 0;
    return {
      wallet,
      status: remainingTokens > DUST ? "hold" : "sold_all",
      balance: remainingTokens,
      investedUsd: 0,
      proceedsUsd: 0,
      remainingUsd: 0,
      remainingTokens,
      avgBuy: null,
      avgSell: null,
      realizedRoi: null,
      overallRoi: null,
      profitUsd: 0,
      winrate: null,
      cycles: remainingTokens > DUST ? 1 : 0,
      closedCycles: 0,
      avgHoldMs: null,
      legs: 0,
      buys: 0,
      sells: 0,
      minBuyMc: null,
      buyMcs: [],
      firstAt: null,
      lastAt: null,
      lpLike: false,
      labels,
      gap: true,
      gmgnLegs: 0,
      tape: [],
    };
  }
  const lots: Lot[] = [];
  const cycles: ClosedCycle[] = [];
  let invested = 0;
  let proceeds = 0;
  let buyTokens = 0;
  let sellTokens = 0;
  let buyUsd = 0;
  let sellUsd = 0;
  let buyN = 0;
  let sellN = 0;
  let cycleOpen = 0;
  const buyMcs: number[] = [];

  for (const f of rows) {
    if (f.side === "buy") {
      const cost = f.usd != null && f.usd > 0 ? f.usd : 0;
      lots.push({ tokens: f.tokenAmt, cost, at: f.at });
      invested += cost;
      buyTokens += f.tokenAmt;
      if (f.usd != null && f.usd > 0) { buyUsd += f.usd; buyN += 1; }
      if (f.mc != null && f.mc > 0) buyMcs.push(f.mc);
      if (!cycleOpen) cycleOpen = f.at;
    } else {
      let need = f.tokenAmt;
      const opened = lots[0]?.at ?? f.at;
      while (need > DUST && lots.length) {
        const lot = lots[0];
        const take = Math.min(lot.tokens, need);
        const share = lot.tokens > 0 ? take / lot.tokens : 1;
        lot.tokens -= take;
        lot.cost -= lot.cost * share;
        need -= take;
        if (lot.tokens <= DUST) lots.shift();
      }
      const got = f.usd != null && f.usd > 0 ? f.usd : 0;
      proceeds += got;
      sellTokens += f.tokenAmt;
      if (f.usd != null && f.usd > 0) { sellUsd += f.usd; sellN += 1; }
      const left = lots.reduce((s, l) => s + l.tokens, 0);
      if (left <= DUST) {
        lots.length = 0;
        const inv = invested - cycles.reduce((s, c) => s + c.invested, 0);
        const proc = proceeds - cycles.reduce((s, c) => s + c.proceeds, 0);
        cycles.push({
          invested: Math.max(0, inv),
          proceeds: Math.max(0, proc),
          profit: proc - inv,
          holdMs: Math.max(0, f.at - (cycleOpen || opened)),
          openedAt: cycleOpen || opened,
          closedAt: f.at,
        });
        cycleOpen = 0;
      }
    }
  }

  const reconLeft = lots.reduce((s, l) => s + l.tokens, 0);
  const remainingTokens = das != null ? das : reconLeft;
  const price = opts.priceUsd != null && opts.priceUsd > 0 ? opts.priceUsd : null;
  const remainingUsd = price != null ? remainingTokens * price : 0;
  const realizedProfit = cycles.reduce((s, c) => s + c.profit, 0);
  const closedInvested = cycles.reduce((s, c) => s + c.invested, 0);
  const profitUsd = proceeds + remainingUsd - invested;
  const wins = cycles.filter((c) => c.profit > 0).length;
  const supply = opts.supply != null && opts.supply > 0 ? opts.supply : null;
  const maxInv = Math.max(buyTokens, remainingTokens);
  const lpLike = supply != null && maxInv >= supply * 0.08;

  return {
    wallet,
    status: classify(buyTokens, remainingTokens),
    balance: remainingTokens,
    investedUsd: invested,
    proceedsUsd: proceeds,
    remainingUsd,
    remainingTokens,
    avgBuy: buyTokens > 0 && buyUsd > 0 ? buyUsd / buyTokens : null,
    avgSell: sellTokens > 0 && sellUsd > 0 ? sellUsd / sellTokens : null,
    realizedRoi: closedInvested > 0 ? realizedProfit / closedInvested : null,
    overallRoi: invested > 0 ? profitUsd / invested : null,
    profitUsd,
    winrate: cycles.length ? wins / cycles.length : null,
    cycles: cycles.length + (reconLeft > DUST || remainingTokens > DUST ? 1 : 0),
    closedCycles: cycles.length,
    avgHoldMs: cycles.length ? cycles.reduce((s, c) => s + c.holdMs, 0) / cycles.length : null,
    legs: rows.length,
    buys: rows.filter((f) => f.side === "buy").length,
    sells: rows.filter((f) => f.side === "sell").length,
    minBuyMc: buyMcs.length ? Math.min(...buyMcs) : null,
    buyMcs: buyMcs.slice(0, 80),
    firstAt: rows[0]?.at ?? null,
    lastAt: rows[rows.length - 1]?.at ?? null,
    lpLike,
    labels,
    gap: rows.every((f) => isGmgnSrc(f.src)),
    gmgnLegs: rows.filter((f) => isGmgnSrc(f.src)).length,
    tape: compactTape(rows),
  };
}

export function rankWallets(books: ScoutWallet[]): ScoutWallet[] {
  return [...books].sort((a, b) => {
    if (b.profitUsd !== a.profitUsd) return b.profitUsd - a.profitUsd;
    return (b.overallRoi ?? -999) - (a.overallRoi ?? -999);
  });
}

/** Post-filter only. Does not recompute ROI. Unknown-MC wallets drop when a band is set. */
export function filterScoutWallets(
  books: ScoutWallet[],
  opts: { maxMc?: number | null; profitable?: boolean; hideLp?: boolean } = {},
): ScoutWallet[] {
  const maxMc = opts.maxMc != null && Number.isFinite(opts.maxMc) && opts.maxMc > 0 ? opts.maxMc : null;
  return books.filter((w) => {
    if (opts.hideLp && w.lpLike) return false;
    if (opts.profitable && !(w.profitUsd > 0)) return false;
    if (maxMc != null) {
      if (w.minBuyMc == null) return false;
      if (w.minBuyMc > maxMc) return false;
    }
    return true;
  });
}

export function interpolateMc(
  atMs: number,
  candles: Array<{ t: number; close: number }>,
  supply: number | null,
): number | null {
  if (!candles.length || supply == null || !(supply > 0)) return null;
  const t = atMs > 1e12 ? atMs / 1000 : atMs;
  let best = candles[0];
  let dist = Math.abs(candles[0].t - t);
  for (const c of candles) {
    const d = Math.abs(c.t - t);
    if (d < dist) { best = c; dist = d; }
  }
  if (!(best.close > 0)) return null;
  return best.close * supply;
}

export function pumpMcFromReserves(
  virtualSolLamports: number | null | undefined,
  virtualTokenRaw: number | null | undefined,
  decimals: number,
  supplyUi: number | null,
  solUsd: number | null,
): number | null {
  const sol = Number(virtualSolLamports);
  const tok = Number(virtualTokenRaw);
  if (!(sol > 0) || !(tok > 0) || solUsd == null || !(solUsd > 0)) return null;
  const tokenUi = tok / (10 ** decimals);
  if (!(tokenUi > 0)) return null;
  const priceSol = (sol / 1e9) / tokenUi;
  const supply = supplyUi != null && supplyUi > 0 ? supplyUi : tokenUi;
  return priceSol * solUsd * supply;
}
