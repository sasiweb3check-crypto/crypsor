/**
 * Same-origin token images. Dex/pump CDNs often 403 the desk; we fetch once and cache.
 * If the stored URL fails, try the Dex Solana thumb for the mint.
 */
import type { Request, Response } from "express";
import { dexTokenImage, httpsImage } from "../scoring/image";

const ALLOW = [
  "dexscreener.com",
  "ipfs.io",
  "mypinata.cloud",
  "pinata.cloud",
  "coingecko.com",
  "pump.fun",
  "cf-ipfs.com",
  "nftstorage.link",
  "arweave.net",
  "cloudfront.net",
  "googleusercontent.com",
  "pinner.irys.xyz",
  "irys.xyz",
  "dweb.link",
  "wrpcd.net",
  "filebase.io",
  "fotofolio.xyz",
  "jup.ag",
  "imgur.com",
  "twimg.com",
  "shdwdrive.com",
  "cloudflare-ipfs.com",
  "ipfs.nftstorage.link",
];

type Hit = { buf: Buffer; type: string; at: number };
const mem = new Map<string, Hit>();
const MAX = 120;
const TTL = 6 * 60 * 60_000;
const MAX_BYTES = 1_200_000;

function hostOk(host: string): boolean {
  const h = host.toLowerCase();
  return ALLOW.some((d) => h === d || h.endsWith(`.${d}`));
}

function prune(): void {
  if (mem.size <= MAX) return;
  const now = Date.now();
  for (const [k, v] of mem) {
    if (now - v.at > TTL) mem.delete(k);
  }
  if (mem.size <= MAX) return;
  const extra = mem.size - MAX;
  let n = 0;
  for (const k of mem.keys()) {
    mem.delete(k);
    n += 1;
    if (n >= extra) break;
  }
}

async function fetchImage(url: string): Promise<Hit | null> {
  const hit = mem.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit;
  let host = "";
  try { host = new URL(url).hostname; } catch { return null; }
  if (!hostOk(host)) return null;
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        Referer: "https://dexscreener.com/",
        "User-Agent": "Mozilla/5.0 (compatible; Crypsor/2.0)",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const type = (resp.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!type.startsWith("image/") && type !== "application/octet-stream") return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    const stored: Hit = { buf, type: type.startsWith("image/") ? type : "image/jpeg", at: Date.now() };
    mem.set(url, stored);
    prune();
    return stored;
  } catch {
    return null;
  }
}

export async function imageProxy(req: Request, res: Response): Promise<void> {
  const raw = typeof req.query.u === "string" ? req.query.u : "";
  const mint = typeof req.query.m === "string" ? req.query.m.trim() : "";
  const url = httpsImage(raw) ?? dexTokenImage(mint);
  if (!url) {
    res.status(400).end();
    return;
  }

  const primary = await fetchImage(url);
  const dex = dexTokenImage(mint);
  const hit = primary ?? (dex && dex !== url ? await fetchImage(dex) : null);
  if (!hit) {
    res.status(502).end();
    return;
  }
  res.setHeader("Content-Type", hit.type);
  res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  res.send(hit.buf);
}
