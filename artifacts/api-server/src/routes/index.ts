/**
 * Wallet-buy desk API — list, search, pagination, token chart, wallets, settings.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "../core/db";
import { sseHandler } from "../core/bus";
import { cached, cacheBackend } from "../core/cache";
import { agentStatus, ensureRuntime, runFullTick } from "../funnel/runtime";
import { heliusKey, setSetting, getSetting } from "../core/settings";
import { listTokens, getToken, listNotices, type TokenStatus } from "../agents/board";
import { imageProxy } from "./img";

const router: IRouter = Router();

const ok = (data: unknown) => ({ ok: true, data });
const fail = (error: string) => ({ ok: false, error });

const STATUSES = ["live", "running", "dead"] as const;

router.use((req, _res, next) => {
  if (req.path === "/img") {
    next();
    return;
  }
  void ensureRuntime().finally(() => next());
});

router.get("/img", (req, res) => { void imageProxy(req, res); });

router.get("/healthz", async (_req, res) => {
  try {
    const t0 = Date.now();
    await pool.query("SELECT 1");
    const dbMs = Date.now() - t0;
    let census: Record<string, number> = {};
    let lastScanAt: unknown = null;
    try {
      const counts = await pool.query(
        `SELECT COALESCE(phase, 'live') AS phase, COUNT(*)::int AS n
         FROM f2_tokens
         WHERE wallet_buys > 0
         GROUP BY 1`,
      );
      const lastScan = await pool.query(
        `SELECT MAX(last_scan_at) AS at FROM f2_tokens WHERE wallet_buys > 0`,
      );
      census = Object.fromEntries(
        counts.rows.map((r: { phase: string; n: number }) => [r.phase, r.n]),
      );
      lastScanAt = lastScan.rows[0]?.at ?? null;
    } catch {
      // first boot
    }
    res.json(ok({
      db: `${dbMs}ms`,
      helius: Boolean(await heliusKey()),
      census,
      lastScanAt,
      cache: cacheBackend(),
      agents: agentStatus(),
    }));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : "health failed"));
  }
});

const TICK_BUDGET_MS = 35_000;
let lastKeepalive = 0;

async function boundedTick(): Promise<Record<string, unknown>> {
  const tick = runFullTick().catch(() => ({ tick: "error" }));
  const timeout = new Promise<Record<string, unknown>>((resolve) =>
    setTimeout(() => resolve({ tick: "running_in_background" }), TICK_BUDGET_MS));
  return Promise.race([tick, timeout]);
}

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) return (req.headers.authorization ?? "") === `Bearer ${secret}`;
  return true;
}

async function keepaliveHandler(_req: Request, res: Response) {
  const now = Date.now();
  if (now - lastKeepalive < 20_000) {
    res.json(ok({ skipped: true, retryInMs: 20_000 - (now - lastKeepalive) }));
    return;
  }
  lastKeepalive = now;
  res.json(ok({ ...(await boundedTick()), at: new Date().toISOString() }));
}

router.get("/keepalive", (req, res) => { void keepaliveHandler(req, res); });
router.post("/keepalive", (req, res) => { void keepaliveHandler(req, res); });
router.get("/cron/tick", (req, res) => {
  if (!cronAuthorized(req)) { res.status(401).json(fail("unauthorized")); return; }
  void boundedTick().then((r) => res.json(ok({ ...r, at: new Date().toISOString() })));
});
router.post("/cron/tick", (req, res) => {
  if (!cronAuthorized(req)) { res.status(401).json(fail("unauthorized")); return; }
  void boundedTick().then((r) => res.json(ok({ ...r, at: new Date().toISOString() })));
});

function boardQuery(req: Request): {
  page: number;
  limit: number;
  q: string;
  status: TokenStatus | "all";
  band: "early" | "all";
} {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 80);
  const q = String(req.query.q ?? "").trim();
  const raw = String(req.query.status ?? "all").toLowerCase();
  const status: TokenStatus | "all" = (STATUSES as readonly string[]).includes(raw) ? raw as TokenStatus : "all";
  const band = String(req.query.band ?? "all").toLowerCase() === "early" ? "early" : "all";
  return { page, limit, q, status, band };
}

async function sendBoard(req: Request, res: Response): Promise<void> {
  try {
    const query = boardQuery(req);
    const payload = await cached(
      `tokens:${query.status}:${query.band}:${query.page}:${query.limit}:${query.q}`,
      2_000,
      () => listTokens(query),
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(ok(payload));
  } catch (err) {
    console.error("tokens failed", err);
    res.status(500).json(fail("tokens failed"));
  }
}

router.get("/tokens", (req, res) => { void sendBoard(req, res); });
router.get("/stats", (req, res) => { void sendBoard(req, res); });
router.get("/desk", (req, res) => { void sendBoard(req, res); });

router.get("/tokens/:id", async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) { res.status(400).json(fail("bad id")); return; }
    const body = await getToken(id);
    if (!body) { res.status(404).json(fail("not found")); return; }
    res.setHeader("Cache-Control", "private, max-age=3");
    res.json(ok(body));
  } catch (err) {
    console.error("token failed", err);
    res.status(500).json(fail("token failed"));
  }
});

router.get("/patient/:id", async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) { res.status(400).json(fail("bad id")); return; }
    const body = await getToken(id);
    if (!body) { res.status(404).json(fail("not found")); return; }
    res.json(ok(body));
  } catch (err) {
    res.status(500).json(fail("token failed"));
  }
});

router.get("/wallets", async (_req, res) => {
  const r = await pool.query("SELECT id, address, label, created_at FROM walletdatasource ORDER BY id");
  res.json(ok(r.rows));
});

router.post("/wallets", async (req, res) => {
  const address = String(req.body?.address ?? "").trim();
  const label = String(req.body?.label ?? "").trim() || null;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    res.status(400).json(fail("invalid solana address"));
    return;
  }
  await pool.query(
    `INSERT INTO walletdatasource (address, label, chain) VALUES ($1,$2,'solana')
     ON CONFLICT (address) DO UPDATE SET label = COALESCE(EXCLUDED.label, walletdatasource.label)`,
    [address, label],
  );
  res.json(ok({ added: address }));
});

router.delete("/wallets/:id", async (req, res) => {
  await pool.query("DELETE FROM walletdatasource WHERE id = $1", [parseInt(String(req.params.id), 10)]);
  res.json(ok({ deleted: true }));
});

const SETTING_KEYS = ["helius_api_key", "telegram_bot_token", "telegram_chat_id"];

router.get("/settings", async (_req, res) => {
  const out: Record<string, string | null> = {};
  for (const k of SETTING_KEYS) {
    const v = await getSetting(k);
    out[k] = v ? `••••${v.slice(-6)}` : null;
  }
  res.json(ok(out));
});

router.put("/settings", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const saved: string[] = [];
  for (const k of SETTING_KEYS) {
    const v = body[k];
    if (typeof v === "string" && v.trim() && !v.startsWith("••••")) {
      await setSetting(k, v.trim());
      saved.push(k);
    }
  }
  res.json(ok({ saved }));
});

router.get("/alerts", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, token_id AS "tokenId", kind, title, body, at,
              COALESCE(lane, payload->>'lane', 'early') AS lane,
              score
       FROM ward_alerts
       WHERE kind IN ('admit', 'confirm', 'rung')
         AND COALESCE(lane, payload->>'lane', 'early') = 'early'
       ORDER BY id DESC
       LIMIT 12`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(ok(r.rows));
  } catch (err) {
    res.status(500).json(fail("alerts failed"));
  }
});

router.get("/notices", async (_req, res) => {
  try {
    const payload = await cached("notices:high", 2_000, () => listNotices());
    res.setHeader("Cache-Control", "no-store");
    res.json(ok(payload));
  } catch (err) {
    console.error("notices failed", err);
    res.status(500).json(fail("notices failed"));
  }
});

router.get("/events", sseHandler);

export default router;
