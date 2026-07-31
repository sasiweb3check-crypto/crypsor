/**
 * Caller Alerts
 *
 * Two alert types — no signal/postmortem label alerts at all:
 *
 *   1. New Call alert — fires exactly ONCE when a token first enters pro_calls
 *      with quality_label = 'very_good'.  Persisted via lastAlertedLabel =
 *      '__NEW_CALL__'.  Label changes after this point are ignored — no
 *      duplicate call alerts, ever.
 *
 *   2. Milestone alert — fires once each at 2×, 5×, 10× ATH from called MC,
 *      for any quality token (very_good + good).  Persisted in
 *      athAlertMultiple — each tier fires exactly once, ever.
 *
 * Cycle: every 5 minutes, 35 s after startup.
 */

import { db } from "@workspace/db";
import { tracked_tokens, settings } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { extractSocials, type Socials } from "../lib/socials";

const log = logger.child({ module: "caller-alerts" });

const CHECK_INTERVAL_MS = 60_000; // was 5 min — align with on-time Pro path

// Only 2×, 5×, 10× — no 3× noise
const ALERT_MILESTONES = [2, 5, 10] as const;

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
  lastAlertedLabel: string | null;
  athAlertMultiple: number;
  rawMetadata: unknown;
  // from pro_calls
  calledAt: string;
  calledMcUsd: string | null;
  calledIntelScore: number | null;
  calledKolCount: number;
  calledSmartCount: number;
  athMultiple: number | null;
  proScore: number;
  qualityLabel: string;
}

// ── Message builders ──────────────────────────────────────────────────────────

function buildNewCallMessage(t: QualityToken): string {
  const name   = esc(t.name   ?? "Unknown");
  const symbol = esc(t.symbol ?? "?");

  const lines = [
    `⭐ *${name}* \\(${symbol}\\) — *New Pro Call*`,
    ``,
    `Very Good · Score: *${Math.round(t.proScore)}*`,
    `Intel: *${Math.round(t.calledIntelScore ?? t.intelligenceScore ?? 0)}* · KOL: ${t.calledKolCount} · Smart: ${t.calledSmartCount}`,
    `Called MC: *${esc(fmtMc(t.calledMcUsd))}*`,
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

function buildMilestoneMessage(t: QualityToken, tier: number): string {
  const name   = esc(t.name   ?? "Unknown");
  const symbol = esc(t.symbol ?? "?");
  const athMc  = t.calledMcUsd ? parseFloat(t.calledMcUsd) * tier : null;

  const tierEmoji: Record<number, string> = { 2: "🔥", 5: "🚀", 10: "💎" };
  const emoji = tierEmoji[tier] ?? "🏆";

  const lines = [
    `${emoji} *${name}* \\(${symbol}\\) hit *${tier}×* from call\\!`,
    ``,
    `Called: *${esc(fmtMc(t.calledMcUsd))}* → ATH est\\.: *${esc(fmtMc(athMc))}*`,
    `Intel: *${Math.round(t.calledIntelScore ?? t.intelligenceScore ?? 0)}* · KOL: ${t.calledKolCount} · Smart: ${t.calledSmartCount}`,
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

  // Fetch quality tokens with their pro_calls data.
  // ath_multiple is relative to called_mc_usd (correct base for milestone detection).
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
      t.last_alerted_label    AS "lastAlertedLabel",
      t.ath_alert_multiple    AS "athAlertMultiple",
      t.raw_metadata          AS "rawMetadata",
      pc.called_at            AS "calledAt",
      pc.called_mc_usd        AS "calledMcUsd",
      pc.called_intel_score   AS "calledIntelScore",
      pc.called_kol_count     AS "calledKolCount",
      pc.called_smart_count   AS "calledSmartCount",
      pc.ath_multiple         AS "athMultiple",
      pc.pro_score            AS "proScore",
      pc.quality_label        AS "qualityLabel"
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    WHERE pc.quality_label IN ('very_good', 'good')
  `);

  const tokens = rows.rows as QualityToken[];

  let newCallSent   = 0;
  let milestoneSent = 0;

  for (const t of tokens) {
    // ── Alert 1: New Call — very_good only, fires exactly once ──────────────
    // lastAlertedLabel = null  → call alert not yet sent → fire now (very_good only)
    // lastAlertedLabel = any   → already sent → skip entirely (no label-change alerts)
    if (t.lastAlertedLabel === null && t.qualityLabel === "very_good") {
      try {
        await sendTelegram(creds, buildNewCallMessage(t));
        await db.update(tracked_tokens)
          .set({ lastAlertedLabel: "__NEW_CALL__", lastAlertedAt: new Date() })
          .where(eq(tracked_tokens.id, t.id));
        newCallSent++;
        log.info(
          { tokenId: t.id, symbol: t.symbol, proScore: t.proScore },
          "New pro call alert sent",
        );
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        log.warn({ err, tokenId: t.id, symbol: t.symbol }, "Failed to send new call alert");
      }
      // Skip milestone check this cycle — handle next cycle
      continue;
    }

    // If call alert never sent for a 'good' token (or still null), mark sentinel
    // silently so it doesn't keep re-evaluating and never sends a 'good' call alert.
    if (t.lastAlertedLabel === null && t.qualityLabel === "good") {
      await db.update(tracked_tokens)
        .set({ lastAlertedLabel: "__NEW_CALL__" })
        .where(eq(tracked_tokens.id, t.id))
        .catch(() => {});
      // Still process milestones below
    }

    // ── Alert 2: Milestones — 2×, 5×, 10×, fires once per tier ─────────────
    const athX     = t.athMultiple ?? 1;
    const nextTier = [...ALERT_MILESTONES]
      .filter(tier => tier > (t.athAlertMultiple ?? 0) && athX >= tier)
      .sort((a, b) => b - a)[0];

    if (nextTier) {
      try {
        await sendTelegram(creds, buildMilestoneMessage(t, nextTier));
        await db.update(tracked_tokens)
          .set({ athAlertMultiple: nextTier })
          .where(eq(tracked_tokens.id, t.id));
        milestoneSent++;
        log.info(
          { tokenId: t.id, symbol: t.symbol, tier: nextTier, athX },
          "Milestone alert sent",
        );
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        log.warn({ err, tokenId: t.id, symbol: t.symbol }, "Failed to send milestone alert");
      }
    }
  }

  if (newCallSent > 0 || milestoneSent > 0) {
    log.info({ newCallSent, milestoneSent }, "Alerts cycle complete");
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
  log.info("Caller alerts ready (5 min cycle · very_good new calls + 2×/5×/10× milestones)");
}
