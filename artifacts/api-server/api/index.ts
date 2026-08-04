import app from "../src/app";
import { ensureVercelRuntime } from "../src/vercel-runtime";

void ensureVercelRuntime().catch(() => {});

export default app;
