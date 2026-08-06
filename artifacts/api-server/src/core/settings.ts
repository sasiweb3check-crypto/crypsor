import { pool } from "./db";

const cache = new Map<string, { v: string | null; at: number }>();
const TTL = 30_000;

export async function getSetting(key: string): Promise<string | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  const r = await pool.query("SELECT value FROM settings WHERE key = $1 LIMIT 1", [key]);
  const v = (r.rows[0]?.value as string | undefined)?.trim() || null;
  cache.set(key, { v, at: Date.now() });
  return v;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value],
  );
  cache.delete(key);
}

export async function heliusKey(): Promise<string | null> {
  return (await getSetting("helius_api_key")) ?? process.env.HELIUS_API_KEY?.trim() ?? null;
}
