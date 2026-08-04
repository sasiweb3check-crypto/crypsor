/**
 * Vercel Function entry (Hobby-safe).
 *
 * Loads the esbuild bundle from the same folder (copied during buildCommand).
 * Surfaces missing-env / import errors as JSON instead of a blank 500.
 */
let appPromise = null;

function missingDbEnv() {
  return !(
    process.env.AIVEN_DATABASE_URL?.trim()
    || process.env.DATABASE_URL?.trim()
  );
}

async function getApp() {
  if (!appPromise) {
    appPromise = import("./vercel.mjs")
      .then((m) => {
        const app = m.default;
        if (!app) throw new Error("vercel.mjs has no default export");
        return app;
      })
      .catch((err) => {
        appPromise = null;
        throw err;
      });
  }
  return appPromise;
}

export default async function handler(req, res) {
  try {
    if (missingDbEnv()) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({
        ok: false,
        error: "Missing AIVEN_DATABASE_URL (or DATABASE_URL) in Vercel env",
        code: "missing_database_url",
      }));
      return;
    }

    const app = await getApp();
    return app(req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api] handler boot failed:", message);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      ok: false,
      error: message,
      code: "api_boot_failed",
      hint: "Check Vercel Function logs. Ensure build copied api/vercel.mjs and DB/Helius env vars are set.",
    }));
  }
}
