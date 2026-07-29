/**
 * Caller Alerts
 *
 * Rule: intelligenceScore >= 90 AND (holderKolCount >= 1 OR holderSmartCount >= 1)
 * Message: name · symbol · CA (copy) · MC at snapshot · GMGN link · socials
 * Cooldown: 6h per token · Cycle: 5 min
 */

import { db } from "@workspace/db";
import { tracked_tokens, settings } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const log = logger.child({ module: "caller-alerts" });

const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1_000; // 6 hours per token
const CHECK_INTERVAL_MS = 5 * 60 * 1_000;       // every 5 minutes
const MIN_INTEL_SCORE   = 90;

const lastAlerted = new Map<number, number>(); // tokenId → last sent ms

// ── Telegram credentials ──────────────────────────────────────────────────────

async function getTelegramCreds(): Promise<{ botToken: string; chatId: string } | null> {
  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(sql`key IN ('telegram_bot_token', 'telegram_chat_id')`);
    const botToken = rows.find(r => r.key === "telegram_bot_token")?.value?.trim() ?? "";
    const chatId   = rows.find(r => r.key === "telegram_chat_id")?.value?.trim()   ?? "";
    if (!botToken || !chatId) return null;
    return { botToken, chatId };
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMc(usd: string | number | null | undefined): string {
  const n = typeof usd === "string" ? parseFloat(usd) : (usd ?? 0);
  if (!n || !isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Escape MarkdownV2 special characters */
function esc(s: string): string {
  return s.replace(/[_*[\]()~`>#+=|{}.!\-\\]/g, "\\$&");
}

interface Socials {
  twitter?: string;
  telegram?: string;
  website?: string;
}

function extractSocials(rawMetadata: unknown): Socials {
  if (!rawMetadata || typeof rawMetadata !== "object") return {};
  const meta = rawMetadata as Record<string, unknown>;
  const pairs = Array.isArray(meta.pairs) ? meta.pairs : [];
  const info  = (pairs[0] as Record<string, unknown> | undefined)?.info;
  if (!info || typeof info !== "object") return {};
  const infoObj = info as Record<string, unknown>;
  const socials: Socials = {};

  for (const s of Array.isArray(infoObj.socials) ? infoObj.socials : []) {
    if (!s || typeof s !== "object") continue;
    const entry = s as Record<string, string>;
    if (entry.type === "twitter"  && entry.url) socials.twitter  = entry.url;
    if (entry.type === "telegram" && entry.url) socials.telegram = entry.url;
  }
  for (const w of Array.isArray(infoObj.websites) ? infoObj.websites : []) {
    if (w && typeof w === "object") {
      const url = (w as Record<string, string>).url;
      if (url) { socials.website = url; break; }
    }
  }
  return socials;
}

// ── Build & send ──────────────────────────────────────────────────────────────

async function sendRunnerAlert(
  creds: { botToken: string; chatId: string },
  token: {
    name: string | null;
    symbol: string | null;
    address: string;
    chain: string;
    snapshotMc: string | null;
    holderKolCount: number;
    holderSmartCount: number;
    intelligenceScore: number;
    socials: Socials;
  },
): Promise<void> {
  const name   = esc(token.name   ?? "Unknown");
  const symbol = esc(token.symbol ?? "?");
  const mc     = esc(fmtMc(token.snapshotMc));
  const intel  = token.intelligenceScore;

  const gmgnLink = token.chain === "solana"
    ? `https://gmgn\\.ai/sol/token/${token.address}`
    : `https://dexscreener\\.com/${esc(token.chain)}/${token.address}`;

  const socialLines: string[] = [];
  if (token.socials.twitter)  socialLines.push(`🐦 [Twitter](${token.socials.twitter})`);
  if (token.socials.telegram) socialLines.push(`✈️ [Telegram](${token.socials.telegram})`);
  if (token.socials.website)  socialLines.push(`🌐 [Website](${token.socials.website})`);

  const lines = [
    `🚀 *${name}* \\(${symbol}\\)`,
    ``,
    `Intel: *${intel}* · KOL: ${token.holderKolCount} · Smart: ${token.holderSmartCount}`,
    `MC at call: *${mc}*`,
    ``,
    `\`${token.address}\``,
    ``,
    `🔗 [View on GMGN](${gmgnLink})`,
    ...(socialLines.length ? [``, ...socialLines] : []),
  ];

  const resp = await fetch(
    `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    creds.chatId,
        text:       lines.join("\n"),
        parse_mode: "MarkdownV2",
        disable_web_page_preview: false,
      }),
    },
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Telegram ${resp.status}: ${body.slice(0, 300)}`);
  }
}

// ── Main check ────────────────────────────────────────────────────────────────

async function checkAndAlert(): Promise<void> {
  const creds = await getTelegramCreds();
  if (!creds) {
    log.debug("Telegram not configured — skipping");
    return;
  }

  // Get the MC from the most recent intel log snapshot per token
  const mcRows = await db.execute(sql`
    SELECT DISTINCT ON (token_id)
      token_id,
      market_cap_usd AS snap_mc
    FROM token_intel_log
    ORDER BY token_id, computed_at DESC
  `);
  const snapMcMap = new Map<number, string | null>();
  for (const r of mcRows.rows as { token_id: number; snap_mc: string | null }[]) {
    snapMcMap.set(r.token_id, r.snap_mc);
  }

  // Qualifying tokens: intel >= 90 AND at least 1 KOL or Smart holder
  const tokens = await db
    .select({
      id:               tracked_tokens.id,
      address:          tracked_tokens.address,
      chain:            tracked_tokens.chain,
      name:             tracked_tokens.name,
      symbol:           tracked_tokens.symbol,
      intelligenceScore: tracked_tokens.intelligenceScore,
      holderKolCount:   tracked_tokens.holderKolCount,
      holderSmartCount: tracked_tokens.holderSmartCount,
      rawMetadata:      tracked_tokens.rawMetadata,
    })
    .from(tracked_tokens)
    .where(
      sql`intelligence_score >= ${MIN_INTEL_SCORE}
          AND (holder_kol_count >= 1 OR holder_smart_count >= 1)
          AND market_cap_usd::numeric >= 5000`,
    );

  const now = Date.now();
  let sent  = 0;

  for (const t of tokens) {
    const lastSent = lastAlerted.get(t.id);
    if (lastSent && now - lastSent < ALERT_COOLDOWN_MS) continue;

    try {
      await sendRunnerAlert(creds, {
        name:             t.name,
        symbol:           t.symbol,
        address:          t.address,
        chain:            t.chain,
        snapshotMc:       snapMcMap.get(t.id) ?? null,
        holderKolCount:   t.holderKolCount,
        holderSmartCount: t.holderSmartCount,
        intelligenceScore: Math.round(t.intelligenceScore ?? 0),
        socials:          extractSocials(t.rawMetadata),
      });
      lastAlerted.set(t.id, now);
      sent++;
      log.info({ tokenId: t.id, symbol: t.symbol, intel: t.intelligenceScore }, "Runner alert sent");
      // Stay within Telegram rate limits
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      log.warn({ err, tokenId: t.id, symbol: t.symbol }, "Failed to send runner alert");
    }
  }

  if (sent > 0) log.info({ sent }, "Caller alerts cycle complete");
}

// ── Start ─────────────────────────────────────────────────────────────────────

export function startCallerAlerts(): void {
  const loop = () => {
    checkAndAlert()
      .catch(err => log.warn({ err }, "Caller alerts check failed"))
      .finally(() => setTimeout(loop, CHECK_INTERVAL_MS));
  };
  // Wait 35s after startup so the intelligence engine completes its first pass
  setTimeout(loop, 35_000);
  log.info(
    `Caller alerts ready (5 min cycle, ${ALERT_COOLDOWN_MS / 3_600_000}h cooldown per token, min intel ${MIN_INTEL_SCORE})`,
  );
}
