/**
 * Vercel serverless entry — default-exports the Express app.
 * Runtime loops boot lazily on the first request (see routes middleware).
 */
import app from "./app";

export default app;
