/**
 * Telegram push gate — env default + runtime DB toggle from Settings.
 *
 * Env TELEGRAM_PUSH_ENABLED=false always mutes (hard off).
 * Otherwise Settings key `telegram_push_enabled` ("true"|"false") controls send.
 */
import { db, settings } from "@workspace/db";
import { eq } from "drizzle-orm";

const ENV_MUTED = process.env.TELEGRAM_PUSH_ENABLED === "false";

let cached: { enabled: boolean; at: number } | null = null;
const CACHE_MS = 5_000;

export function invalidateTelegramPushCache(): void {
  cached = null;
}

/** Env hard-off or DB toggle. Safe default: ON when unset. */
export async function isTelegramPushEnabled(): Promise<boolean> {
  if (ENV_MUTED) return false;
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.enabled;
  try {
    const rows = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, "telegram_push_enabled"))
      .limit(1);
    const raw = (rows[0]?.value ?? "true").trim().toLowerCase();
    const enabled = raw !== "false" && raw !== "0" && raw !== "off";
    cached = { enabled, at: now };
    return enabled;
  } catch {
    return true;
  }
}

export function telegramPushEnvMuted(): boolean {
  return ENV_MUTED;
}
