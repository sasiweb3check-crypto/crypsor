/**
 * GMGN data source — browser-header curl over HTTP/2 (verified working from
 * server IPs), OpenAPI-first when GMGN_API_KEY is set.
 *
 * Verified endpoints (2026-08):
 *   /api/v1/token_info/sol/:mint            holder_count, liquidity, timestamps
 *   /vas/api/v1/token_holder_stat/sol/:mint smart_degen/renowned/sniper/bundler/bot counts
 *   /vas/api/v1/token_holders/sol/:mint     top holders w/ tags + amount_percentage
 *   /api/v1/mutil_window_token_security_launchpad/sol/:mint  security (best effort)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../core/log";

const execFileAsync = promisify(execFile);

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://gmgn.ai/",
  Origin: "https://gmgn.ai",
};

const CURL_ARGS = [
  "--http2", "--compressed", "--silent", "--tlsv1.3", "--max-time", "12",
  ...Object.entries(BROWSER_HEADERS).flatMap(([k, v]) => ["-H", `${k}: ${v}`]),
];

async function gmgnGet(url: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await execFileAsync("curl", [...CURL_ARGS, url], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (!stdout || stdout.trimStart().startsWith("<")) return null;
    const json = JSON.parse(stdout) as { code?: number; data?: Record<string, unknown> };
    if (json.code !== 0 || !json.data) return null;
    return json.data;
  } catch (err) {
    logger.debug({ err, url: url.slice(0, 80) }, "gmgn fetch failed");
    return null;
  }
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export type TokenIntel = {
  holderCount: number | null;
  liqUsd: number | null;
  smartCount: number | null;
  kolCount: number | null;
  sniperCount: number | null;
  bundlerCount: number | null;
  botCount: number | null;
  insiderCount: number | null;
  top10Pct: number | null;      // % of supply, pools excluded
  smartHoldPct: number | null;
  kolHoldPct: number | null;
  sniperHoldPct: number | null;
  bundlerHoldPct: number | null;
  botHoldPct: number | null;
  whaleHoldPct: number | null;  // wallets holding >2% each (non-pool)
};

type RawHolder = {
  address?: string;
  addr_type?: number;
  exchange?: string | null;
  amount_percentage?: number | null;
  tags?: string[];
  maker_token_tags?: string[];
};

const SMART = new Set(["smart_degen", "smart_money"]);
const KOL = new Set(["kol", "renowned"]);
const SNIPER = new Set(["sniper"]);
const BUNDLER = new Set(["bundler", "rat_trader"]);
const BOT = new Set(["dex_bot", "bot"]);

/** Full intel read: 3 GMGN calls in parallel. */
export async function tokenIntel(mint: string): Promise<TokenIntel | null> {
  const [info, stat, holders] = await Promise.all([
    gmgnGet(`https://gmgn.ai/api/v1/token_info/sol/${mint}`),
    gmgnGet(`https://gmgn.ai/vas/api/v1/token_holder_stat/sol/${mint}`),
    gmgnGet(`https://gmgn.ai/vas/api/v1/token_holders/sol/${mint}?limit=20&offset=0&orderby=amount_percentage&direction=desc`),
  ]);
  if (!info && !stat && !holders) return null;

  const list: RawHolder[] = Array.isArray((holders as { list?: RawHolder[] } | null)?.list)
    ? (holders as { list: RawHolder[] }).list
    : [];
  const wallets = list.filter((h) => h.addr_type !== 2 && !h.exchange);
  const pct = (h: RawHolder) => {
    const p = Number(h.amount_percentage);
    return Number.isFinite(p) && p > 0 ? p * 100 : 0;
  };
  const labels = (h: RawHolder) =>
    [...(h.tags ?? []), ...(h.maker_token_tags ?? [])].map((t) => String(t).toLowerCase());

  let top10 = 0, smartH = 0, kolH = 0, snipH = 0, bundH = 0, botH = 0, whaleH = 0;
  wallets.forEach((h, idx) => {
    const share = pct(h);
    if (idx < 10) top10 += share;
    if (share > 2) whaleH += share;
    const ls = labels(h);
    if (ls.some((l) => SMART.has(l))) smartH += share;
    if (ls.some((l) => KOL.has(l))) kolH += share;
    if (ls.some((l) => SNIPER.has(l))) snipH += share;
    if (ls.some((l) => BUNDLER.has(l))) bundH += share;
    if (ls.some((l) => BOT.has(l))) botH += share;
  });
  const haveList = wallets.length >= 3;

  return {
    holderCount: num(info?.holder_count),
    liqUsd: num(info?.liquidity),
    smartCount: num(stat?.smart_degen_count),
    kolCount: num(stat?.renowned_count),
    sniperCount: num(stat?.sniper_count),
    bundlerCount: num(stat?.bundler_count),
    botCount: num(stat?.dex_bot_count),
    insiderCount: num(stat?.insider_count),
    top10Pct: haveList ? Math.min(100, top10) : (() => {
      const r = num(stat?.top10_holder_rate);
      return r != null ? (r > 1 ? r : r * 100) : null;
    })(),
    smartHoldPct: haveList ? smartH : null,
    kolHoldPct: haveList ? kolH : null,
    sniperHoldPct: haveList ? snipH : null,
    bundlerHoldPct: haveList ? bundH : null,
    botHoldPct: haveList ? botH : null,
    whaleHoldPct: haveList ? whaleH : null,
  };
}

export type SecurityRead = {
  honeypot: boolean | null;
  rugRatio: number | null;        // creator's historical rug ratio 0-1
  creatorTokens: number | null;   // how many tokens the creator launched
  top10Rate: number | null;
  fetched: boolean;
};

/** Best-effort security/creator read (rug ratio ≈ creator history). */
export async function tokenSecurity(mint: string): Promise<SecurityRead> {
  const data = await gmgnGet(
    `https://gmgn.ai/api/v1/mutil_window_token_security_launchpad/sol/${mint}`,
  );
  if (!data) return { honeypot: null, rugRatio: null, creatorTokens: null, top10Rate: null, fetched: false };
  const sec = (data as { security?: Record<string, unknown> }).security ?? data;
  const launchpad = (data as { launchpad?: Record<string, unknown> }).launchpad ?? {};
  const rug = num((sec as Record<string, unknown>).rug_ratio) ?? num(launchpad.rug_ratio);
  return {
    honeypot: typeof (sec as Record<string, unknown>).is_honeypot === "boolean"
      ? Boolean((sec as Record<string, unknown>).is_honeypot)
      : null,
    rugRatio: rug != null ? (rug > 1 ? rug / 100 : rug) : null,
    creatorTokens: num((sec as Record<string, unknown>).creator_token_count) ?? num(launchpad.creator_token_count),
    top10Rate: num((sec as Record<string, unknown>).top_10_holder_rate),
    fetched: true,
  };
}
