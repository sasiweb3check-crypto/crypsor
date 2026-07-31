/**
 * API origin for fetch/SSE.
 *
 * Production (Vercel → Render): set VITE_API_URL to the Render service URL
 * (e.g. https://crypsor-api.onrender.com) — no trailing slash required.
 * Local / same-origin: falls back to Vite BASE_URL ("/").
 */
export function getApiBase(): string {
  const raw =
    (import.meta.env.VITE_API_URL as string | undefined) ??
    (import.meta.env.BASE_URL as string | undefined) ??
    "/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}
