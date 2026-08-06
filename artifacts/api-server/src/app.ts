import express, { type Express } from "express";
import cors from "cors";
import routes from "./routes/index";

const app: Express = express();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use("/api", routes);

export default app;
