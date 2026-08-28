/**
 * API origin for fetch/SSE.
 *
 * Same-origin on Render or Vercel (SPA + API in one project): leave
 * VITE_API_URL unset so requests go to `/api/...` on the current host.
 *
 * Split deploy only: set VITE_API_URL to a live API origin (no trailing slash).
 *
 * Safety: if this page is on *.vercel.app / *.onrender.com, force same-origin
 * unless VITE_API_URL points at a *different* host (true split deploy).
 */
export function getApiBase(): string {
  const raw = (import.meta.env.VITE_API_URL as string | undefined)?.trim();

  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    const onVercel = host.endsWith(".vercel.app");
    const onRender = host.endsWith(".onrender.com");
    if ((onVercel || onRender) && !raw) {
      return "/";
    }
    const pointsAtRender = Boolean(raw && /onrender\.com/i.test(raw));
    if (onVercel && pointsAtRender) {
      return "/";
    }
    if (onRender && raw) {
      try {
        if (new URL(raw).hostname === host) return "/";
      } catch {
        return "/";
      }
    }
  }

  if (raw == null || raw === "") {
    const base = (import.meta.env.BASE_URL as string | undefined) ?? "/";
    return base.endsWith("/") ? base : `${base}/`;
  }
  return raw.endsWith("/") ? raw : `${raw}/`;
}
