import pg from "../artifacts/api-server/node_modules/pg/lib/index.js";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const fixture = `crypsor_startup_${Date.now()}`;
const admin = new pg.Pool({
  connectionString: "postgresql://postgres@127.0.0.1:5432/postgres",
});
let blockers,
  child,
  log = "";
let clients = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(200);
  }
  throw Error("Startup fixture timed out");
}
try {
  await admin.query(`CREATE ROLE ${fixture} LOGIN CONNECTION LIMIT 5`);
  await admin.query(`CREATE DATABASE ${fixture} OWNER ${fixture}`);
  const url = `postgresql://${fixture}@127.0.0.1:5432/${fixture}`;
  blockers = new pg.Pool({ connectionString: url, max: 4 });
  for (let i = 0; i < 4; i++) clients.push(await blockers.connect());
  const env = {
    ...process.env,
    DATABASE_URL: url,
    PG_POOL_MAX: "2",
    PORT: "3451",
    PROCESS_ROLE: "all",
  };
  for (const k of ["AIVEN_DATABASE_URL", "REDIS_URL", "HELIUS_API_KEY"])
    delete env[k];
  child = spawn(process.execPath, ["artifacts/api-server/launch.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    log += d;
  });
  child.stderr.on("data", (d) => {
    log += d;
  });
  await until(() => log.includes("Crypsor API listening"));
  const health = await fetch("http://127.0.0.1:3451/api/healthz");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  await until(() => log.includes("53300"));
  console.log(
    "API opened its port and passed readiness with only one free slot; worker retried actual PostgreSQL 53300.",
  );
  for (const c of clients) c.release();
  clients = [];
  await blockers.end();
  blockers = undefined;
  await until(() => log.includes("Crypsor durable workers started"));
  assert.ok(
    log.indexOf("Crypsor API listening") <
      log.indexOf("Crypsor durable workers started"),
  );
  const dashboard = await fetch("http://127.0.0.1:3451/api/dashboard");
  assert.equal(dashboard.status, 200);
  const monitoring = await fetch("http://127.0.0.1:3451/api/monitoring");
  assert.equal(monitoring.status, 200);
  assert.equal((await monitoring.json()).workersHealthy, true);
  console.log(
    "After old connections drained, the worker recovered and dashboard/monitoring returned 200 with two connections per process.",
  );
} finally {
  if (child) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const c of clients) c.release();
  if (blockers) await blockers.end();
  await admin.query(`DROP DATABASE IF EXISTS ${fixture} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${fixture}`);
  await admin.end();
}
