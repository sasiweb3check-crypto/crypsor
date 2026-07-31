import { Router } from "express";
import { monitorStatus, runScan } from "../lib/monitor";

const router = Router();

// GET /api/monitor/status
router.get("/status", (_req, res) => {
  const services = monitorStatus.pipeline?.services ?? [];
  const engines = Object.fromEntries(
    services.map(s => [s.name, s.status === "ok"]),
  );
  res.json({
    ...monitorStatus,
    engines,
  });
});

// POST /api/monitor/scan  — trigger an immediate scan
router.post("/scan", async (_req, res) => {
  res.json({ success: true }); // respond immediately
  // run in background (non-blocking)
  runScan().catch(() => {});
});

export default router;
