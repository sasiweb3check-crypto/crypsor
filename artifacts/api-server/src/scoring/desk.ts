/**
 * Wallet-buy desk — detected MC is frozen at the buy.
 * Gain is last print vs that freeze. No scoring.
 */

export const MC_DEAD = 5_000;

export type TokenStatus = "live" | "running" | "dead";

export function gainPct(lastMc: number | null | undefined, detectedMc: number | null | undefined): number | null {
  if (lastMc == null || detectedMc == null || !Number.isFinite(lastMc) || !Number.isFinite(detectedMc) || detectedMc <= 0) {
    return null;
  }
  return ((lastMc / detectedMc) - 1) * 100;
}

/** MC under $5k is archived. Positive gain vs detected is running. Else live. */
export function statusOf(lastMc: number | null | undefined, detectedMc: number | null | undefined): TokenStatus {
  const last = lastMc != null && Number.isFinite(lastMc) ? lastMc : null;
  const det = detectedMc != null && Number.isFinite(detectedMc) ? detectedMc : null;
  const mc = last ?? det;
  if (mc != null && mc < MC_DEAD) return "dead";
  if (last != null && det != null && det > 0 && last > det) return "running";
  return "live";
}
