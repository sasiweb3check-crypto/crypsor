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

    // Parallel DB reads — sequential awaits made Logs feel broken on tab switch
    const [tgRows, pendingSettled, invSettled] = await Promise.all([
      db
        .select({ key: settings.key, value: settings.value })
        .from(settings)
        .where(sql`key IN ('telegram_bot_token', 'telegram_chat_id', 'helius_api_key')`),
      db.execute(sql`
        SELECT
          COUNT(*) FILTER (
            WHERE quality_label = 'very_good' AND call_alert_sent_at IS NULL
          )::int AS pending_first,
          COUNT(*) FILTER (
            WHERE quality_label = 'very_good'
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
      `).then(r => ({ ok: true as const, r })).catch(() => ({ ok: false as const })),
      db.execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM tracked_tokens) AS tokens,
          (SELECT COUNT(*)::int FROM tracked_tokens
             WHERE COALESCE(status, '') NOT IN ('ignored', 'archive')) AS active,
          (SELECT COUNT(*)::int FROM token_buys) AS buys
      `).then(r => ({ ok: true as const, r })).catch(() => ({ ok: false as const })),
    ]);

    const bot = (tgRows.find(r => r.key === "telegram_bot_token")?.value ?? "").trim();
    const chat = (tgRows.find(r => r.key === "telegram_chat_id")?.value ?? "").trim();
    const heliusDb = (tgRows.find(r => r.key === "helius_api_key")?.value ?? "").trim();
    const telegramConfigured = Boolean(bot && chat);
    const heliusConfigured =
      monitorStatus.heliusConfigured ||
      Boolean(heliusDb || process.env.HELIUS_API_KEY?.trim());

    let pendingFirstCalls = 0;
    let pendingMilestones = 0;
    let qualityBelowBlocked = 0;
    if (pendingSettled.ok) {
      const row = pendingSettled.r.rows[0] as Record<string, unknown> | undefined;
      pendingFirstCalls = Number(row?.pending_first ?? 0);
      pendingMilestones = Number(row?.pending_ms ?? 0);
      qualityBelowBlocked = Number(row?.below_7d ?? 0);
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
        msg: `${pendingFirstCalls} very_good call(s) waiting on ENTRY gates — open Waiting lane to see holds`,
      });
    }
    if (qualityBelowBlocked > 0 && pendingFirstCalls === 0) {
      blockers.push({
        code: "quality_below",
        level: "info",
        msg: `${qualityBelowBlocked} recent pro_calls scored below (no alert until very_good)`,
      });
    }
    if (monitorStatus.walletsTracked === 0) {
      blockers.push({
        code: "no_wallets",
        level: "warn",
        msg: "No wallets tracked — add wallets to start buy detection",
      });
    }

    let tokensTracked = 0;
    let tokensActive = 0;
    let buysTotal = 0;
    if (invSettled.ok) {
      const row = invSettled.r.rows[0] as Record<string, unknown> | undefined;
      tokensTracked = Number(row?.tokens ?? 0);
      tokensActive = Number(row?.active ?? 0);
      buysTotal = Number(row?.buys ?? 0);
    }

    const walletErrors = (monitorStatus.lastScannedWallets ?? []).filter(
      w => w.status === "error" || w.status === "no_key",
    );

    const heliusSvc = healthMonitor.getAll().find(s => s.name === "helius-scanner");
    const body = {
      ts: new Date().toISOString(),
      inventory: {
        tokensTracked,
        tokensActive,
        buysTotal,
        walletsTracked: monitorStatus.walletsTracked,
      },
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

/**
 * Live GMGN wallet activity probe (OpenAPI).
 * GET /api/ops/gmgn-wallet-activity?address=&type=buy&limit=20&chain=sol
 * Defaults address to tracked "deepents" sensor when omitted.
 */
router.get("/ops/gmgn-wallet-activity", async (req, res) => {
  try {
    const DEFAULT_WALLET = "FYTVwP5hgCUiB14eYYTPtZpBCBL4tqbYFbRkjmRwbNto"; // deepents
    const address = String(req.query.address ?? DEFAULT_WALLET).trim();
    const chain = String(req.query.chain ?? "sol").trim().toLowerCase();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20) || 20));
    const cursor = req.query.cursor != null ? String(req.query.cursor) : undefined;
    const token = req.query.token != null ? String(req.query.token) : undefined;
    const typeRaw = String(req.query.type ?? "buy").trim();
    const types = typeRaw
      ? typeRaw.split(",").map(t => t.trim()).filter(Boolean) as Array<
          "buy" | "sell" | "transferIn" | "transferOut" | "add" | "remove"
        >
      : undefined;

    const { fetchOpenApiWalletActivity, hasGmgnOpenApiKey, openApiLimiterStatus } =
      await import("../lib/gmgn-openapi");
    const { gmgnFetch, nextProxy } = await import("../lib/gmgn-client");

    if (!hasGmgnOpenApiKey()) {
      res.status(503).json({
        ok: false,
        error: "GMGN_API_KEY not set",
        note: "Set GMGN_API_KEY for openapi.gmgn.ai /v1/user/wallet_activity",
      });
      return;
    }

    const t0 = Date.now();
    const openApi = await fetchOpenApiWalletActivity({
      chain,
      walletAddress: address,
      limit,
      cursor,
      types: types?.length ? types : undefined,
      token,
    });

    // Scrape fallback (proxy) — same shape many scrapers use
    const proxy = nextProxy();
    const scrapeUrl =
      `https://gmgn.ai/defi/quotation/v1/wallet/${chain}/${address}/activities?limit=${limit}`;
    const scrape = await gmgnFetch(scrapeUrl, proxy);

    const body = (openApi.data ?? null) as Record<string, unknown> | null;
    const data = (body && typeof body === "object" && "data" in body)
      ? (body.data as Record<string, unknown>)
      : body;
    const activities = Array.isArray((data as { activities?: unknown })?.activities)
      ? (data as { activities: unknown[] }).activities
      : Array.isArray(data)
        ? data
        : Array.isArray((data as { list?: unknown })?.list)
          ? (data as { list: unknown[] }).list
          : [];

    const buys = activities.filter(a => {
      const t = String((a as { type?: string })?.type ?? "").toLowerCase();
      return t === "buy";
    });

    opsLog(
      "api",
      openApi.ok ? "info" : "warn",
      `GMGN wallet_activity openapi=${openApi.ok} scrape=${scrape.ok} n=${activities.length}`,
      { wallet: address.slice(0, 8), types: typeRaw },
      Date.now() - t0,
    );

    res.json({
      ok: openApi.ok || scrape.ok,
      address,
      chain,
      types: types ?? null,
      latencyMs: Date.now() - t0,
      openApi: {
        ok: openApi.ok,
        status: openApi.status,
        activityCount: activities.length,
        buyCount: buys.length,
        next: (data as { next?: unknown })?.next ?? null,
        activities: activities.slice(0, limit),
        rawError: openApi.ok
          ? null
          : (body as { error?: string; message?: string } | null)?.error
            ?? (body as { message?: string } | null)?.message
            ?? null,
      },
      scrape: {
        ok: scrape.ok,
        status: scrape.status,
        blocked: !scrape.ok && (scrape.status === 403
          || (scrape.data as { error?: string })?.error === "cloudflare_blocked"),
        sampleKeys: scrape.ok
          ? Object.keys(
            ((scrape.data as { data?: object })?.data ?? scrape.data ?? {}) as object,
          ).slice(0, 12)
          : null,
        // Include scrape activities when OpenAPI failed but scrape worked
        activities: (!openApi.ok && scrape.ok)
          ? ((scrape.data as { data?: { activities?: unknown[] } })?.data?.activities
            ?? (scrape.data as { activities?: unknown[] })?.activities
            ?? null)
          : null,
      },
      limiter: openApiLimiterStatus(),
      note: openApi.ok
        ? "OpenAPI wallet_activity OK — use activities[].type buy/sell + cost_usd for on-add backfill"
        : "OpenAPI wallet_activity failed — check key / IPv4 / params; scrape may still work via proxy",
    });
  } catch (err) {
    console.error("ops gmgn-wallet-activity error", err);
    res.status(500).json({ ok: false, error: String(err).slice(0, 200) });
  }
});

// Live GMGN probe — OpenAPI (key) + scrape (CF) status from this host
router.get("/ops/gmgn-check", async (req, res) => {
  try {
    const mint = String(req.query.mint ?? "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263").trim();
    const { gmgnFetch, nextProxy } = await import("../lib/gmgn-client");
    const { openApiHealthCheck, hasGmgnOpenApiKey } = await import("../lib/gmgn-openapi");
    const proxy = nextProxy();
    const t0 = Date.now();

    const endpoints = [
      { name: "token_info", url: `https://gmgn.ai/api/v1/token_info/sol/${mint}` },
      { name: "holder_stat", url: `https://gmgn.ai/vas/api/v1/token_holder_stat/sol/${mint}` },
      { name: "tags_stat", url: `https://gmgn.ai/api/v1/token_wallet_tags_stat/sol/${mint}` },
      { name: "token_stat", url: `https://gmgn.ai/api/v1/token_stat/sol/${mint}` },
      {
        name: "holders_smart",
        url: `https://gmgn.ai/vas/api/v1/token_holders/sol/${mint}?limit=3&tag=smart_degen`,
      },
    ];

    // Parallel OpenAPI + scrape probes — sequential loops made Logs look "stuck/red"
    const [openApi, scrapeSettled] = await Promise.all([
      openApiHealthCheck(mint),
      Promise.allSettled(endpoints.map(ep => gmgnFetch(ep.url, proxy))),
    ]);

    const results = endpoints.map((ep, i) => {
      const settled = scrapeSettled[i];
      if (settled.status === "rejected") {
        return {
          name: ep.name,
          ok: false,
          status: 0,
          blocked: true,
          sample: String(settled.reason).slice(0, 80),
        };
      }
      const r = settled.value;
      return {
        name: ep.name,
        ok: r.ok,
        status: r.status,
        blocked: !r.ok && (r.status === 403 || r.status === 0
          || (r.data as { error?: string })?.error === "cloudflare_blocked"),
        sample: r.ok
          ? Object.keys(((r.data as { data?: object })?.data ?? r.data ?? {}) as object).slice(0, 8)
          : (r.data as { error?: string })?.error ?? null,
      };
    });
    const okCount = results.filter(r => r.ok).length;
    opsLog("api", (openApi.ok || okCount > 0) ? "info" : "warn",
      `GMGN check openapi=${openApi.ok} scrape=${okCount}/${results.length}`, {
        mint: mint.slice(0, 8),
      });

    let note: string;
    if (openApi.ok) {
      note = "Official OpenAPI OK — Pro verify uses openapi.gmgn.ai (no website Cloudflare). Key alone never unlocks gmgn.ai scrape";
    } else if (!hasGmgnOpenApiKey()) {
      note = "No GMGN_API_KEY — website scrape only. Set key from https://gmgn.ai/ai (X-APIKEY → openapi.gmgn.ai) or residential GMGN_PROXIES";
    } else if (openApi.error === "AUTH_KEY_INVALID" || openApi.status === 401 || openApi.status === 403) {
      note = "GMGN_API_KEY rejected by openapi.gmgn.ai — refresh at https://gmgn.ai/ai (header must be X-APIKEY). Also: OpenAPI is IPv4-only — disable IPv6 egress if auth looks correct";
    } else if (okCount === 0) {
      note = "OpenAPI failed and scrape blocked by Cloudflare — fix OpenAPI key or set residential GMGN_PROXIES";
    } else {
      note = `OpenAPI failed (${openApi.error ?? openApi.status}); scrape partially working`;
    }

    const { openApiLimiterStatus } = await import("../lib/gmgn-openapi");
    res.json({
      ok: openApi.ok || okCount > 0,
      mint,
      latencyMs: Date.now() - t0,
      openApi,
      limiter: openApiLimiterStatus(),
      scrape: {
        proxy: proxy ? "pool" : "direct",
        okCount,
        results,
      },
      note,
    });
  } catch (err) {
    console.error("ops gmgn-check error", err);
    res.status(500).json({ ok: false, error: String(err).slice(0, 200) });
  }
});

// Record that the ops API itself is reachable (called lightly from UI)
router.post("/ops/ack", (req, res) => {
  const msg = typeof req.body?.msg === "string" ? req.body.msg : "client ack";
  opsLog("api", "info", msg.slice(0, 120));
  res.json({ ok: true });
});

export default router;
