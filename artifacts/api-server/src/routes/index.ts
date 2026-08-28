/**
 * Ward API — hospital board, patient chart, alerts, agents, wallets, settings.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "../core/db";
import { sseHandler } from "../core/bus";
import { cached, cacheBackend, cacheGet, cacheSet } from "../core/cache";
import { agentStatus, ensureRuntime, runFullTick } from "../funnel/runtime";
import { heliusKey, setSetting, getSetting } from "../core/settings";
import { getWeights, prognosis, failsOf, callOf, type Phase } from "../scoring/ward";
import { seedTradesFromAlerts } from "../agents/book";
import { buildLiveBoard, passesOnDay } from "../agents/stats";
import { imageProxy } from "./img";

const router: IRouter = Router();

const ok = (data: unknown) => ({ ok: true, data });
const fail = (error: string) => ({ ok: false, error });

const PHASES = ["intake", "icu", "ward", "recovery", "revived", "deceased"] as const;

function pageParams(req: Request, fallback = 8, max = 40): { page: number; limit: number; offset: number } {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? String(fallback)), 10) || fallback, 1), max);
  return { page, limit, offset: (page - 1) * limit };
}

router.use((req, _res, next) => {
  if (req.path === "/img") {
    next();
    return;
  }
  void ensureRuntime().finally(() => next());
});

// ── health ──────────────────────────────────────────────────────────────────

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
      cache: cacheBackend(),
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
              t.discovered_at, t.last_scan_at, t.deceased_at, t.revived_at, t.graduated,
              t.last_quality, t.cap_band, t.last_suggestion
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

    let suggestions: unknown[] = [];
    try {
      const sug = await pool.query(
        `SELECT suggestions FROM ward_reports WHERE suggestions IS NOT NULL ORDER BY id DESC LIMIT 1`,
      );
      const raw = sug.rows[0]?.suggestions;
      suggestions = Array.isArray(raw) ? raw : [];
      if (!suggestions.length) {
        const recent = await pool.query(
          `SELECT suggestions FROM ward_snapshots
           WHERE at > NOW() - INTERVAL '3 hours' AND suggestions IS NOT NULL
           ORDER BY at DESC LIMIT 80`,
        );
        const tally = new Map<string, { s: Record<string, unknown>; n: number }>();
        for (const row of recent.rows as Array<{ suggestions: unknown }>) {
          const list = Array.isArray(row.suggestions) ? row.suggestions as Array<Record<string, unknown>> : [];
          for (const s of list) {
            const id = String(s?.id ?? "");
            if (!id) continue;
            const prev = tally.get(id);
            if (prev) prev.n += 1;
            else tally.set(id, { s, n: 1 });
          }
        }
        suggestions = [...tally.values()]
          .sort((a, b) => b.n - a.n)
          .slice(0, 4)
          .map(({ s, n }) => ({
            ...s,
            body: `${String(s.body ?? "")} (${n} patient${n === 1 ? "" : "s"} in 3h)`,
          }));
      }
    } catch {
      suggestions = [];
    }

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
          prognosis: prognosis(phase, callOf(row.last_reasons) ?? row.survival_score, failsOf(row.last_reasons)),
        };
      }),
      suggestions,
      weights: getWeights(),
    }));
  } catch (err) {
    console.error("ward failed", err);
    res.status(500).json(fail("ward failed"));
  }
});

const TRADE_SELECT = `SELECT tr.id, tr.token_id, tr.entry_mc, tr.entry_liq, tr.entry_holders, tr.entry_score,
            tr.called_at, tr.peak_mc, tr.peak_at, tr.last_mc, tr.last_liq, tr.last_holders,
            tr.status, tr.exit_action, tr.exit_take_pct, tr.exit_title, tr.exit_body,
            tr.gain_x, tr.ath_x, tr.gain_pct, tr.ath_pct, tr.closed_at, tr.close_mc,
            t.mint, t.symbol, t.name, t.image, t.wallet_buys, t.phase
     FROM ward_trades tr
     JOIN f2_tokens t ON t.id = tr.token_id`;

// ── desk (locked trades + performers) ────────────────────────────────────────

router.get("/stats", async (req, res) => {
  try {
    const day = String(req.query.day ?? "").slice(0, 10);
    res.setHeader("Cache-Control", "no-store");
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const passes = await cached(`stats:day:${day}`, 1_500, () => passesOnDay(day));
      res.json(ok({ day, passes, at: new Date().toISOString() }));
      return;
    }
    const payload = await cached("stats:live", 2_000, async () => {
      await seedTradesFromAlerts();
      return buildLiveBoard();
    });
    res.json(ok(payload));
  } catch (err) {
    console.error("stats failed", err);
    res.status(500).json(fail("stats failed"));
  }
});

router.get("/desk", async (req, res) => {
  try {
    const { page, limit, offset } = pageParams(req, 8, 40);
      const payload = await cached(`desk:${page}:${limit}`, 2_000, async () => {
      await seedTradesFromAlerts();
      const board = await buildLiveBoard();
      const open = await pool.query(
        `${TRADE_SELECT} WHERE tr.status IN ('open','trim') ORDER BY tr.called_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      const n = board.totals.live;
      return {
        ...board,
        open: open.rows,
        watch: [],
        verdicts: [],
        stream: [],
        performers: board.performers,
        paper: {
          n: board.totals.passed,
          wins: board.totals.hit2x,
          open: board.totals.live,
          avgAth: board.totals.avgAthPct != null ? 1 + board.totals.avgAthPct / 100 : null,
          avgGain: board.totals.avgGainPct != null ? 1 + board.totals.avgGainPct / 100 : null,
        },
        page,
        limit,
        total: n,
        pages: Math.max(1, Math.ceil(n / limit)),
        cache: cacheBackend(),
      };
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(ok(payload));
  } catch (err) {
    console.error("desk failed", err);
    res.status(500).json(fail("desk failed"));
  }
});

// ── patient chart ────────────────────────────────────────────────────────────

router.get("/patient/:id", async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) { res.status(400).json(fail("bad id")); return; }
    const hit = await cacheGet(`patient:${id}`);
    if (hit) {
      res.setHeader("Cache-Control", "private, max-age=3");
      res.json(ok(hit));
      return;
    }

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
    let snapshots: unknown[] = [];
    let sources: unknown[] = [];
    try {
      const snap = await pool.query(
        `SELECT at, band, kind, mc_usd, liq_usd, holders, top10_pct, score, phase, quality,
                tape_lead, mc_slope, liq_slope, holder_slope, flags, suggestions,
                narrative, incomplete, filled
         FROM ward_snapshots WHERE token_id = $1 ORDER BY at ASC LIMIT 64`,
        [id],
      );
      snapshots = snap.rows;
      const reads = await pool.query(
        `SELECT source, ok, mc_usd, liq_usd, holders, top10_pct, latency_ms, extra, at
         FROM ward_source_reads WHERE token_id = $1 ORDER BY at DESC LIMIT 18`,
        [id],
      );
      sources = reads.rows;
    } catch {
      snapshots = [];
      sources = [];
    }

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

    let trade: unknown = null;
    let watch: unknown = null;
    try {
      trade = (await pool.query(`${TRADE_SELECT} WHERE tr.token_id = $1`, [id])).rows[0] ?? null;
    } catch {
      trade = null;
    }
    try {
      watch = (await pool.query(
        `SELECT status, yes_votes, no_votes, hold_votes, agreed, entry_ok, headline, votes,
                last_mc, last_liq, last_score, seen_at, updated_at, locked_at
         FROM ward_watch WHERE token_id = $1`,
        [id],
      )).rows[0] ?? null;
    } catch {
      watch = null;
    }

    let memory: Record<string, unknown> | null = null;
    try {
      memory = (await pool.query(
        `SELECT caution, pulse, confirm, narrative, updated_at FROM ward_memory WHERE token_id = $1`,
        [id],
      )).rows[0] ?? null;
    } catch {
      memory = null;
    }

    const snapRows = snapshots as Array<{ kind?: string; at?: string; narrative?: string; suggestions?: unknown }>;
    const latestOf = (kind: string) => {
      for (let i = snapRows.length - 1; i >= 0; i--) {
        if (snapRows[i]?.kind === kind) return snapRows[i];
      }
      return null;
    };
    const pulse = latestOf("pulse");
    const confirm = latestOf("confirm");
    const narrative = String(
      memory?.narrative
        ?? pulse?.narrative
        ?? confirm?.narrative
        ?? token.last_narrative
        ?? "",
    ) || null;

    const body = {
      token: {
        ...token,
        phase,
        xFromAdmit: admitMc && lastMc ? lastMc / admitMc : null,
        peakX: admitMc && peakMc ? peakMc / admitMc : null,
        prognosis: prognosis(phase, callOf(token.last_reasons) ?? (Number(token.survival_score ?? NaN) || null), failsOf(token.last_reasons)),
      },
      lastScan,
      scans: scans.rows,
      course,
      admissions: admissions.rows,
      alerts: alerts.rows,
      notes: notes.rows,
      snapshots,
      pulse,
      confirm,
      sources,
      suggestions: snapRows.length
        ? snapRows[snapshots.length - 1]?.suggestions ?? []
        : [],
      narrative,
      memory,
      trade,
      watch,
      weights: getWeights(),
    };
    await cacheSet(`patient:${id}`, body, 3_000);
    res.setHeader("Cache-Control", "private, max-age=3");
    res.json(ok(body));
  } catch (err) {
    console.error("patient failed", err);
    res.status(500).json(fail("patient failed"));
  }
});

// ── alerts ───────────────────────────────────────────────────────────────────

router.get("/alerts", async (req, res) => {
  try {
    const kind = String(req.query.kind ?? "book").trim();
    const { page, limit, offset } = pageParams(req, 12, 80);
    const payload = await cached(`alerts:${kind}:${page}:${limit}`, 4_000, async () => {
      const params: unknown[] = [];
      let where = "WHERE (t.source = 'wallet_buy' OR t.wallet_buys > 0)";
      if (kind === "book") {
        where += ` AND a.kind IN ('trade','exit','trim','watch')`;
      } else if (kind && kind !== "all") {
        params.push(kind);
        where += ` AND a.kind = $${params.length}`;
      }
      const countParams = [...params];
      const total = await pool.query(
        `SELECT COUNT(*)::int AS n
         FROM ward_alerts a
         JOIN f2_tokens t ON t.id = a.token_id
         ${where}`,
        countParams,
      );
      params.push(limit, offset);
      const r = await pool.query(
        `SELECT a.id, a.token_id, a.kind, a.title, a.body, a.payload, a.telegram_sent, a.at,
                t.mint, t.symbol, t.name, t.image, t.phase, t.survival_score
         FROM ward_alerts a
         JOIN f2_tokens t ON t.id = a.token_id
         ${where}
         ORDER BY a.at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const n = Number(total.rows[0]?.n ?? 0);
      return {
        items: r.rows,
        page,
        limit,
        total: n,
        pages: Math.max(1, Math.ceil(n / limit)),
      };
    });
    res.setHeader("Cache-Control", "private, max-age=3");
    res.json(ok(payload));
  } catch (err) {
    console.error("alerts failed", err);
    res.status(500).json(fail("alerts failed"));
  }
});

// ── agents ───────────────────────────────────────────────────────────────────

router.get("/agents", async (req, res) => {
  try {
    const lane = String(req.query.lane ?? "all").toLowerCase();
    const noteWhere = lane === "pass"
      ? `WHERE action IN ('DID','PASS','LOCK')`
      : lane === "book"
        ? `WHERE action IN ('EXIT','TRIM','HOLD')`
        : "";
    const notes = await pool.query(
      `SELECT id, agent, action, token_id, mint, detail, at
       FROM ward_agent_log ${noteWhere} ORDER BY at DESC LIMIT 120`,
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
      `SELECT census, survival, trades_24h, paper, detail, suggestions, quality, at
       FROM ward_reports ORDER BY id DESC LIMIT 1`,
    );
    let quality: unknown = report.rows[0]?.quality ?? null;
    try {
      const src = await pool.query(
        `SELECT source,
                COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE ok)::int AS ok,
                AVG(latency_ms) FILTER (WHERE ok) AS avg_ms
         FROM ward_source_reads
         WHERE at > NOW() - INTERVAL '6 hours'
         GROUP BY source`,
      );
      const snaps = await pool.query(
        `SELECT COALESCE(band,'unknown') AS band, COUNT(*)::int AS n
         FROM ward_snapshots WHERE at > NOW() - INTERVAL '6 hours'
         GROUP BY 1`,
      );
      quality = {
        ...(typeof quality === "object" && quality ? quality as Record<string, unknown> : {}),
        sources: src.rows,
        snapshots: snaps.rows,
      };
    } catch {
      // quality tables may be empty on first boot
    }
    res.json(ok({
      status: agentStatus(),
      weights: getWeights(),
      last24h: byAgent.rows,
      paper: paper.rows[0] ?? { judged: 0, wins: 0 },
      report: report.rows[0] ?? null,
      quality,
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
