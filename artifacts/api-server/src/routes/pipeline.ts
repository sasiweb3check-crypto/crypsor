import { Router } from "express";
import { healthMonitor } from "../pipeline/health-monitor";
import { monitorStatus } from "../lib/monitor";

const router = Router();

router.get("/health", (_req, res) => {
  const services = healthMonitor.getAll();
  const summary  = healthMonitor.getSummary();
  res.json({
    summary,
    services,
    monitor: {
      running:      monitorStatus.running,
      cycleCount:   monitorStatus.cycleCount,
      lastScanAt:   monitorStatus.lastScanAt,
      nextScanAt:   monitorStatus.nextScanAt,
      walletsTracked: monitorStatus.walletsTracked,
      lastBuysDetected: monitorStatus.lastBuysDetected,
    },
  });
});

export default router;
