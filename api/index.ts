/**
 * Vercel serverless / Fluid Compute entry.
 * Same-origin with the Vite SPA — requests to /api/* land here.
 */
import app from "../artifacts/api-server/src/app";
import { ensureVercelRuntime } from "../artifacts/api-server/src/vercel-runtime";

// Kick pipeline on cold start (non-blocking). Cron + request middleware also call this.
void ensureVercelRuntime().catch(() => {});

export default app;
