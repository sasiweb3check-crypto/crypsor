import { Router, type IRouter } from "express";
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
import feedRouter     from "./feed";
import socialRouter   from "./social";
import callerRouter   from "./caller";
import { sseHandler } from "../pipeline/sse-gateway";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/settings",  settingsRouter);
router.use("/wallets",   walletsRouter);
router.use("/tokens",    tokensRouter);
router.use("/dashboard", dashboardRouter);
router.use("/monitor",   monitorRouter);
router.use("/pipeline",  pipelineRouter);
router.use("/assets",    assetsRouter);
router.use("/holders",   holdersRouter);
router.use(intelLogRouter);
router.use(feedRouter);
router.use(socialRouter);
router.use(callerRouter);
router.get("/events",    sseHandler);

export default router;
