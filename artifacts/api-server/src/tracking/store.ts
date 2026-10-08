import pg from "pg";
import { migrate } from "./schema.ts";
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
  max: Number(
    process.env.PG_POOL_MAX ?? (process.env.PROCESS_ROLE === "worker" ? 8 : 4),
  ),
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
});
export const configured = Boolean(connectionString);
export async function initialize() {
  if (!configured) throw new Error("Set AIVEN_DATABASE_URL or DATABASE_URL");
  await migrate(pool);
}
