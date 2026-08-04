/**
 * After api-server esbuild, copy the serverless bundle + pino workers into
 * /api so Vercel can resolve them next to api/index.js.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "artifacts/api-server/dist");
const apiDir = path.join(root, "api");

await mkdir(apiDir, { recursive: true });

const files = await readdir(distDir);
let copied = 0;
for (const name of files) {
  if (!name.endsWith(".mjs") && !name.endsWith(".mjs.map")) continue;
  // Keep index.mjs (long-running host) out of the serverless folder — only
  // need vercel.mjs + pino/thread-stream workers.
  if (name === "index.mjs" || name === "index.mjs.map") continue;
  await cp(path.join(distDir, name), path.join(apiDir, name));
  copied += 1;
}

if (copied === 0 || !files.includes("vercel.mjs")) {
  console.error("[prepare-vercel-api] vercel.mjs missing from", distDir);
  process.exit(1);
}

console.log(`[prepare-vercel-api] copied ${copied} file(s) → api/`);
