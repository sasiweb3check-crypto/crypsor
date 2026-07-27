import { defineConfig } from "drizzle-kit";
import path from "path";

const rawDatabaseUrl =
  process.env.AIVEN_DATABASE_URL ?? process.env.DATABASE_URL;

if (!rawDatabaseUrl) {
  throw new Error(
    "AIVEN_DATABASE_URL or DATABASE_URL must be set before running Drizzle.",
  );
}

const databaseUrl = rawDatabaseUrl.includes("aivencloud.com")
  ? (() => {
      const url = new URL(rawDatabaseUrl);
      // Drizzle passes URL credentials directly to node-postgres, so use its
      // explicit encrypted/no-certificate-verification mode for Aiven.
      url.searchParams.set("sslmode", "no-verify");
      return url.toString();
    })()
  : rawDatabaseUrl;

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
