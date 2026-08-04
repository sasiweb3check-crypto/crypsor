/**
 * Serverless entry — Express app + lazy pipeline boot (no PORT listen).
 * Built by build.mjs → dist/vercel.mjs for the Vercel `api/` handler.
 */
import app from "./app";
import { ensureVercelRuntime } from "./vercel-runtime";

void ensureVercelRuntime().catch(() => {});

export default app;
