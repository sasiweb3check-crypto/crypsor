import { apiMetrics } from "./services/metrics.ts";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { pool } from "./tracking/store.ts";
import {
  tokenPage,
  summary,
  tokenDetail,
  invalidateSummary,
} from "./tracking/queries.ts";
import { trackingStatus } from "./jobs/runtime.ts";
import { enqueue } from "./jobs/queue.ts";
import type { Transaction } from "./tracking/buys.ts";

const app = express();
app.disable("x-powered-by");
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use((req, res, next) => {
  const started = performance.now();
  res.on("finish", () => {
    if (!req.path.startsWith("/api/")) return;
    const ms = performance.now() - started;
    apiMetrics.requests++;
    if (res.statusCode >= 500) apiMetrics.errors++;
    apiMetrics.totalMs += ms;
    apiMetrics.maxMs = Math.max(apiMetrics.maxMs, ms);
    apiMetrics.buckets[
      ms < 50
        ? "under50"
        : ms < 250
          ? "under250"
          : ms < 1000
            ? "under1000"
            : "over1000"
    ]++;
  });
  next();
});
app.set("trust proxy", 1);
app.use("/api/webhooks/helius", express.json({ limit: "1mb" }));
app.use(express.json({ limit: "8kb" }));
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const changes = new Map<string, { at: number; n: number }>();
app.use(["/api/wallets", "/api/sync", "/api/jobs/retry"], (req, res, next) => {
  if (req.method === "GET") {
    next();
    return;
  }
  const now = Date.now(),
    ip = req.ip ?? "unknown";
  for (const [key, value] of changes)
    if (now - value.at > 60_000) changes.delete(key);
  const bucket = changes.get(ip) ?? { at: now, n: 0 };
  if (bucket.n >= 30 || changes.size > 10000) {
    res.status(429).json({ error: "Too many changes. Please wait a minute." });
    return;
  }
  changes.set(ip, { at: bucket.at, n: bucket.n + 1 });
  next();
});
app.get("/api/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, tracking: await trackingStatus() });
  } catch (e) {
    console.error("Database health check failed", {
      code: (e as { code?: string })?.code,
    });
    res.status(503).json({ ok: false, error: "Database unavailable" });
  }
});
app.get("/api/keepalive", (_req, res) => res.json({ ok: true }));
app.get("/api/dashboard", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const [totals, page, tracking] = await Promise.all([
      summary(),
      tokenPage({
        query: String(req.query.q ?? ""),
        cursor: req.query.cursor ? String(req.query.cursor) : undefined,
        sort: String(req.query.sort ?? "recent"),
        limit: Number(req.query.limit ?? 25),
        wallet: String(req.query.wallet ?? ""),
      }),
      trackingStatus(),
    ]);
    res.json({ ...totals, ...page, tracking });
  } catch (e) {
    console.error("Dashboard query failed", {
      code: (e as { code?: string })?.code,
    });
    res
      .status(
        e instanceof Error && e.message === "Invalid page cursor" ? 400 : 503,
      )
      .json({
        error:
          e instanceof Error && e.message === "Invalid page cursor"
            ? e.message
            : "Unable to load dashboard. Check the database connection.",
      });
  }
});
app.get("/api/tokens/:mint", async (req, res) => {
  try {
    const token = await tokenDetail(String(req.params.mint));
    if (!token) {
      res.status(404).json({ error: "Token not found" });
      return;
    }
    res.json(token);
  } catch {
    res.status(503).json({ error: "Unable to load token details" });
  }
});
app.get("/api/monitoring", async (_req, res) => {
  const tracking = await trackingStatus();
  const stale = (
    await pool.query(
      "SELECT count(*)::int AS n FROM cw_wallets WHERE synced_at IS NULL OR synced_at<now()-interval '5 minutes'",
    )
  ).rows[0].n;
  res.json({
    ...tracking,
    staleWallets: stale,
    api: {
      ...apiMetrics,
      averageMs: apiMetrics.requests
        ? apiMetrics.totalMs / apiMetrics.requests
        : 0,
    },
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    },
  });
});
app.post("/api/jobs/retry", async (_req, res) => {
  await pool.query(
    "UPDATE cw_jobs SET state='queued',attempts=0,available_at=now(),published_at=NULL,finished_at=NULL WHERE id IN(SELECT j.id FROM cw_jobs j WHERE j.state='dead' AND NOT EXISTS(SELECT 1 FROM cw_jobs a WHERE a.job_key=j.job_key AND a.state IN('queued','running')) AND j.id=(SELECT max(d.id) FROM cw_jobs d WHERE d.job_key=j.job_key AND d.state='dead') LIMIT 100)",
  );
  res.json({ ok: true });
});
app.post("/api/webhooks/helius", async (req, res) => {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!secret || !equal(req.headers.authorization ?? "", secret)) {
    res.status(401).json({ error: "Unauthorized webhook" });
    return;
  }
  if (!Array.isArray(req.body) || req.body.length > 100) {
    res
      .status(400)
      .json({ error: "Expected a transaction array (maximum 100)" });
    return;
  }
  const wallets = (await pool.query("SELECT address FROM cw_wallets")).rows;
  // Store once, then queue references. Payload stays in PostgreSQL until ingestion completes.
  for (const tx of req.body as Transaction[]) {
    if (typeof tx.signature !== "string" || tx.signature.length > 128) continue;
    await pool.query(
      "INSERT INTO cw_receipts(signature,payload) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [tx.signature, JSON.stringify(tx)],
    );
    const accounts = new Set([
      ...(tx.tokenTransfers ?? []).flatMap((t) => [
        t.fromUserAccount,
        t.toUserAccount,
      ]),
      ...(tx.events?.swap?.tokenInputs ?? []).map((t) => t.userAccount),
      ...(tx.events?.swap?.tokenOutputs ?? []).map((t) => t.userAccount),
      tx.events?.swap?.nativeInput?.account,
    ]);
    for (const w of wallets)
      if (accounts.has(w.address))
        await enqueue(
          "wallet",
          `webhook:${w.address}:${tx.signature}`,
          { address: w.address, receipt: tx.signature },
          20,
        );
  }
  res.status(202).json({ ok: true });
});
function validAddress(address: string) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  let value = 0n;
  for (const c of address) value = value * 58n + BigInt(alphabet.indexOf(c));
  let bytes = 0;
  while (value > 0n) {
    bytes++;
    value >>= 8n;
  }
  return bytes + (address.match(/^1*/)?.[0].length ?? 0) === 32;
}
app.post("/api/wallets", async (req, res) => {
  const address =
    typeof req.body?.address === "string" ? req.body.address.trim() : "";
  const label =
    typeof req.body?.label === "string"
      ? req.body.label.trim().slice(0, 60)
      : "";
  if (!validAddress(address)) {
    res.status(400).json({ error: "Enter a valid Solana wallet address" });
    return;
  }
  try {
    const count = await pool.query("SELECT COUNT(*)::int AS n FROM cw_wallets");
    if (count.rows[0].n >= 100) {
      res
        .status(400)
        .json({ error: "This instance supports up to 100 wallets" });
      return;
    }
    const added = await pool.query(
      "INSERT INTO cw_wallets(address,label) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING address",
      [address, label],
    );
    if (!added.rowCount) {
      res.status(409).json({ error: "This wallet is already tracked" });
      return;
    }
    invalidateSummary();
    await enqueue("wallet", `wallet:${address}`, { address }, 10);
    res.status(201).json({ ok: true });
  } catch {
    res.status(503).json({ error: "Unable to save wallet" });
  }
});
app.delete("/api/wallets/:address", async (req, res) => {
  try {
    await pool.query("DELETE FROM cw_wallets WHERE address=$1", [
      req.params.address,
    ]);
    invalidateSummary();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: "Unable to remove wallet" });
  }
});
app.post("/api/sync", async (_req, res) => {
  await pool.query("UPDATE cw_wallets SET next_sync_at=now()");
  const wallets = (await pool.query("SELECT address FROM cw_wallets")).rows;
  for (const w of wallets)
    await enqueue("wallet", `wallet:${w.address}`, { address: w.address }, 10);
  res.status(202).json({ ok: true });
});
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
const publicDir =
  process.env.WEB_DIST ??
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../crypsor/dist/public",
  );
app.use(express.static(publicDir));
app.use((_req, res) => res.status(404).type("text").send("Not found"));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: "Invalid request" });
});
export default app;
