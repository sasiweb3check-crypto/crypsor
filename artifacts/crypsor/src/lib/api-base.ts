/**
 * API origin for fetch/SSE.
 *
 * Same-origin on Vercel (SPA + API in one project): leave VITE_API_URL unset
 * so requests go to `/api/...` on the current host.
 *
 * Split deploy only: set VITE_API_URL to a live API origin (no trailing slash).
 *
 * Safety: if this page is on *.vercel.app and VITE_API_URL still points at a
 * suspended Render host, force same-origin so Settings/desk keep working.
 */
export function getApiBase(): string {
  const raw = (import.meta.env.VITE_API_URL as string | undefined)?.trim();

  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    const onVercel = host.endsWith(".vercel.app");
    const pointsAtRender = Boolean(raw && /onrender\.com/i.test(raw));
    if (onVercel && (!raw || pointsAtRender)) {
      return "/";
    }
  }

  if (raw == null || raw === "") {
    const base = (import.meta.env.BASE_URL as string | undefined) ?? "/";
    return base.endsWith("/") ? base : `${base}/`;
  }
  return raw.endsWith("/") ? raw : `${raw}/`;
}
