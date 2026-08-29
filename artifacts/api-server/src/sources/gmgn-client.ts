/**
 * Unofficial GMGN frontend fetch. Cloudflare / 429 are expected.
 * Never treat a successful JSON body as a PnL source — callers parse fills/tags only.
 */
import { logger } from "../core/log.ts";
import { pace, sleep } from "./pace.ts";

export const GMGN_ORIGIN = "https://gmgn.ai";
export const GMGN_PACE_MS = 1_200;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const KNOWN_TAGS = new Set([
  "smart_degen", "smart", "degen", "kol", "sniper", "whale", "fresh",
  "fresh_wallet", "smart_money", "dev", "insider", "bundle", "bot",
  "paper", "bluechip", "renowned", "pump_smart", "snipe_bot", "top_dev",
  "launchpad", "launchpad_smart", "creator", "gold_dog",
]);

export type GmgnGet = {
  status: number;
  json: unknown | null;
  blocked: boolean;
  note: string | null;
};

export function gmgnHeaders(referer = `${GMGN_ORIGIN}/?chain=sol`): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": UA,
    Referer: referer,
    Origin: GMGN_ORIGIN,
  };
}

export function backoffMs(attempt: number): number {
  return (2 ** attempt) * 1_000 + Math.floor(Math.random() * 500);
}

function looksHtml(text: string): boolean {
  const t = text.trimStart().slice(0, 80).toLowerCase();
  return t.startsWith("<!doctype") || t.startsWith("<html") || t.includes("just a moment");
}

export async function gmgnGet(path: string, opts?: { referer?: string; retries?: number }): Promise<GmgnGet> {
  const url = path.startsWith("http") ? path : `${GMGN_ORIGIN}${path}`;
  const retries = opts?.retries ?? 3;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pace("gmgn", GMGN_PACE_MS);
      const resp = await fetch(url, {
        headers: gmgnHeaders(opts?.referer),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await resp.text();
      if (looksHtml(text) || resp.status === 403) {
        return { status: resp.status, json: null, blocked: true, note: "GMGN Cloudflare-blocked this route." };
      }
      if (resp.status === 429 || resp.status >= 500) {
        if (attempt < retries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        return { status: resp.status, json: null, blocked: false, note: `GMGN HTTP ${resp.status} after retries.` };
      }
      if (!resp.ok) {
        return { status: resp.status, json: null, blocked: false, note: `GMGN HTTP ${resp.status}.` };
      }
      try {
        return { status: resp.status, json: JSON.parse(text) as unknown, blocked: false, note: null };
      } catch {
        return { status: resp.status, json: null, blocked: true, note: "GMGN returned non-JSON." };
      }
    } catch (err) {
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      logger.debug({ err, path: url.replace(GMGN_ORIGIN, "") }, "gmgn get failed");
      return { status: 0, json: null, blocked: false, note: "GMGN network error." };
    }
  }
  return { status: 0, json: null, blocked: false, note: "GMGN failed." };
}

export function asLabels(v: unknown): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim().toLowerCase().replace(/\s+/g, "_");
    if (t && t.length < 40) out.push(t);
  };
  if (Array.isArray(v)) {
    for (const x of v) {
      if (typeof x === "string") push(x);
      else if (x && typeof x === "object" && "name" in x && typeof (x as { name: unknown }).name === "string") {
        push((x as { name: string }).name);
      }
    }
  } else if (typeof v === "string") {
    for (const part of v.split(/[,|]/)) push(part);
  }
  return [...new Set(out)].slice(0, 12);
}

export function keepTag(t: string): boolean {
  if (t.startsWith("name:")) return true;
  return KNOWN_TAGS.has(t)
    || t.includes("smart") || t.includes("kol") || t.includes("snipe")
    || t.includes("whale") || t.includes("fresh") || t.includes("dev")
    || t.includes("launch");
}

export function extractLabels(rec: Record<string, unknown> | null | undefined): string[] {
  if (!rec) return [];
  const labels = [
    ...asLabels(rec.tags),
    ...asLabels(rec.tag),
    ...asLabels(rec.labels),
    ...asLabels(rec.wallet_tag),
    ...asLabels(rec.wallet_tags),
    ...asLabels(rec.maker_token_tags),
    ...asLabels(rec.maker_tags),
  ].filter(keepTag);
  const name = rec.maker_name || rec.twitter_name || rec.twitter_username || rec.name;
  if (typeof name === "string" && name.trim() && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(name.trim())) {
    labels.unshift(`name:${name.trim().slice(0, 32)}`);
  }
  return [...new Set(labels)].slice(0, 10);
}

export function gmgnNum(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

export function gmgnStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function gmgnAddr(v: unknown): string {
  const s = gmgnStr(v).trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) ? s : "";
}

export function gmgnList(json: unknown): unknown[] {
  if (!json || typeof json !== "object") return [];
  const root = json as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;
  for (const key of ["history", "trades", "list", "rank", "holders", "activities", "tokens", "wallets"]) {
    const v = data[key];
    if (Array.isArray(v)) return v;
  }
  if (Array.isArray(data)) return data;
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
  }
  return [];
}

export function gmgnNext(json: unknown, rows: unknown[]): string | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;
  for (const key of ["next", "cursor", "next_cursor"]) {
    const v = data[key] ?? root[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return String(v);
  }
  const last = rows[rows.length - 1];
  if (last && typeof last === "object") {
    const rec = last as Record<string, unknown>;
    const id = rec.id ?? rec.cursor;
    if (typeof id === "string" && id.trim()) return id.trim();
    const ts = gmgnNum(rec.timestamp ?? rec.block_unix_time ?? rec.block_time);
    if (ts != null && ts > 0) return String(ts);
  }
  return null;
}

export function mergeLabels(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])].slice(0, 12);
}
