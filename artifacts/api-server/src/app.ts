import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

function resolveCorsOrigins(): string[] | true | false {
  const fromEnv = (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const extras: string[] = [];
  // Same-project Vercel deploy: allow the deployment host when set.
  if (process.env.VERCEL_URL) {
    extras.push(`https://${process.env.VERCEL_URL}`);
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    extras.push(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  }

  const origins = [...new Set([...fromEnv, ...extras])];
  if (origins.length > 0) return origins;
  // Local / same-origin SPA+API: reflect request origin
  if (process.env.NODE_ENV !== "production") return true;
  // Production same-origin (no CORS_ORIGIN): disable cross-origin; browsers
  // still allow same-origin /api calls without CORS.
  return false;
}

app.use(
  cors({
    origin: resolveCorsOrigins(),
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
