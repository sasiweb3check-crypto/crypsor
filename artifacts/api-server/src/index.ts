/**
 * Standalone host (dev / VPS): starts the API + funnel loops immediately.
 */
import app from "./app";
import { logger } from "./core/log";
import { ensureRuntime } from "./funnel/runtime";

const port = parseInt(process.env.PORT ?? "3000", 10);

app.listen(port, () => {
  logger.info({ port }, "crypsor v2 api listening");
  void ensureRuntime();
});
