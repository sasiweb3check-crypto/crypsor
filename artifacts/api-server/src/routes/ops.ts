/**
 * Ops visibility — lightweight status + ring-buffer logs.
 * GET /api/ops/summary  — health snapshot (Helius, scan delay, Telegram, Pro blockers)
 * GET /api/ops/log      — recent events (?kind=&level=&limit=)
 * GET /api/ops/ping     — connectivity check for the frontend
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { settings } from "@workspace/db";
import { sql } from "drizzle-orm";
import { monitorStatus } from "../lib/monitor";
import { healthMonitor } from "../pipeline/health-monitor";
import {
  getOpsCounters,
  getOpsLogMerged,
  opsLog,
  type OpsKind,
  type OpsLevel,
} from "../lib/ops-log";

const router = Router();

router.get("/ops/ping", (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    api: "crypsor",
  });
});

router.get("/ops/log", async (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit ?? "80"), 10) || 80;
    const kind = (req.query.kind as OpsKind | "all" | undefined) ?? "all";
    const level = (req.query.level as OpsLevel | "all" | undefined) ?? "all";
    const events = await getOpsLogMerged({ limit, kind, level });
    res.setHeader("Cache-Control", "private, max-age=3");
    res.json({ events, total: events.length });
  } catch (err) {
    console.error("ops log error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/ops/summary", async (_req, res) => {
  try {
    const counters = getOpsCounters();
    const now = Date.now();

    // Telegram configured?
    const tgRows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(sql`key IN ('telegram_bot_token', 'telegram_chat_id', 'helius_api_key')`);
    const bot = (tgRows.find(r => r.key === "telegram_bot_token")?.value ?? "").trim();
    const chat = (tgRows.find(r => r.key === "telegram_chat_id")?.value ?? "").trim();
    const heliusDb = (tgRows.find(r => r.key === "helius_api_key")?.value ?? "").trim();
    const telegramConfigured = Boolean(bot && chat);
    const heliusConfigured =
      monitorStatus.heliusConfigured ||
      Boolean(heliusDb || process.env.HELIUS_API_KEY?.trim());

    // Pending first-call alerts (quality good/very_good, never sent)
    let pendingFirstCalls = 0;
    let pendingMilestones = 0;
    let qualityBelowBlocked = 0;
    try {
      const pending = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (
            WHERE quality_label IN ('very_good','good') AND call_alert_sent_at IS NULL
          )::int AS pending_first,
          COUNT(*) FILTER (
            WHERE quality_label IN ('very_good','good')
              AND call_alert_sent_at IS NOT NULL
              AND COALESCE(ath_multiple, 1) >= 2
              AND (
                milestone_alerts_sent IS NULL
                OR milestone_alerts_sent = ''
                OR (
                  ath_multiple >= 2 AND position('2' in coalesce(milestone_alerts_sent,'')) = 0
                )
              )
          )::int AS pending_ms,
          COUNT(*) FILTER (
            WHERE quality_label = 'below' AND called_at >= NOW() - INTERVAL '7 days'
          )::int AS below_7d
        FROM pro_calls
      `);
      const row = pending.rows[0] as Record<string, unknown> | undefined;
      pendingFirstCalls = Number(row?.pending_first ?? 0);
      pendingMilestones = Number(row?.pending_ms ?? 0);
      qualityBelowBlocked = Number(row?.below_7d ?? 0);
    } catch {
      /* schema may lag */
    }

    const lastScanMs = monitorStatus.lastScanAt
      ? new Date(monitorStatus.lastScanAt).getTime()
      : null;
    const scanAgeSec = lastScanMs != null ? Math.round((now - lastScanMs) / 1000) : null;
    // Cycle is ~2 min; warn if > 5 min since last scan while "running"
    const scanDelayed = Boolean(
      monitorStatus.running && scanAgeSec != null && scanAgeSec > 300,
    );
    const scanStopped = !monitorStatus.running;

    const blockers: Array<{ code: string; level: OpsLevel; msg: string }> = [];
    if (!heliusConfigured) {
      blockers.push({
        code: "helius_no_key",
        level: "error",
        msg: "Helius API key missing — Solana wallet buys will not scan",
      });
    }
    if (monitorStatus.heliusLastError) {
      blockers.push({
        code: "helius_error",
        level: "error",
        msg: `Helius last error: ${monitorStatus.heliusLastError}`,
      });
    }
    if (scanStopped) {
      blockers.push({
        code: "scan_stopped",
        level: "error",
        msg: "Wallet scan loop is not running",
      });
    } else if (scanDelayed) {
      blockers.push({
        code: "scan_delayed",
        level: "warn",
        msg: `Last wallet scan ${scanAgeSec}s ago (expected ~120s) — may be stuck or cold-starting`,
      });
    }
    if (!telegramConfigured) {
      blockers.push({
        code: "telegram_unconfigured",
        level: "warn",
        msg: "Telegram bot token / chat id not saved — Pro alerts will not send",
      });
    }
    if (telegramConfigured && counters.lastTelegramError) {
      blockers.push({
        code: "telegram_send_fail",
        level: "error",
        msg: `Telegram send failing: ${counters.lastTelegramError}`,
      });
    }
    if (telegramConfigured && pendingFirstCalls > 0) {
      blockers.push({
        code: "pending_first_calls",
        level: "warn",
        msg: `${pendingFirstCalls} Pro call(s) waiting for first Telegram alert`,
      });
    }
    if (qualityBelowBlocked > 0 && pendingFirstCalls === 0) {
      blockers.push({
        code: "quality_below",
        level: "info",
        msg: `${qualityBelowBlocked} recent pro_calls scored below (no alert until good/very_good)`,
      });
    }
    if (monitorStatus.walletsTracked === 0) {
      blockers.push({
        code: "no_wallets",
        level: "warn",
        msg: "No wallets tracked — add wallets to start buy detection",
      });
    }

    const walletErrors = (monitorStatus.lastScannedWallets ?? []).filter(
      w => w.status === "error" || w.status === "no_key",
    );

    const heliusSvc = healthMonitor.getAll().find(s => s.name === "helius-scanner");
    const body = {
      ts: new Date().toISOString(),
      helius: {
        configured: heliusConfigured,
        lastError: monitorStatus.heliusLastError ?? counters.lastHeliusError ?? heliusSvc?.lastError ?? null,
        lastOkAt: counters.lastHeliusOkAt ?? heliusSvc?.lastOkAt ?? null,
        lastLatencyMs: counters.lastHeliusLatencyMs ?? heliusSvc?.avgLatencyMs ?? null,
        okCount: counters.heliusOk,
        errCount: counters.heliusErr,
        status: heliusSvc?.status ?? (heliusConfigured ? "unknown" : "down"),
      },
      scan: {
        running: monitorStatus.running,
        cycleCount: monitorStatus.cycleCount,
        lastScanAt: monitorStatus.lastScanAt,
        nextScanAt: monitorStatus.nextScanAt,
        lastDurationMs: monitorStatus.lastScanDurationMs,
        lastBuysDetected: monitorStatus.lastBuysDetected,
        totalBuysAllTime: monitorStatus.totalBuysAllTime,
        walletsTracked: monitorStatus.walletsTracked,
        scanAgeSec,
        delayed: scanDelayed,
        stopped: scanStopped,
        walletErrors: walletErrors.slice(0, 12).map(w => ({
          label: w.label,
          address: w.address.slice(0, 8) + "…",
          status: w.status,
          error: w.lastError,
        })),
      },
      telegram: {
        configured: telegramConfigured,
        lastOkAt: counters.lastTelegramOkAt,
        lastError: counters.lastTelegramError,
        okCount: counters.telegramOk,
        errCount: counters.telegramErr,
        pendingFirstCalls,
        pendingMilestones,
      },
      pro: {
        lastQualifyAt: counters.lastProQualifyAt,
        insertedTotal: counters.proInserted,
        qualityBelowRecent: qualityBelowBlocked,
      },
      buys: {
        sessionCount: counters.buys,
        lastBuyAt: counters.lastBuyAt,
      },
      pipeline: {
        summary: healthMonitor.getSummary(),
        services: healthMonitor.getAll(),
      },
      blockers,
    };

    res.setHeader("Cache-Control", "private, max-age=5");
    res.json(body);
  } catch (err) {
    console.error("ops summary error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Record that the ops API itself is reachable (called lightly from UI)
router.post("/ops/ack", (req, res) => {
  const msg = typeof req.body?.msg === "string" ? req.body.msg : "client ack";
  opsLog("api", "info", msg.slice(0, 120));
  res.json({ ok: true });
});

export default router;
