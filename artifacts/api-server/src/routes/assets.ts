/**
 * Asset serving route
 *
 * GET /api/assets/token/:id   — serves cached token image from disk.
 *                               Falls back to proxying the external URL.
 */

import { Router } from "express";
import { existsSync, createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq } from "drizzle-orm";
import { IMAGE_DIR, downloadTokenImage } from "../pipeline/image-service";

const router = Router();

const MIME: Record<string, string> = {
  webp: "image/webp", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
};

router.get("/token/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return void res.status(400).end();

  // 1. Check disk cache for any extension
  try {
    const files = readdirSync(IMAGE_DIR).filter(f => f.startsWith(`${id}.`));
    if (files[0]) {
      const filePath = join(IMAGE_DIR, files[0]);
      const ext = files[0].split(".").pop() ?? "webp";
      res.setHeader("Content-Type", MIME[ext] ?? "image/webp");
      res.setHeader("Cache-Control", "public, max-age=3600");
      createReadStream(filePath).pipe(res); return;
    }
  } catch {}

  // 2. Not on disk — fetch token record
  try {
    const [token] = await db.select({
      logoUri:     tracked_tokens.logoUri,
      imageStatus: tracked_tokens.imageStatus,
    }).from(tracked_tokens).where(eq(tracked_tokens.id, id)).limit(1);

    if (!token) return void res.status(404).end();

    // Kick off a background download for next time
    if (token.logoUri && token.imageStatus !== "ok") {
      downloadTokenImage(id, token.logoUri).catch(() => {});
    }

    // 3. Proxy fallback — stream external URL to client
    if (token.logoUri) {
      const upstream = await fetch(token.logoUri, {
        signal: AbortSignal.timeout(8_000),
        headers: { "User-Agent": "Mozilla/5.0 Crypsor/1.0" },
      });
      if (upstream.ok && upstream.body) {
        const ct = upstream.headers.get("content-type") ?? "image/webp";
        res.setHeader("Content-Type", ct);
        res.setHeader("Cache-Control", "public, max-age=60");
        // Stream body
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        return void res.end();
      }
    }
  } catch { /* fall through to 404 */ }

  res.status(404).end();
});

export default router;
