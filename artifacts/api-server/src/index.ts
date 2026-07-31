import app from "./app";
import { logger } from "./lib/logger";
import { startMonitor } from "./lib/monitor";
import { ensureProIndexes } from "./lib/pro-indexes";
import { pool } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Keep the process alive across transient async failures (Redis blips, flaky
// upstreams). Uncaught sync exceptions still exit after logging so Render can
// restart from a clean state.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection — process kept alive");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — exiting for clean restart");
  // Allow logs to flush, then exit so the supervisor restarts us.
  setTimeout(() => process.exit(1), 250).unref();
});

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Warm one DB connection + ensure pro indexes before pipeline contention.
  try {
    await pool.query("select 1");
    await ensureProIndexes();
  } catch (warmErr) {
    logger.warn({ err: warmErr }, "DB warmup / pro index ensure failed");
  }

  startMonitor();
});
