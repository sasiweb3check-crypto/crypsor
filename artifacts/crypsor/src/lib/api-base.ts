/**
 * API origin for fetch/SSE.
 *
 * Same-origin on Vercel (SPA + API in one project): leave VITE_API_URL unset
 * so requests go to `/api/...` on the current host.
 *
 * Split deploy only: set VITE_API_URL to the API origin (no trailing slash).
 */
export function getApiBase(): string {
  const raw = import.meta.env.VITE_API_URL as string | undefined;
  if (raw == null || raw.trim() === "") {
    const base = (import.meta.env.BASE_URL as string | undefined) ?? "/";
    return base.endsWith("/") ? base : `${base}/`;
  }
  return raw.endsWith("/") ? raw : `${raw}/`;
}
