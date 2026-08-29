/**
 * GMGN unofficial frontend tape — fills gaps the on-chain crawl misses.
 * ROI / averages / cycles stay reconstructed from TokenFill rows.
 * realized_profit / pnl_* on these payloads are ignored.
 */
import { logger } from "../core/log.ts";
import type { FillSide, TokenFill } from "../scoring/scout-fills.ts";
import {
  extractLabels, gmgnAddr, gmgnGet, gmgnList, gmgnNext, gmgnNum, gmgnStr, mergeLabels,
} from "./gmgn-client.ts";

export type GmgnRouteStatus = "ok" | "empty" | "blocked" | "error";

export type GmgnTapeResult = {
  fills: TokenFill[];
  labels: Map<string, string[]>;
  discovered: string[];
  notes: string[];
  routes: Record<string, GmgnRouteStatus>;
};

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Rec : null;
}

function sideOf(row: Rec): FillSide | null {
  const event = gmgnStr(row.event || row.side || row.type || row.eventType || row.activity_type).toLowerCase();
  if (event === "buy" || event === "buy_exact_in" || event === "open") return "buy";
  if (event === "sell" || event === "sell_exact_in" || event === "close") return "sell";
  if (row.is_buy === true) return "buy";
  if (row.is_buy === false) return "sell";
  return null;
}

function walletOf(row: Rec): string {
  return gmgnAddr(row.wallet_address)
    || gmgnAddr(row.maker)
    || gmgnAddr(row.address)
    || gmgnAddr(row.wallet)
    || gmgnAddr(row.account_address)
    || gmgnAddr(row.owner);
}

function tokenOf(row: Rec): string {
  const nested = rec(row.token);
  return gmgnAddr(row.token_address)
    || gmgnAddr(row.base_address)
    || gmgnAddr(nested?.address)
    || gmgnAddr(row.address && row.maker ? row.address : "")
    || "";
}

function tokenAmtOf(row: Rec): number | null {
  const nested = rec(row.token);
  return gmgnNum(row.token_amount)
    ?? gmgnNum(row.tokenAmount)
    ?? gmgnNum(row.base_amount)
    ?? gmgnNum(row.amount_token)
    ?? gmgnNum(nested?.amount)
    ?? gmgnNum(row.amount);
}

function usdOf(row: Rec): number | null {
  const n = gmgnNum(row.volume_usd)
    ?? gmgnNum(row.usd_value)
    ?? gmgnNum(row.amount_usd)
    ?? gmgnNum(row.cost_usd)
    ?? gmgnNum(row.costUsd)
    ?? gmgnNum(row.amountUsd);
  return n != null && n > 0 ? n : null;
}

function atOf(row: Rec): number {
  const n = gmgnNum(row.timestamp) ?? gmgnNum(row.block_unix_time) ?? gmgnNum(row.block_time) ?? 0;
  if (!(n > 0)) return 0;
  return n > 1e12 ? n : n * 1000;
}

function sigOf(row: Rec, wallet: string, side: FillSide, at: number, amt: number): string {
  const sig = gmgnStr(row.tx_hash || row.signature || row.transaction_hash || row.txHash).trim();
  if (sig) return sig;
  return `gmgn:${wallet}:${at}:${side}:${amt}`;
}

function routeStatus(blocked: boolean, status: number, n: number): GmgnRouteStatus {
  if (blocked) return "blocked";
  if (status && status !== 200) return "error";
  return n > 0 ? "ok" : "empty";
}

function addLabels(map: Map<string, string[]>, wallet: string, labels: string[]): void {
  if (!wallet || !labels.length) return;
  map.set(wallet, mergeLabels(map.get(wallet), labels));
}

/** Token-centric trade / early-buyer rows → fills. Ignores PnL fields. */
export function parseGmgnTradeRows(rows: unknown[], opts?: { mint?: string; skip?: Set<string> }): TokenFill[] {
  const skip = opts?.skip ?? new Set<string>();
  const mint = opts?.mint ?? "";
  const out: TokenFill[] = [];
  for (const raw of rows) {
    const row = rec(raw);
    if (!row) continue;
    const wallet = walletOf(row);
    if (!wallet || skip.has(wallet)) continue;
    const side = sideOf(row);
    if (!side) continue;
    if (mint) {
      const tok = tokenOf(row);
      if (tok && tok !== mint) continue;
    }
    const tokenAmt = tokenAmtOf(row);
    if (tokenAmt == null || !(tokenAmt > 0)) continue;
    const at = atOf(row);
    out.push({
      wallet,
      side,
      tokenAmt,
      usd: usdOf(row),
      at,
      sig: sigOf(row, wallet, side, at, tokenAmt),
      mc: null,
      src: "gmgn",
    });
  }
  return out;
}

export function labelsFromGmgnRows(rows: unknown[], skip?: Set<string>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const raw of rows) {
    const row = rec(raw);
    if (!row) continue;
    const wallet = walletOf(row);
    if (!wallet || skip?.has(wallet)) continue;
    addLabels(map, wallet, extractLabels(row));
  }
  return map;
}

/**
 * Holder / top-trader / smart-money rows. Wallet discovery + tags only.
 * realized_profit / total_cost / profit_change are not fills.
 */
export function walletsFromGmgnRows(rows: unknown[], skip?: Set<string>): { wallets: string[]; labels: Map<string, string[]> } {
  const wallets: string[] = [];
  const seen = new Set<string>();
  const labels = new Map<string, string[]>();
  for (const raw of rows) {
    const row = rec(raw);
    if (!row) continue;
    const wallet = walletOf(row);
    if (!wallet || skip?.has(wallet) || seen.has(wallet)) continue;
    seen.add(wallet);
    wallets.push(wallet);
    addLabels(labels, wallet, extractLabels(row));
  }
  return { wallets, labels };
}

/** Wallet activity feed, kept only when the row is this mint (or unscoped on a token-filtered URL). */
export function parseGmgnActivityRows(
  rows: unknown[],
  wallet: string,
  mint: string,
  skip?: Set<string>,
): TokenFill[] {
  if (!wallet || skip?.has(wallet)) return [];
  const out: TokenFill[] = [];
  for (const raw of rows) {
    const row = rec(raw);
    if (!row) continue;
    const side = sideOf(row);
    if (!side) continue;
    const tok = tokenOf(row);
    if (tok && tok !== mint) continue;
    const tokenAmt = tokenAmtOf(row);
    if (tokenAmt == null || !(tokenAmt > 0)) continue;
    const at = atOf(row);
    const who = walletOf(row) || wallet;
    if (who !== wallet) continue;
    out.push({
      wallet,
      side,
      tokenAmt,
      usd: usdOf(row),
      at,
      sig: sigOf(row, wallet, side, at, tokenAmt),
      mc: null,
      src: "gmgn",
    });
  }
  return out;
}

function noteRoutes(routes: Record<string, GmgnRouteStatus>): string {
  const parts = Object.entries(routes).map(([k, v]) => `${k}:${v}`);
  return `GMGN routes ${parts.join(" · ") || "none"}.`;
}

async function pullList(
  name: string,
  path: string,
  routes: Record<string, GmgnRouteStatus>,
  notes: string[],
  referer?: string,
): Promise<unknown[]> {
  const got = await gmgnGet(path, { referer });
  if (got.note && got.blocked) notes.push(`${name}: ${got.note}`);
  const rows = gmgnList(got.json);
  routes[name] = routeStatus(got.blocked, got.status, rows.length);
  return rows;
}

async function paginateTrades(
  mint: string,
  pathFor: (cursor: string | null) => string,
  name: string,
  skip: Set<string>,
  routes: Record<string, GmgnRouteStatus>,
  notes: string[],
  pages: number,
  referer: string,
): Promise<{ fills: TokenFill[]; labels: Map<string, string[]> }> {
  const fills: TokenFill[] = [];
  const labels = new Map<string, string[]>();
  let cursor: string | null = null;
  let saw = 0;
  for (let page = 0; page < pages; page++) {
    const got = await gmgnGet(pathFor(cursor), { referer });
    if (got.blocked || (got.status && got.status !== 200 && !got.json)) {
      routes[name] = routeStatus(got.blocked, got.status, fills.length);
      if (got.note) notes.push(`${name}: ${got.note}`);
      break;
    }
    const rows = gmgnList(got.json);
    const parsed = parseGmgnTradeRows(rows, { mint, skip });
    fills.push(...parsed);
    for (const [w, ls] of labelsFromGmgnRows(rows, skip)) addLabels(labels, w, ls);
    saw += rows.length;
    const next = gmgnNext(got.json, rows);
    if (!rows.length || !next || next === cursor) {
      routes[name] = routeStatus(false, got.status, fills.length);
      break;
    }
    cursor = next;
    if (rows.length < 40) {
      routes[name] = routeStatus(false, got.status, fills.length);
      break;
    }
    routes[name] = routeStatus(false, got.status, fills.length);
  }
  if (!saw && routes[name] == null) routes[name] = "empty";
  return { fills, labels };
}

/**
 * Token-centric gap-fill: trades, early tape, holders, smart money, top traders.
 * Does not call wallet_activity (that's paced separately for thin wallets).
 */
export async function loadGmgnTokenTape(
  mint: string,
  skip: Set<string>,
  on?: (phase: string, detail: string, n?: number, of?: number) => void,
): Promise<GmgnTapeResult> {
  const fills: TokenFill[] = [];
  const labels = new Map<string, string[]>();
  const discovered: string[] = [];
  const notes: string[] = [];
  const routes: Record<string, GmgnRouteStatus> = {};
  const tokenRef = `https://gmgn.ai/sol/token/${mint}`;

  on?.("gmgn", "GMGN early / token trades");
  const vas = await paginateTrades(
    mint,
    (cursor) => {
      const q = new URLSearchParams({ limit: "100", revert: "true" });
      if (cursor) q.set("cursor", cursor);
      return `/vas/api/v1/token_trades/sol/${encodeURIComponent(mint)}?${q}`;
    },
    "token_trades",
    skip,
    routes,
    notes,
    6,
    tokenRef,
  );
  fills.push(...vas.fills);
  for (const [w, ls] of vas.labels) addLabels(labels, w, ls);

  on?.("gmgn", "GMGN quotation trades");
  const qtr = await paginateTrades(
    mint,
    (cursor) => {
      const q = new URLSearchParams({ limit: "100" });
      if (cursor) q.set("from", cursor);
      return `/defi/quotation/v1/trades/sol/${encodeURIComponent(mint)}?${q}`;
    },
    "trades",
    skip,
    routes,
    notes,
    4,
    tokenRef,
  );
  fills.push(...qtr.fills);
  for (const [w, ls] of qtr.labels) addLabels(labels, w, ls);

  on?.("gmgn", "GMGN holders / traders / smart money");
  const holderRows = [
    ...await pullList("holders_vas", `/vas/api/v1/token_holders/sol/${encodeURIComponent(mint)}?orderby=amount_percentage&direction=desc&limit=100`, routes, notes, tokenRef),
    ...await pullList("holders", `/defi/quotation/v1/tokens/top_holders/sol/${encodeURIComponent(mint)}`, routes, notes, tokenRef),
  ];
  const traderRows = await pullList(
    "traders",
    `/vas/api/v1/token_traders/sol/${encodeURIComponent(mint)}?orderby=realized_profit&direction=desc&limit=100`,
    routes,
    notes,
    tokenRef,
  );
  const smartRows = await pullList(
    "smart_money",
    `/defi/quotation/v1/tokens/smart_money/sol/${encodeURIComponent(mint)}`,
    routes,
    notes,
    tokenRef,
  );

  for (const rows of [holderRows, traderRows, smartRows]) {
    const found = walletsFromGmgnRows(rows, skip);
    for (const w of found.wallets) {
      if (!discovered.includes(w)) discovered.push(w);
    }
    for (const [w, ls] of found.labels) addLabels(labels, w, ls);
  }
  // smart_money may also carry trade-shaped rows
  fills.push(...parseGmgnTradeRows(smartRows, { mint, skip }));
  for (const [w, ls] of labelsFromGmgnRows(smartRows, skip)) addLabels(labels, w, ls);

  for (const w of labels.keys()) {
    if (!discovered.includes(w) && !skip.has(w)) discovered.push(w);
  }
  for (const f of fills) {
    if (!discovered.includes(f.wallet) && !skip.has(f.wallet)) discovered.push(f.wallet);
  }

  notes.unshift(
    `GMGN gap-fill: ${fills.length} this-token fills, ${labels.size} tagged wallets, ${discovered.length} discovered.`,
  );
  notes.push(noteRoutes(routes));
  if (Object.values(routes).every((s) => s === "blocked")) {
    notes.push("GMGN is Cloudflare-blocked here. On-chain tape is unchanged; use the GMGN icon.");
  }
  logger.debug({ mint: mint.slice(0, 6), fills: fills.length, routes }, "gmgn token tape");
  return { fills, labels, discovered, notes, routes };
}

export async function loadGmgnWalletActivity(
  wallet: string,
  mint: string,
  skip?: Set<string>,
): Promise<{ fills: TokenFill[]; labels: string[]; note: string | null }> {
  const paths = [
    `/vas/api/v1/wallet_activity/sol?wallet=${encodeURIComponent(wallet)}&limit=50&token=${encodeURIComponent(mint)}`,
    `/defi/quotation/v1/wallet/sol/${encodeURIComponent(wallet)}/activities?limit=50`,
  ];
  const fills: TokenFill[] = [];
  let labels: string[] = [];
  let note: string | null = null;
  let blocked = 0;
  for (const path of paths) {
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const url = cursor ? `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : path;
      const got = await gmgnGet(url, { referer: `https://gmgn.ai/sol/address/${wallet}` });
      if (got.blocked) { blocked += 1; note = got.note; break; }
      if (!got.json) { note = got.note ?? note; break; }
      const rows = gmgnList(got.json);
      fills.push(...parseGmgnActivityRows(rows, wallet, mint, skip));
      for (const [, ls] of labelsFromGmgnRows(rows, skip)) labels = mergeLabels(labels, ls);
      const next = gmgnNext(got.json, rows);
      if (!rows.length || !next || next === cursor) break;
      cursor = next;
    }
    if (fills.length) break;
  }
  return {
    fills,
    labels,
    note: fills.length ? null : (blocked ? (note ?? "GMGN activity blocked.") : note),
  };
}

export async function gmgnWalletLabels(wallet: string): Promise<{ labels: string[]; note: string | null }> {
  const urls = [
    `/defi/quotation/v1/smartmoney/sol/walletNew/${encodeURIComponent(wallet)}?period=7d`,
    `/vas/api/v1/wallet/sol/${encodeURIComponent(wallet)}`,
  ];
  let blocked = 0;
  let empty = false;
  for (const path of urls) {
    const got = await gmgnGet(path, { referer: `https://gmgn.ai/sol/address/${wallet}` });
    if (got.blocked) { blocked += 1; continue; }
    const data = rec((rec(got.json) as Rec | null)?.data) ?? rec(got.json);
    if (!data) continue;
    const labels = extractLabels(data);
    if (labels.length) return { labels, note: null };
    empty = true;
  }
  if (empty) return { labels: [], note: "GMGN returned no tags for this wallet." };
  if (blocked) return { labels: [], note: "GMGN blocked or rate-limited the label fetch. Use the GMGN icon." };
  return { labels: [], note: "GMGN blocked or rate-limited the label fetch. Use the GMGN icon." };
}
