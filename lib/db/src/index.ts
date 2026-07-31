import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const rawDatabaseUrl =
  process.env.AIVEN_DATABASE_URL ?? process.env.DATABASE_URL;

if (!rawDatabaseUrl) {
  throw new Error(
    "AIVEN_DATABASE_URL or DATABASE_URL must be set. Configure the database connection before starting the API.",
  );
}

const isAivenDatabase = rawDatabaseUrl.includes("aivencloud.com");
const databaseUrl = isAivenDatabase
  ? (() => {
      const url = new URL(rawDatabaseUrl);
      // node-postgres treats sslmode=require as certificate verification.
      // Aiven's URL already requires TLS; the explicit Pool SSL option below
      // handles the managed certificate chain.
      url.searchParams.delete("sslmode");
      return url.toString();
    })()
  : rawDatabaseUrl;

const isProduction = process.env.NODE_ENV === "production";
const requiresSsl =
  rawDatabaseUrl.includes("sslmode=require") ||
  isAivenDatabase ||
  isProduction;

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl: requiresSsl ? { rejectUnauthorized: false } : undefined,
  // Keep the free Render + Aiven path snappy: small pool, fail fast on
  // cold connects, recycle idle clients so TLS sessions stay warm.
  max: Number(process.env.PG_POOL_MAX ?? 8),
  min: Number(process.env.PG_POOL_MIN ?? 1),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: false,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
