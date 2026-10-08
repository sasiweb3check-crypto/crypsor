import app from "./app";
import { initialize, pool } from "./tracking/store";
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
await initialize();
const server = app.listen(port, "0.0.0.0", () =>
  console.log(`Crypsor API listening on ${port}`),
);
server.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close(() => void pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 20_000).unref();
  });
