import express, { type Express } from "express";
import cors from "cors";
import routes from "./routes/index";
import { mountSpa } from "./spa";

const app: Express = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

const corsOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors(
    corsOrigins.length > 0
      ? { origin: corsOrigins, credentials: true }
      : undefined,
  ),
);
app.use(express.json({ limit: "256kb" }));
app.use("/api", routes);
mountSpa(app);

export default app;
