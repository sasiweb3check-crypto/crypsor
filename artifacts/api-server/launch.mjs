import { spawn } from "node:child_process";
import path from "node:path";
const role = process.env.PROCESS_ROLE ?? "all";
if (!["all", "api", "worker"].includes(role))
  throw new Error("PROCESS_ROLE must be all, api or worker");
let stopping = false;
const children = new Set();
let workerRestarts = 0;
let workerStarted = false;
function start(kind) {
  const child = spawn(
    process.execPath,
    [
      "--enable-source-maps",
      path.join(
        import.meta.dirname,
        "dist",
        kind === "api" ? "index.mjs" : "worker-entry.mjs",
      ),
    ],
    {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { ...process.env, PROCESS_ROLE: kind },
    },
  );
  children.add(child);
  child.on("message", (message) => {
    if (
      kind === "api" &&
      message === "api-ready" &&
      role === "all" &&
      !workerStarted &&
      !stopping
    ) {
      workerStarted = true;
      start("worker");
    }
  });
  child.on("error", () => {
    if (!stopping) {
      stopping = true;
      for (const c of children) c.kill("SIGTERM");
      process.exitCode = 1;
    }
  });
  child.on("exit", (code) => {
    children.delete(child);
    if (stopping) return;
    if (kind === "api") {
      stopping = true;
      for (const c of children) c.kill("SIGTERM");
      process.exitCode = code || 1;
    } else {
      console.error("Worker exited; restarting with backoff");
      setTimeout(
        () => {
          if (!stopping) start("worker");
        },
        Math.min(30_000, 1000 * 2 ** Math.min(workerRestarts++, 5)),
      );
    }
  });
}
if (role !== "worker") start("api");
if (role === "worker") start("worker");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    for (const child of children) child.kill(signal);
    setTimeout(() => process.exit(0), 65_000).unref();
  });
