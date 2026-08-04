/**
 * Shared Telegram send — used by pump-desk alerts (active) and legacy caller-alerts.
 */
import { db, settings } from "@workspace/db";
import { sql } from "drizzle-orm";
import { opsLog } from "./ops-log";
import { isTelegramPushEnabled } from "./telegram-push";

export async function getTelegramCreds(): Promise<{ botToken: string; chatId: string } | null> {
  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(sql`key IN ('telegram_bot_token', 'telegram_chat_id')`);
    const botToken = rows.find((r) => r.key === "telegram_bot_token")?.value?.trim() ?? "";
    const chatId = rows.find((r) => r.key === "telegram_chat_id")?.value?.trim() ?? "";
    if (!botToken || !chatId) return null;
    return { botToken, chatId };
  } catch {
    return null;
  }
}

export async function sendTelegramMessage(
  text: string,
  opts?: { attempt?: number },
): Promise<{ ok: boolean; error?: string }> {
  const pushOn = await isTelegramPushEnabled();
  if (!pushOn) return { ok: false, error: "push_muted" };
  const creds = await getTelegramCreds();
  if (!creds) return { ok: false, error: "missing_creds" };

  const attempt = opts?.attempt ?? 0;
  const chat_id = /^-?\d+$/.test(creds.chatId) ? Number(creds.chatId) : creds.chatId;
  const url = `https://api.telegram.org/bot${creds.botToken}/sendMessage`;
  const t0 = Date.now();

  const doFetch = async (body: Record<string, unknown>): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let resp = await doFetch({
      chat_id,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    });
    if (!resp.ok) {
      const plain = text.replace(/\\([_*[\]()~`>#+=|{}.!\-\\])/g, "$1");
      resp = await doFetch({ chat_id, text: plain, disable_web_page_preview: true });
    }
    const latencyMs = Date.now() - t0;
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const err = `Telegram ${resp.status}: ${body.slice(0, 300)}`;
      opsLog("telegram", "error", err, { latencyMs, attempt }, latencyMs);
      return { ok: false, error: err };
    }
    opsLog("telegram", "info", "Telegram send OK", { attempt }, latencyMs);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const transient =
      msg.includes("fetch failed")
      || msg.includes("Abort")
      || msg.includes("ECONN")
      || msg.includes("ETIMEDOUT");
    if (transient && attempt < 2) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      return sendTelegramMessage(text, { attempt: attempt + 1 });
    }
    opsLog("telegram", "error", msg, { attempt });
    return { ok: false, error: msg };
  }
}

export function escTelegram(s: string): string {
  return s.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

export function fmtUsdCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "?";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}
