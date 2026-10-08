import { build } from "esbuild";
import { rm } from "node:fs/promises";
import path from "node:path";

const root = import.meta.dirname;
await rm(path.join(root, "dist"), { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, "src/index.ts"), path.join(root, "src/worker-entry.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  packages: "external",
  outdir: path.join(root, "dist"),
  outExtension: { ".js": ".mjs" },
  sourcemap: true,
  logLevel: "info",
});
