/**
 * Caller Alerts — Quality-gated
 *
 * Only tokens in the pro_calls pool with quality_label IN ('very_good', 'good')
 * (Pro Score ≥ 55) receive alerts.  All other tokens are silenced.
 *
 * Two independent, DB-persisted (restart-safe) alert types:
 *
 *   1. Signal-change alert — fires when the postmortem label (GOOD_SETUP /
 *      SURPRISE_SIGNAL / DUMP_WARNING) differs from the last-alerted label.
 *      Persisted in `lastAlertedLabel` — never re-fires the same label.
 *
 *   2. Achievement alert — fires once per milestone tier (2×/3×/5×/10×)
 *      when the token's ATH multiple crosses it.  Persisted in
 *      `athAlertMultiple` — each tier fires exactly once, ever.
 *
 * Cycle: every 5 minutes, 35 s after startup.
 */

import { db } from "@workspace/db";
import { tracked_tokens, settings } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { extractSocials, type Socials } from "../lib/socials";
import {
  derivePostmortemLabel, POSTMORTEM_META,
  ACHIEVEMENT_TIERS, type PostmortemLabel,
} from "../lib/postmortem";

const log = logger.child({ module: "caller-alerts" });

const CHECK_INTERVAL_MS = 5 * 60 * 1_000;

// ── Telegram helpers ──────────────────────────────────────────────────────────

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
  } catch { return null; }
}

async function sendTelegram(
  creds: { botToken: string; chatId: string },
  text: string,
): Promise<void> {
  const resp = await fetch(`https://api.telegram.org/bot${creds.botToken}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id:    creds.chatId,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: false,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Telegram ${resp.status}: ${body.slice(0, 300)}`);
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtMc(usd: string | number | null | undefined): string {
  const n = typeof usd === "string" ? parseFloat(usd) : (usd ?? 0);
  if (!n || !isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function esc(s: string): string {
  return s.replace(/[_*[\]()~`>#+=|{}.!\-\\]/g, "\\$&");
}

function gmgnLink(chain: string, address: string): string {
  return chain === "solana"
    ? `https://gmgn\\.ai/sol/token/${address}`
    : `https://dexscreener\\.com/${esc(chain)}/${address}`;
}

function socialLines(socials: Socials): string[] {
  const lines: string[] = [];
  if (socials.twitter)  lines.push(`🐦 [Twitter](${socials.twitter})`);
  if (socials.telegram) lines.push(`✈️ [Telegram](${socials.telegram})`);
  if (socials.website)  lines.push(`🌐 [Website](${socials.website})`);
  return lines;
}

function qualityBadge(label: string, score: number): string {
  if (label === "very_good") return `⭐ Very Good \\(${Math.round(score)}\\)`;
  return `✅ Good \\(${Math.round(score)}\\)`;
}

// ── Token type ────────────────────────────────────────────────────────────────

interface QualityToken {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  intelligenceScore: number | null;
  holderKolCount: number;
  holderSmartCount: number;
  athGainPct: number | null;
  compositeFactors: string[] | null;
  lastAlertedLabel: string | null;
  athAlertMultiple: number;
  rawMetadata: unknown;
  // from pro_calls
  calledMcUsd: string | null;
  proScore: number;
  qualityLabel: string;
}

// ── Message builders ──────────────────────────────────────────────────────────

function buildSignalMessage(
  t: QualityToken,
  label: PostmortemLabel,
): string {
  const icon = { GOOD_SETUP: "🟢", SURPRISE_SIGNAL: "🟡", DUMP_WARNING: "🔴", NONE: "⚪" }[label];
  const meta   = POSTMORTEM_META[label];
  const name   = esc(t.name   ?? "Unknown");
  const symbol = esc(t.symbol ?? "?");

  const lines = [
    `${icon} *${name}* \\(${symbol}\\) → *${esc(meta.label)}*`,
    esc(meta.description),
    ``,
    `${qualityBadge(t.qualityLabel, t.proScore)} · Intel: *${Math.round(t.intelligenceScore ?? 0)}*`,
    `KOL: ${t.holderKolCount} · Smart: ${t.holderSmartCount}`,
    `MC at call: *${esc(fmtMc(t.calledMcUsd))}*`,
    ``,
    `\`${t.address}\``,
    ``,
    `🔗 [View on GMGN](${gmgnLink(t.chain, t.address)})`,
    ...(() => {
      const s = socialLines(extractSocials(t.rawMetadata));
      return s.length ? ["", ...s] : [];
    })(),
  ];
  return lines.join("\n");
}

function buildAchievementMessage(
  t: QualityToken,
  tier: number,
): string {
  const name   = esc(t.name   ?? "Unknown");
  const symbol = esc(t.symbol ?? "?");
  const athMc  = t.calledMcUsd ? parseFloat(t.calledMcUsd) * tier : null;

  const lines = [
    `🏆 *${name}* \\(${symbol}\\) hit *${tier}×* from call\\!`,
    ``,
    `${qualityBadge(t.qualityLabel, t.proScore)}`,
    `Called at: *${esc(fmtMc(t.calledMcUsd))}* → ATH est\\.: *${esc(fmtMc(athMc))}*`,
    `Intel: *${Math.round(t.intelligenceScore ?? 0)}* · KOL: ${t.holderKolCount} · Smart: ${t.holderSmartCount}`,
    ``,
    `\`${t.address}\``,
    ``,
    `🔗 [View on GMGN](${gmgnLink(t.chain, t.address)})`,
    ...(() => {
      const s = socialLines(extractSocials(t.rawMetadata));
      return s.length ? ["", ...s] : [];
    })(),
  ];
  return lines.join("\n");
}

// ── Main check loop ───────────────────────────────────────────────────────────

async function checkAndAlert(): Promise<void> {
  const creds = await getTelegramCreds();
  if (!creds) {
    log.debug("Telegram not configured — skipping");
    return;
  }

  // Fetch quality tokens (Very Good + Good) with their pro_calls data
  const rows = await db.execute(sql`
    SELECT
      t.id,
      t.address,
      t.chain,
      t.name,
      t.symbol,
      t.intelligence_score    AS "intelligenceScore",
      t.holder_kol_count      AS "holderKolCount",
      t.holder_smart_count    AS "holderSmartCount",
      t.ath_gain_pct          AS "athGainPct",
      t.composite_factors     AS "compositeFactors",
      t.last_alerted_label    AS "lastAlertedLabel",
      t.ath_alert_multiple    AS "athAlertMultiple",
      t.raw_metadata          AS "rawMetadata",
      pc.called_mc_usd        AS "calledMcUsd",
      pc.pro_score            AS "proScore",
      pc.quality_label        AS "qualityLabel"
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    WHERE pc.quality_label IN ('very_good', 'good')
  `);

  const tokens = rows.rows as QualityToken[];

  let signalSent = 0;
  let achievementSent = 0;

  for (const t of tokens) {
    // ── 1. Signal (postmortem label) transition ──────────────────────────────
    const currentLabel = derivePostmortemLabel(t.compositeFactors);
    if (currentLabel !== "NONE" && currentLabel !== t.lastAlertedLabel) {
      try {
        await sendTelegram(creds, buildSignalMessage(t, currentLabel));
        await db.update(tracked_tokens)
          .set({ lastAlertedLabel: currentLabel, lastAlertedAt: new Date() })
          .where(eq(tracked_tokens.id, t.id));
        signalSent++;
        log.info(
          { tokenId: t.id, symbol: t.symbol, from: t.lastAlertedLabel, to: currentLabel, proScore: t.proScore },
          "Quality signal alert sent",
        );
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        log.warn({ err, tokenId: t.id, symbol: t.symbol }, "Failed to send signal alert");
      }
    }

    // ── 2. Achievement (ATH ×) milestone ────────────────────────────────────
    const athX     = (t.athGainPct ?? 0) / 100 + 1;
    const nextTier = [...ACHIEVEMENT_TIERS]
      .filter(tier => tier > (t.athAlertMultiple ?? 0) && athX >= tier)
      .sort((a, b) => b - a)[0];
    if (nextTier) {
      try {
        await sendTelegram(creds, buildAchievementMessage(t, nextTier));
        await db.update(tracked_tokens)
          .set({ athAlertMultiple: nextTier })
          .where(eq(tracked_tokens.id, t.id));
        achievementSent++;
        log.info(
          { tokenId: t.id, symbol: t.symbol, tier: nextTier, proScore: t.proScore },
          "Quality achievement alert sent",
        );
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        log.warn({ err, tokenId: t.id, symbol: t.symbol }, "Failed to send achievement alert");
      }
    }
  }

  if (signalSent > 0 || achievementSent > 0) {
    log.info({ signalSent, achievementSent }, "Quality alerts cycle complete");
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

export function startCallerAlerts(): void {
  const loop = () => {
    checkAndAlert()
      .catch(err => log.warn({ err }, "Caller alerts check failed"))
      .finally(() => setTimeout(loop, CHECK_INTERVAL_MS));
  };
  setTimeout(loop, 35_000);
  log.info("Caller alerts ready (5 min cycle · quality-gated: very_good + good only)");
}
