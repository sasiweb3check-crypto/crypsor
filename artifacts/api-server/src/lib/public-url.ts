/** Absolute public origin for asset / share links (no trailing slash). */
export function publicApiOrigin(): string {
  const fromEnv = (
    process.env.PUBLIC_API_URL
    || process.env.VERCEL_PROJECT_PRODUCTION_URL
    || process.env.VERCEL_URL
    || process.env.RENDER_EXTERNAL_URL
    || ""
  ).trim();
  if (!fromEnv) return "";
  const withScheme = /^https?:\/\//i.test(fromEnv) ? fromEnv : `https://${fromEnv}`;
  return withScheme.replace(/\/$/, "");
}
