/**
 * Image Persistence Service
 *
 * Downloads token logos from external URLs and caches them locally so the
 * dashboard never breaks when external CDN URLs disappear.
 *
 * Storage:  /tmp/crypsor-images/{tokenId}.{ext}
 * Serving:  GET /api/assets/token/:id  (routes/assets.ts)
 * Tracking: imageStatus / imagePath columns on tracked_tokens
 *
 * On startup: validates that all DB-"ok" entries still have files on disk.
 * Resets to "none" when files are missing (happens after /tmp clears on restart).
 * Also fetches PumpFun image_uri for Solana tokens that have no logoUri.
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq, ne, or, and, isNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { eventBus } from "./event-bus";
import { fetchPumpFun } from "./price-service";

export const IMAGE_DIR = "/tmp/crypsor-images";
try { mkdirSync(IMAGE_DIR, { recursive: true }); } catch {}

const inFlight = new Set<number>();

// IPFS gateways tried in order when the primary URL fails
const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://4everland.io/ipfs/",
];

/** Extract the raw CID from any IPFS-shaped URL, or return null. */
function extractIpfsCid(url: string): string | null {
  const m = url.match(/\/ipfs\/([a-zA-Z0-9]{46,})/);
  return m ? m[1] : null;
}

/** Return all URLs to try for a logo: the original first, then IPFS gateway fallbacks. */
function candidateUrls(logoUri: string): string[] {
  const cid = extractIpfsCid(logoUri);
  if (!cid) return [logoUri];
  const extras = IPFS_GATEWAYS.map(gw => `${gw}${cid}`).filter(u => u !== logoUri);
  return [logoUri, ...extras];
}

export function localImagePath(tokenId: number, ext = "webp"): string {
  return join(IMAGE_DIR, `${tokenId}.${ext}`);
}

async function fileReady(path: string): Promise<boolean> {
  try { return (await stat(path)).size > 512; } catch { return false; }
}

async function downloadUrl(url: string, destPath: string): Promise<void> {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { "User-Agent": "Mozilla/5.0 Crypsor/1.0" },
  });
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(destPath);
    const reader = resp.body!.getReader();
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { ws.end(); break; }
          if (!ws.write(value)) await new Promise(r => ws.once("drain", r));
        }
        ws.on("finish", resolve);
        ws.on("error", reject);
      } catch (e) { ws.destroy(); reject(e); }
    })();
  });
}

export async function downloadTokenImage(tokenId: number, logoUri: string): Promise<void> {
  if (inFlight.has(tokenId)) return;
  inFlight.add(tokenId);

  const rawExt = extname(new URL(logoUri).pathname).replace(".", "") || "webp";
  const ext = ["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(rawExt) ? rawExt : "webp";
  const dest = localImagePath(tokenId, ext);

  try {
    // Already cached on disk — just make sure DB reflects it
    if (await fileReady(dest)) {
      await db.update(tracked_tokens).set({
        imageStatus: "ok",
        imagePath:   `/token/${tokenId}.${ext}`,
      }).where(eq(tracked_tokens.id, tokenId));
      return;
    }

    await db.update(tracked_tokens).set({ imageStatus: "pending" }).where(eq(tracked_tokens.id, tokenId));

    // Try the original URL first, then IPFS gateway fallbacks if applicable
    const urls = candidateUrls(logoUri);
    let lastErr: unknown;
    let downloaded = false;
    for (const url of urls) {
      try {
        await downloadUrl(url, dest);
        if (await fileReady(dest)) { downloaded = true; break; }
      } catch (e) {
        lastErr = e;
        logger.debug({ tokenId, url }, "Image candidate failed, trying next gateway");
      }
    }

    if (!downloaded) throw lastErr ?? new Error("all candidate URLs failed");

    await db.update(tracked_tokens).set({
      imageStatus: "ok",
      imagePath:   `/token/${tokenId}.${ext}`,
    }).where(eq(tracked_tokens.id, tokenId));

    logger.debug({ tokenId, ext }, "Token image cached");
  } catch (err) {
    logger.warn({ err, tokenId, logoUri }, "Image download failed");
    await db.update(tracked_tokens).set({ imageStatus: "failed" })
      .where(eq(tracked_tokens.id, tokenId));
    await db.execute(sql`UPDATE tracked_tokens SET image_retry_count = image_retry_count + 1 WHERE id = ${tokenId}`);
  } finally {
    inFlight.delete(tokenId);
  }
}

// ── Startup: validate cached files are still on disk ─────────────────────────
// /tmp is volatile — after a server restart all files are gone but DB still
// says imageStatus="ok". This resets stale entries so retryPass picks them up.

async function validateCachedImages(): Promise<void> {
  try {
    const okTokens = await db
      .select({ id: tracked_tokens.id, imagePath: tracked_tokens.imagePath })
      .from(tracked_tokens)
      .where(and(eq(tracked_tokens.imageStatus, "ok"), sql`image_path IS NOT NULL`));

    let reset = 0;
    for (const t of okTokens) {
      if (!t.imagePath) {
        await db.update(tracked_tokens).set({ imageStatus: "none", imagePath: null })
          .where(eq(tracked_tokens.id, t.id));
        reset++;
        continue;
      }
      const filename = t.imagePath.replace("/token/", "");
      const fullPath = join(IMAGE_DIR, filename);
      if (!(await fileReady(fullPath))) {
        await db.update(tracked_tokens).set({ imageStatus: "none" })
          .where(eq(tracked_tokens.id, t.id));
        reset++;
      }
    }
    if (reset > 0) logger.info({ reset }, "Image service: reset stale imageStatus entries after restart");
  } catch (err) {
    logger.warn({ err }, "Image service: startup validation failed");
  }
}

// ── Retry pass: re-attempt failed/missing + fetch PumpFun images ──────────────

async function retryPass(): Promise<void> {
  try {
    const tokens = await db
      .select({
        id:              tracked_tokens.id,
        address:         tracked_tokens.address,
        chain:           tracked_tokens.chain,
        logoUri:         tracked_tokens.logoUri,
        imageRetryCount: tracked_tokens.imageRetryCount,
      })
      .from(tracked_tokens)
      .where(
        or(
          eq(tracked_tokens.imageStatus, "failed"),
          eq(tracked_tokens.imageStatus, "none"),
          eq(tracked_tokens.imageStatus, "pending"),
        )!,
      );

    for (const t of tokens) {
      // Skip tokens that have permanently failed
      if ((t.imageRetryCount ?? 0) >= 5) continue;

      if (!t.logoUri && t.chain === "solana") {
        // Fetch image from PumpFun for pre-graduation Solana tokens
        const pf = await fetchPumpFun(t.address).catch(() => null);
        if (pf?.logo) {
          await db.update(tracked_tokens)
            .set({ logoUri: pf.logo })
            .where(eq(tracked_tokens.id, t.id));
          downloadTokenImage(t.id, pf.logo).catch(() => {});
        }
        continue;
      }

      if (!t.logoUri) continue;
      downloadTokenImage(t.id, t.logoUri).catch(() => {});
    }
  } catch (err) {
    logger.warn({ err }, "Image retry pass failed");
  }
}

export function startImageService(): void {
  eventBus.on("token:bought", async (evt) => {
    try {
      const [token] = await db
        .select({ logoUri: tracked_tokens.logoUri, imageStatus: tracked_tokens.imageStatus })
        .from(tracked_tokens).where(eq(tracked_tokens.id, evt.tokenId)).limit(1);
      if (token?.logoUri && token.imageStatus !== "ok") {
        downloadTokenImage(evt.tokenId, token.logoUri).catch(() => {});
      }
    } catch {}
  });

  // Validate cached files first, then start retry loop
  validateCachedImages().then(() => {
    setTimeout(() => retryPass(), 15_000);
    setInterval(() => retryPass(), 5 * 60_000);
  }).catch(() => {
    setTimeout(() => retryPass(), 15_000);
    setInterval(() => retryPass(), 5 * 60_000);
  });

  logger.info("Image service started");
}
