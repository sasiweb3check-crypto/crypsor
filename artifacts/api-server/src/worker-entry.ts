import { initialize, pool } from "./tracking/store";
import { startRuntime } from "./jobs/runtime";
await initialize();
const stop = await startRuntime();
console.log("Crypsor durable workers started");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void stop()
      .then(() => pool.end())
      .then(() => process.exit(0));
    setTimeout(() => process.exit(1), 60_000).unref();
  });
