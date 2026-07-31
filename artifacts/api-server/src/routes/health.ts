import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { pipelineQueue } from "../lib/job-queue";
import { monitorStatus } from "../lib/monitor";
import { healthMonitor } from "../pipeline/health-monitor";
import { hasGmgnOpenApiKey } from "../lib/gmgn-openapi";

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    const t0 = Date.now();
    await db.execute(sql`SELECT 1`);
    checks.db = { ok: true, detail: `${Date.now() - t0}ms` };
  } catch (err) {
    checks.db = { ok: false, detail: String(err).slice(0, 120) };
  }

  checks.helius = {
    ok: !!monitorStatus.heliusConfigured,
    detail: monitorStatus.heliusConfigured
      ? (monitorStatus.heliusLastError ? `last_error:${monitorStatus.heliusLastError.slice(0, 80)}` : "configured")
      : "missing_key",
  };

  const openApi = hasGmgnOpenApiKey();
  checks.gmgnOpenApi = {
    ok: openApi,
    detail: openApi ? "key_present" : "missing_GMGN_API_KEY",
  };

  const q = pipelineQueue.getStatus();
  const waiting = pipelineQueue.totalWaiting();
  checks.queue = {
    ok: waiting < 500,
    detail: `waiting=${waiting} pro=${q.pro?.waiting ?? 0} intel=${q.intel?.waiting ?? 0}`,
  };

  checks.monitor = {
    ok: monitorStatus.running,
    detail: monitorStatus.running
      ? `cycle=${monitorStatus.cycleCount} wallets=${monitorStatus.walletsTracked}`
      : "not_running",
  };

  const services = healthMonitor.getAll();
  const badServices = services.filter(s => s.status === "down" || s.status === "degraded");
  checks.pipeline = {
    ok: badServices.filter(s => s.status === "down").length === 0,
    detail: badServices.length
      ? badServices.map(s => `${s.name}:${s.status}`).slice(0, 5).join(",")
      : `${services.length} services`,
  };

  const criticalOk = checks.db.ok;
  const status = !criticalOk ? "error" : (Object.values(checks).every(c => c.ok) ? "ok" : "degraded");

  res.status(criticalOk ? 200 : 503).json({
    status,
    checks,
    ts: new Date().toISOString(),
  });
});

export default router;
