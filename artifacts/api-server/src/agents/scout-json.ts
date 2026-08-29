/**
 * node-pg sends JS arrays as Postgres text[] (`{a,b}`), which jsonb rejects
 * with "invalid input syntax for type json". Always pass JSON text instead.
 */
export function sqlJson(v: unknown): string | null {
  if (v == null) return null;
  return JSON.stringify(v, (_k, val) => {
    if (typeof val === "number" && !Number.isFinite(val)) return null;
    if (typeof val === "string") return val.replace(/\u0000/g, "");
    return val;
  });
}
