import pg from "pg";
import { migrate } from "./schema.ts";
import { retryStartup } from "./startup.ts";
let connectionString =
  process.env.AIVEN_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
const remote = connectionString
  ? !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      new URL(connectionString).hostname,
    )
  : false;
if (connectionString && remote) {
  const url = new URL(connectionString);
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"])
    url.searchParams.delete(key);
  connectionString = url.toString();
}
const max = Number(process.env.PG_POOL_MAX ?? 2);
if (!Number.isInteger(max) || max < 2 || max > 100)
  throw new Error("PG_POOL_MAX must be an integer between 2 and 100");
export const pool = new pg.Pool({
  connectionString,
  ssl: remote
    ? {
        rejectUnauthorized: true,
        ...(process.env.AIVEN_CA_CERT
          ? { ca: process.env.AIVEN_CA_CERT.replace(/\\n/g, "\n") }
          : {}),
      }
    : undefined,
  max,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
});
pool.on("error", (error) => {
  // Idle connection failures must not terminate the API. Log codes, never credentials.
  console.error("Database pool connection failed", {
    code: (error as { code?: string }).code,
  });
});
export const configured = Boolean(connectionString);
export async function initialize() {
  if (!configured) throw new Error("Set AIVEN_DATABASE_URL or DATABASE_URL");
  await retryStartup(() => migrate(pool), {
    report: (code, attempt) =>
      console.warn("Database startup temporarily unavailable; retrying", {
        code,
        attempt,
      }),
  });
}
