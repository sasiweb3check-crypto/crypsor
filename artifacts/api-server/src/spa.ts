/**
 * Serve the Vite desk (artifacts/crypsor/dist/public) from this process so
 * Render can host API + SPA on one origin. No-ops when the build output is
 * missing (Vercel / API-only local).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import express from "express";
import { logger } from "./core/log";

export function resolvePublicDir(): string | null {
  const fromEnv = process.env.WEB_DIST?.trim();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    fromEnv ? path.resolve(fromEnv) : null,
    path.resolve(here, "../../crypsor/dist/public"),
    path.resolve(process.cwd(), "artifacts/crypsor/dist/public"),
    path.resolve(process.cwd(), "dist/public"),
  ].filter((dir): dir is string => Boolean(dir));

  for (const dir of candidates) {
    if (existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

export function mountSpa(app: Express): string | null {
  const publicDir = resolvePublicDir();
  if (!publicDir) {
    logger.info("SPA static dir not found — API-only mode");
    return null;
  }

  app.use(
    express.static(publicDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        } else {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(publicDir, "index.html"), (err) => {
      if (err) next(err);
    });
  });

  logger.info({ publicDir }, "serving desk SPA");
  return publicDir;
}
