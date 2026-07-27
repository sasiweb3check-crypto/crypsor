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
});
export const db = drizzle(pool, { schema });

export * from "./schema";
