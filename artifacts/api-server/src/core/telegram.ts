import { logger } from "./log";
import { getSetting } from "./settings";

export function esc(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}

export async function sendTelegram(text: string): Promise<boolean> {
  try {
    const token = (await getSetting("telegram_bot_token")) ?? process.env.TELEGRAM_BOT_TOKEN;
    const chat = (await getSetting("telegram_chat_id")) ?? process.env.TELEGRAM_CHAT_ID;
    if (!token || !chat) return false;
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return resp.ok;
  } catch (err) {
    logger.warn({ err }, "telegram send failed");
    return false;
  }
}
