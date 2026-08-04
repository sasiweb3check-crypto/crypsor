import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import healthRouter   from "./health";
import settingsRouter from "./settings";
import walletsRouter  from "./wallets";
import tokensRouter   from "./tokens";
import dashboardRouter from "./dashboard";
import monitorRouter  from "./monitor";
import pipelineRouter from "./pipeline";
import assetsRouter   from "./assets";
import holdersRouter  from "./holders";
import intelLogRouter from "./intel-log";
import callerRouter   from "./caller";
import proRouter      from "./pro";
import runnerRouter   from "./runner";
import traderRouter   from "./trader";
import callsRouter    from "./calls";
import gemsRouter     from "./gems";
import opsRouter      from "./ops";
import walletTrackRouter from "./wallet-track";
import alertsRouter   from "./alerts";
import cronRouter     from "./cron";
import { sseHandler } from "../pipeline/sse-gateway";
import { apiFail } from "../lib/api-envelope";
import { ensureVercelRuntime } from "../vercel-runtime";

const router: IRouter = Router();

// Fluid Compute: ensure wallet/pump loops are running on this warm instance.
router.use((_req, _res, next) => {
  if (process.env.VERCEL) {
    void ensureVercelRuntime().finally(() => next());
    return;
  }
  next();
});

/**
 * Legacy / heavy surfaces (holders bulk, caller, runner desk, trader autopilot,
 * intel-log browser). Off by default to cut capacity — set ENABLE_HEAVY_ROUTES=1
 * to re-enable. Pro stays mounted (token detail / ops research).
 */
const heavyRoutesEnabled = process.env.ENABLE_HEAVY_ROUTES === "1";

function heavyDisabled(_req: Request, res: Response) {
  res.status(410).json(apiFail(
    "Route disabled for capacity — set ENABLE_HEAVY_ROUTES=1 to enable",
    "heavy_routes_off",
  ));
}

function blockHeavyPaths(req: Request, res: Response, next: NextFunction) {
  const p = req.path;
  if (
    p === "/intel-log" || p.startsWith("/intel-log/") ||
    p === "/caller" || p.startsWith("/caller/") ||
    p === "/runner" || p.startsWith("/runner/") ||
    p === "/trader" || p.startsWith("/trader/")
  ) {
    return heavyDisabled(req, res);
  }
  next();
}

router.use(healthRouter);
router.use(cronRouter);
router.use("/settings",  settingsRouter);
router.use("/wallets",   walletsRouter);
router.use("/tokens",    tokensRouter);
router.use("/dashboard", dashboardRouter);
router.use("/monitor",   monitorRouter);
router.use("/pipeline",  pipelineRouter);
router.use("/assets",    assetsRouter);
router.use(callsRouter);
router.use(gemsRouter);
router.use(walletTrackRouter);
router.use(alertsRouter);
router.use(proRouter);
router.use(opsRouter);

if (heavyRoutesEnabled) {
  router.use("/holders", holdersRouter);
  router.use(intelLogRouter);
  router.use(callerRouter);
  router.use(runnerRouter);
  router.use(traderRouter);
} else {
  router.use("/holders", heavyDisabled);
  router.use(blockHeavyPaths);
}

router.get("/events", sseHandler);

export default router;
