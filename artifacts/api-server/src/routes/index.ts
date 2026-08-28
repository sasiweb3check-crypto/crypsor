/**
 * v2 API — vault dashboard, funnel state, token journal, wallets, settings.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "../core/db";
import { sseHandler } from "../core/bus";
import { ensureRuntime, runFullTick } from "../funnel/runtime";
import { T } from "../funnel/filters";
import { heliusKey } from "../core/settings";
import { setSetting, getSetting } from "../core/settings";

const router: IRouter = Router();

const ok = (data: unknown) => ({ ok: true, data });
const fail = (error: string) => ({ ok: false, error });

// Warm-instance boot on every request (Vercel Fluid)
router.use((_req, _res, next) => {
  void ensureRuntime().finally(() => next());
});

// ── health ──────────────────────────────────────────────────────────────────

router.get("/healthz", async (_req, res) => {
  try {
    const t0 = Date.now();
    await pool.query("SELECT 1");
    const dbMs = Date.now() - t0;
    let funnel24h: Record<string, number> = {};
    let lastScanAt: unknown = null;
    try {
      const counts = await pool.query(
        `SELECT stage, COUNT(*)::int AS n FROM f2_tokens
         WHERE discovered_at > NOW() - INTERVAL '24 hours' GROUP BY stage`,
      );
      const lastScan = await pool.query("SELECT MAX(at) AS at FROM f2_scans");
      funnel24h = Object.fromEntries(
        counts.rows.map((r: { stage: string; n: number }) => [r.stage, r.n]),
      );
      lastScanAt = lastScan.rows[0]?.at ?? null;
    } catch {
      // Schema may still be creating on a fresh boot — DB ping is enough for Render.
    }
    res.json(ok({
      db: `${dbMs}ms`,
      helius: Boolean(await heliusKey()),
      funnel24h,
      lastScanAt,
    }));
  } catch (err) {
    res.status(500).json(fail(err instanceof Error ? err.message : "health failed"));
  }
});

// ── keepalive / cron ─────────────────────────────────────────────────────────

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
  return true; // no secret configured — endpoint stays open but rate-limited
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

// ── vault (the dashboard) ───────────────────────────────────────────────────

const PERIODS: Record<string, string> = {
  "24h": "24 hours", "7d": "7 days", "30d": "30 days", all: "100 years",
};

router.get("/vault", async (req, res) => {
  try {
    const period = PERIODS[String(req.query.period ?? "24h").toLowerCase()] ?? PERIODS["24h"];
    const safeOnly = String(req.query.safe ?? "0") === "1";
    const sort = String(req.query.sort ?? "time");
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);

    const calls = await pool.query(
      `SELECT c.id, c.token_id, t.mint, t.symbol, t.name, t.image, t.source,
              t.wallet_buys, c.called_at, c.alert_mc, c.peak_mc, c.peak_at,
              c.last_mc, c.safe, c.deep,
              (c.peak_mc / NULLIF(c.alert_mc, 0)) AS peak_x
       FROM f2_calls c JOIN f2_tokens t ON t.id = c.token_id
       WHERE c.called_at > NOW() - INTERVAL '${period}'
         ${safeOnly ? "AND c.safe = true" : ""}
       ORDER BY ${sort === "performance" ? "peak_x DESC NULLS LAST" : "c.called_at DESC"}
       LIMIT ${limit}`,
    );

    const stats = await pool.query(
      `SELECT COUNT(*)::int AS signals,
              COUNT(*) FILTER (WHERE peak_mc >= alert_mc * 2)::int AS w2,
              COUNT(*) FILTER (WHERE peak_mc >= alert_mc * 5)::int AS w5,
              COUNT(*) FILTER (WHERE peak_mc >= alert_mc * 10)::int AS w10,
              AVG(peak_mc / NULLIF(alert_mc, 0)) AS avg_x,
              MAX(peak_mc / NULLIF(alert_mc, 0)) AS best_x
       FROM f2_calls
       WHERE called_at > NOW() - INTERVAL '${period}'
         ${safeOnly ? "AND safe = true" : ""}`,
    );
    const s = stats.rows[0] ?? {};
    const signals = Number(s.signals ?? 0);
    // Win rate counts only calls old enough to have had a chance (>=30 min)
    const matured = await pool.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE peak_mc >= alert_mc * ${T.WIN_MULTIPLE})::int AS wins
       FROM f2_calls
       WHERE called_at > NOW() - INTERVAL '${period}'
         AND called_at < NOW() - INTERVAL '30 minutes'
         ${safeOnly ? "AND safe = true" : ""}`,
    );
    const m = matured.rows[0] ?? {};

    // Best symbol
    const best = await pool.query(
      `SELECT t.symbol, (c.peak_mc / NULLIF(c.alert_mc,0)) AS x
       FROM f2_calls c JOIN f2_tokens t ON t.id = c.token_id
       WHERE c.called_at > NOW() - INTERVAL '${period}'
         ${safeOnly ? "AND c.safe = true" : ""}
       ORDER BY x DESC NULLS LAST LIMIT 1`,
    );

    res.json(ok({
      calls: calls.rows,
      stats: {
        signals,
        winners2x: Number(s.w2 ?? 0),
        winners5x: Number(s.w5 ?? 0),
        winners10x: Number(s.w10 ?? 0),
        avgReturn: s.avg_x != null ? Number(s.avg_x) : null,
        bestX: s.best_x != null ? Number(s.best_x) : null,
        bestSymbol: best.rows[0]?.symbol ?? null,
        winRate: Number(m.n ?? 0) > 0 ? Number(m.wins) / Number(m.n) : null,
        matured: Number(m.n ?? 0),
      },
    }));
  } catch (err) {
    console.error("vault failed", err);
    res.status(500).json(fail("vault failed"));
  }
});

// ── funnel state (pipeline page) ────────────────────────────────────────────

router.get("/funnel", async (_req, res) => {
  try {
    const counts = await pool.query(
      `SELECT stage, COUNT(*)::int AS n FROM f2_tokens
       WHERE discovered_at > NOW() - INTERVAL '24 hours' GROUP BY stage`,
    );
    const tracking = await pool.query(
      `SELECT t.id, t.mint, t.symbol, t.source, t.wallet_buys, t.pass_streak,
              t.scans_total, t.discovered_at,
              s.mc_usd, s.holders, s.top10_pct, s.pass, s.fail_reasons
       FROM f2_tokens t
       LEFT JOIN LATERAL (
         SELECT mc_usd, holders, top10_pct, pass, fail_reasons
         FROM f2_scans WHERE token_id = t.id ORDER BY at DESC LIMIT 1
       ) s ON TRUE
       WHERE t.stage IN ('tracking', 'deepdive')
       ORDER BY t.wallet_buys DESC, t.discovered_at DESC
       LIMIT 40`,
    );
    const recentKills = await pool.query(
      `SELECT mint, symbol, kill_reason, discovered_at FROM f2_tokens
       WHERE stage = 'killed' ORDER BY id DESC LIMIT 25`,
    );
    const killReasons = await pool.query(
      `SELECT split_part(kill_reason, ':', 1) AS reason, COUNT(*)::int AS n
       FROM f2_tokens WHERE stage = 'killed'
         AND discovered_at > NOW() - INTERVAL '24 hours'
       GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    );
    res.json(ok({
      counts: Object.fromEntries(counts.rows.map((r) => [r.stage, r.n])),
      tracking: tracking.rows,
      recentKills: recentKills.rows,
      killReasons: killReasons.rows,
      thresholds: T,
    }));
  } catch (err) {
    console.error("funnel failed", err);
    res.status(500).json(fail("funnel failed"));
  }
});

// ── token detail (journal) ──────────────────────────────────────────────────

router.get("/token/:id", async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const tr = await pool.query(
      `SELECT t.*, c.id AS call_id, c.called_at, c.alert_mc, c.peak_mc, c.peak_at,
              c.last_mc, c.safe, c.deep, c.telegram_sent
       FROM f2_tokens t LEFT JOIN f2_calls c ON c.token_id = t.id
       WHERE t.id = $1`,
      [id],
    );
    if (!tr.rows.length) { res.status(404).json(fail("not found")); return; }
    const token = tr.rows[0];

    const scans = await pool.query(
      `SELECT at, mc_usd, liq_usd, holders, top10_pct, buys_5m, sells_5m,
              bundler_pct, smart_count, kol_count, pass, fail_reasons
       FROM f2_scans WHERE token_id = $1 ORDER BY at DESC LIMIT 40`,
      [id],
    );
    const journal = token.call_id
      ? await pool.query(
        `SELECT at, price_usd, mc_usd, liq_usd, holders, bot_pct, smart_count,
                whale_pct, buys_5m, sells_5m
         FROM f2_journal WHERE call_id = $1 ORDER BY at ASC LIMIT 2000`,
        [token.call_id],
      )
      : { rows: [] };

    res.json(ok({ token, scans: scans.rows.reverse(), journal: journal.rows }));
  } catch (err) {
    console.error("token detail failed", err);
    res.status(500).json(fail("token detail failed"));
  }
});

// ── wallets (tracked buy sources) ───────────────────────────────────────────

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

// ── settings ────────────────────────────────────────────────────────────────

const SETTING_KEYS = ["helius_api_key", "telegram_bot_token", "telegram_chat_id"];

router.get("/settings", async (_req, res) => {
  const out: Record<string, string | null> = {};
  for (const k of SETTING_KEYS) {
    const v = await getSetting(k);
    // mask secrets — only reveal tail
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

// ── SSE ─────────────────────────────────────────────────────────────────────

router.get("/events", sseHandler);

export default router;
