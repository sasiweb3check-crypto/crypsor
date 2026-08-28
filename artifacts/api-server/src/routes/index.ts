/**
 * Ward API — hospital board, patient chart, alerts, agents, wallets, settings.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "../core/db";
import { sseHandler } from "../core/bus";
import { agentStatus, ensureRuntime, runFullTick } from "../funnel/runtime";
import { heliusKey, setSetting, getSetting } from "../core/settings";
import { getWeights, prognosis, failsOf, type Phase } from "../scoring/ward";

const router: IRouter = Router();

const ok = (data: unknown) => ({ ok: true, data });
const fail = (error: string) => ({ ok: false, error });

const PHASES = ["intake", "icu", "ward", "recovery", "revived", "deceased"] as const;

router.use((_req, _res, next) => {
  void ensureRuntime().finally(() => next());
});

// ── health ──────────────────────────────────────────────────────────────────

router.get("/healthz", async (_req, res) => {
  try {
    const t0 = Date.now();
    await pool.query("SELECT 1");
    const dbMs = Date.now() - t0;
    let census: Record<string, number> = {};
    let lastScanAt: unknown = null;
    try {
      const counts = await pool.query(
        `SELECT COALESCE(phase, 'intake') AS phase, COUNT(*)::int AS n
         FROM f2_tokens
         WHERE source = 'wallet_buy' OR wallet_buys > 0
         GROUP BY 1`,
      );
      const lastScan = await pool.query("SELECT MAX(at) AS at FROM f2_scans");
      census = Object.fromEntries(
        counts.rows.map((r: { phase: string; n: number }) => [r.phase, r.n]),
      );
      lastScanAt = lastScan.rows[0]?.at ?? null;
    } catch {
      // Schema may still be creating on a fresh boot — DB ping is enough for Render.
    }
    res.json(ok({
      db: `${dbMs}ms`,
      helius: Boolean(await heliusKey()),
      census,
      lastScanAt,
      agents: agentStatus(),
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

// ── ward board ───────────────────────────────────────────────────────────────

router.get("/ward", async (req, res) => {
  try {
    const phase = String(req.query.phase ?? "live").toLowerCase();
    const q = String(req.query.q ?? "").trim();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "80"), 10) || 80, 1), 200);

    const census = await pool.query(
      `SELECT COALESCE(phase,'intake') AS phase, COUNT(*)::int AS n
       FROM f2_tokens
       WHERE source = 'wallet_buy' OR wallet_buys > 0
       GROUP BY 1`,
    );
    const counts: Record<string, number> = {};
    for (const r of census.rows as Array<{ phase: string; n: number }>) counts[r.phase] = r.n;

    const live = (counts.intake ?? 0) + (counts.ward ?? 0) + (counts.icu ?? 0)
      + (counts.recovery ?? 0) + (counts.revived ?? 0);
    const dead = counts.deceased ?? 0;
    const survival = live + dead > 0 ? live / (live + dead) : null;

    const trades24 = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ward_alerts
       WHERE kind = 'trade' AND at > NOW() - INTERVAL '24 hours'`,
    );
    const avgScore = await pool.query(
      `SELECT AVG(survival_score) AS avg
       FROM f2_tokens
       WHERE (source = 'wallet_buy' OR wallet_buys > 0)
         AND COALESCE(phase,'intake') NOT IN ('deceased') AND survival_score IS NOT NULL`,
    );

    const where: string[] = ["(t.source = 'wallet_buy' OR t.wallet_buys > 0)"];
    const params: unknown[] = [];
    if (phase === "live") {
      where.push(`COALESCE(t.phase,'intake') <> 'deceased'`);
    } else if ((PHASES as readonly string[]).includes(phase)) {
      params.push(phase);
      where.push(`COALESCE(t.phase,'intake') = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(t.symbol ILIKE $${params.length} OR t.name ILIKE $${params.length} OR t.mint ILIKE $${params.length})`);
    }
    params.push(limit);
    const patients = await pool.query(
      `SELECT t.id, t.mint, t.symbol, t.name, t.image,
              COALESCE(t.phase,'intake') AS phase,
              t.survival_score, t.wallet_buys, t.last_mc, t.peak_mc, t.admission_mc,
              t.last_liq, t.last_holders, t.tape_lead, t.last_verdict, t.last_reasons,
              t.discovered_at, t.last_scan_at, t.deceased_at, t.revived_at, t.graduated
       FROM f2_tokens t
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY CASE COALESCE(t.phase,'intake')
                  WHEN 'icu' THEN 0 WHEN 'intake' THEN 1 WHEN 'recovery' THEN 2
                  WHEN 'revived' THEN 3 WHEN 'ward' THEN 4 ELSE 5 END,
                t.survival_score DESC NULLS LAST,
                t.discovered_at DESC
       LIMIT $${params.length}`,
      params,
    );

    res.json(ok({
      census: counts,
      stats: {
        live,
        deceased: dead,
        survival,
        avgScore: avgScore.rows[0]?.avg != null ? Number(avgScore.rows[0].avg) : null,
        trades24h: Number(trades24.rows[0]?.n ?? 0),
      },
      patients: patients.rows.map((row) => {
        const phase = (row.phase ?? "intake") as Phase;
        return {
          ...row,
          prognosis: prognosis(phase, row.survival_score, failsOf(row.last_reasons)),
        };
      }),
      weights: getWeights(),
    }));
  } catch (err) {
    console.error("ward failed", err);
    res.status(500).json(fail("ward failed"));
  }
});

// ── patient chart ────────────────────────────────────────────────────────────

router.get("/patient/:id", async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) { res.status(400).json(fail("bad id")); return; }

    const tr = await pool.query(
      `SELECT t.*, c.id AS call_id, c.called_at, c.alert_mc, c.peak_mc AS call_peak_mc,
              c.last_mc AS call_last_mc, c.safe, c.telegram_sent
       FROM f2_tokens t
       LEFT JOIN f2_calls c ON c.token_id = t.id
       WHERE t.id = $1`,
      [id],
    );
    if (!tr.rows.length) { res.status(404).json(fail("not found")); return; }
    const token = tr.rows[0] as Record<string, unknown>;

    const scans = await pool.query(
      `SELECT at, mc_usd, liq_usd, price_usd, holders, top10_pct,
              buys_5m, sells_5m, vol_5m, bundler_pct, sniper_pct, bot_pct,
              whale_pct, smart_count, kol_count, pass, fail_reasons, tape, score, phase
       FROM f2_scans WHERE token_id = $1 ORDER BY at ASC LIMIT 80`,
      [id],
    );
    const admissions = await pool.query(
      `SELECT a.wallet, a.sig, a.at, w.label
       FROM ward_admissions a
       LEFT JOIN walletdatasource w ON w.address = a.wallet
       WHERE a.token_id = $1
       ORDER BY a.at ASC`,
      [id],
    );
    const alerts = await pool.query(
      `SELECT id, kind, title, body, payload, telegram_sent, at
       FROM ward_alerts WHERE token_id = $1 ORDER BY at DESC LIMIT 40`,
      [id],
    );
    const notes = await pool.query(
      `SELECT agent, action, detail, at
       FROM ward_agent_log WHERE token_id = $1 ORDER BY at DESC LIMIT 40`,
      [id],
    );

    const lastScan = scans.rows[scans.rows.length - 1] ?? null;
    const admitMc = Number(token.admission_mc ?? token.mc_at_discovery ?? 0) || null;
    const lastMc = Number(token.last_mc ?? 0) || null;
    const peakMc = Number(token.peak_mc ?? 0) || null;
    const phase = ((token.phase as string) || "intake") as Phase;
    const course: Array<{ phase: string; at: string; score: number | null }> = [];
    for (const s of scans.rows as Array<{ phase: string | null; at: string; score: number | null }>) {
      if (!s.phase) continue;
      const prev = course[course.length - 1];
      if (!prev || prev.phase !== s.phase) course.push({ phase: s.phase, at: s.at, score: s.score });
      else prev.score = s.score;
    }

    res.json(ok({
      token: {
        ...token,
        phase,
        xFromAdmit: admitMc && lastMc ? lastMc / admitMc : null,
        peakX: admitMc && peakMc ? peakMc / admitMc : null,
        prognosis: prognosis(phase, Number(token.survival_score ?? NaN) || null, failsOf(token.last_reasons)),
      },
      lastScan,
      scans: scans.rows,
      course,
      admissions: admissions.rows,
      alerts: alerts.rows,
      notes: notes.rows,
      weights: getWeights(),
    }));
  } catch (err) {
    console.error("patient failed", err);
    res.status(500).json(fail("patient failed"));
  }
});

// ── alerts ───────────────────────────────────────────────────────────────────

router.get("/alerts", async (req, res) => {
  try {
    const kind = String(req.query.kind ?? "").trim();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "80"), 10) || 80, 1), 200);
    const params: unknown[] = [];
    let where = "WHERE (t.source = 'wallet_buy' OR t.wallet_buys > 0)";
    if (kind) {
      params.push(kind);
      where += ` AND a.kind = $${params.length}`;
    }
    params.push(limit);
    const r = await pool.query(
      `SELECT a.id, a.token_id, a.kind, a.title, a.body, a.payload, a.telegram_sent, a.at,
              t.mint, t.symbol, t.name, t.image, t.phase, t.survival_score
       FROM ward_alerts a
       JOIN f2_tokens t ON t.id = a.token_id
       ${where}
       ORDER BY a.at DESC
       LIMIT $${params.length}`,
      params,
    );
    res.json(ok(r.rows));
  } catch (err) {
    console.error("alerts failed", err);
    res.status(500).json(fail("alerts failed"));
  }
});

// ── agents ───────────────────────────────────────────────────────────────────

router.get("/agents", async (_req, res) => {
  try {
    const notes = await pool.query(
      `SELECT id, agent, action, token_id, mint, detail, at
       FROM ward_agent_log ORDER BY at DESC LIMIT 80`,
    );
    const byAgent = await pool.query(
      `SELECT agent, MAX(at) AS last_at, COUNT(*)::int AS n
       FROM ward_agent_log
       WHERE at > NOW() - INTERVAL '24 hours'
       GROUP BY agent`,
    );
    const paper = await pool.query(
      `SELECT
         COUNT(*)::int AS judged,
         COUNT(*) FILTER (
           WHERE t.peak_mc >= NULLIF((a.payload->>'mc')::real, 0) * 2
         )::int AS wins
       FROM ward_alerts a
       JOIN f2_tokens t ON t.id = a.token_id
       WHERE a.kind = 'trade'
         AND a.at < NOW() - INTERVAL '2 hours'
         AND a.at > NOW() - INTERVAL '7 days'`,
    );
    const report = await pool.query(
      `SELECT census, survival, trades_24h, paper, detail, at
       FROM ward_reports ORDER BY id DESC LIMIT 1`,
    );
    res.json(ok({
      status: agentStatus(),
      weights: getWeights(),
      last24h: byAgent.rows,
      paper: paper.rows[0] ?? { judged: 0, wins: 0 },
      report: report.rows[0] ?? null,
      notes: notes.rows,
    }));
  } catch (err) {
    console.error("agents failed", err);
    res.status(500).json(fail("agents failed"));
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
