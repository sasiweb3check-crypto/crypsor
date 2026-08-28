/**
 * Standalone host (Render / VPS / local): binds 0.0.0.0:$PORT, starts the
 * ward agents immediately, and serves the desk SPA when WEB_DIST is present.
 */
import app from "./app";
import { pool } from "./core/db";
import { logger } from "./core/log";
import { ensureRuntime } from "./funnel/runtime";

const rawPort = process.env.PORT ?? "3000";
const port = parseInt(rawPort, 10);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled rejection — process kept alive");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception — exiting for clean restart");
  setTimeout(() => process.exit(1), 250).unref();
});

async function main(): Promise<void> {
  try {
    await ensureRuntime();
  } catch (err) {
    logger.error({ err }, "ward runtime failed to start");
    process.exit(1);
    return;
  }

  const server = app.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "crypsor ward api listening");
  });

  server.on("error", (err) => {
    logger.error({ err }, "listen failed");
    process.exit(1);
  });

  const shutdown = (): void => {
    logger.info("shutdown signal — closing HTTP server");
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 25_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
