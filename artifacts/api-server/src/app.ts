import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
app.disable("x-powered-by");
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/keepalive", (_req, res) => res.json({ ok: true }));
const publicDir = process.env.WEB_DIST ?? path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../crypsor/dist/public",
);
app.use(express.static(publicDir));
app.use((_req, res) => res.status(404).type("text").send("Not found"));
export default app;
