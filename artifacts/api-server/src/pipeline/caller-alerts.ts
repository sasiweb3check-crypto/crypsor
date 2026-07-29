/**
 * Caller Alerts
 *
 * Scope: the same "called" pool used by the Caller UI — intelligenceScore >= 90
 * AND (holderKolCount >= 1 OR holderSmartCount >= 1) AND market cap at call >= $5,000.
 *
 * Two independent, DB-persisted (restart-safe) alert types — neither fires on
 * raw score thresholds:
 *
 *   1. Signal-change alert — fires only when the token's postmortem label
 *      (GOOD_SETUP / SURPRISE_SIGNAL / DUMP_WARNING, derived from
 *      compositeFactors — see lib/postmortem.ts) differs from the label the
 *      token was LAST alerted for. Persisted in `lastAlertedLabel`, so once a
 *      label has been alerted it is never resent until it actually changes to
 *      a different one — including across server restarts. NONE never alerts
 *      and never overwrites the last-alerted label (so a brief dip to NONE
 *      and back doesn't cause a re-send of the same label).
 *
 *   2. Achievement alert — fires when the token's call→ATH multiple crosses a
 *      new milestone tier (2X/3X/5X/10X). Persisted in `athAlertMultiple`
 *      (the highest tier already alerted), so each tier fires exactly once.
 *
 * Cycle: every 5 minutes, right after the intelligence engine's own 5-minute
 * pass — so a label/tier that just changed is picked up on this loop's next
 * tick rather than firing mid-computation.
 */

import { db } from "@workspace/db";
import { tracked_tokens, settings } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { extractSocials, type Socials } from "../lib/socials";
import { derivePostmortemLabel, POSTMORTEM_META, ACHIEVEMENT_TIERS, type PostmortemLabel } from "../lib/postmortem";

const log = logger.child({ module: "caller-alerts" });

const CHECK_INTERVAL_MS = 5 * 60 * 1_000; // every 5 minutes
const MIN_INTEL_SCORE   = 90;

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

interface CallerToken {
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
}

async function sendTelegram(creds: { botToken: string; chatId: string }, text: string): Promise<void> {
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

function buildSignalMessage(t: CallerToken, calledMc: string | null, label: PostmortemLabel): string {
  const icon = { GOOD_SETUP: "🟢", SURPRISE_SIGNAL: "🟡", DUMP_WARNING: "🔴", NONE: "⚪" }[label];
  const meta = POSTMORTEM_META[label];
  const name   = esc(t.name   ?? "Unknown");
  const symbol = esc(t.symbol ?? "?");

  const lines = [
    `${icon} *${name}* \\(${symbol}\\) → *${esc(meta.label)}*`,
    esc(meta.description),
    ``,
    `Intel: *${Math.round(t.intelligenceScore ?? 0)}* · KOL: ${t.holderKolCount} · Smart: ${t.holderSmartCount}`,
    `MC at call: *${esc(fmtMc(calledMc))}*`,
    ``,
    `\`${t.address}\``,
    ``,
    `🔗 [View on GMGN](${gmgnLink(t.chain, t.address)})`,
    ...(() => { const s = socialLines(extractSocials(t.rawMetadata)); return s.length ? [``, ...s] : []; })(),
  ];
  return lines.join("\n");
}

function buildAchievementMessage(t: CallerToken, calledMc: string | null, tier: number): string {
  const name   = esc(t.name   ?? "Unknown");
  const symbol = esc(t.symbol ?? "?");
  const athMc = calledMc ? parseFloat(calledMc) * tier : null;

  const lines = [
    `🏆 *${name}* \\(${symbol}\\) hit *${tier}X* from call\\!`,
    ``,
    `Called at: *${esc(fmtMc(calledMc))}* → ATH: *${esc(fmtMc(athMc))}*`,
    `Intel: *${Math.round(t.intelligenceScore ?? 0)}* · KOL: ${t.holderKolCount} · Smart: ${t.holderSmartCount}`,
    ``,
    `\`${t.address}\``,
    ``,
    `🔗 [View on GMGN](${gmgnLink(t.chain, t.address)})`,
    ...(() => { const s = socialLines(extractSocials(t.rawMetadata)); return s.length ? [``, ...s] : []; })(),
  ];
  return lines.join("\n");
}

// ── Main check ────────────────────────────────────────────────────────────────

async function checkAndAlert(): Promise<void> {
  const creds = await getTelegramCreds();
  if (!creds) {
    log.debug("Telegram not configured — skipping");
    return;
  }

  // "Called at" MC = MC from the FIRST qualifying intel-log snapshot (matches
  // the Caller UI's "called MC", not the latest/live snapshot).
  const calledMcRows = await db.execute(sql`
    SELECT DISTINCT ON (token_id)
      token_id,
      market_cap_usd AS called_mc
    FROM token_intel_log
    WHERE intelligence_score >= ${MIN_INTEL_SCORE}
      AND (holder_kol_count >= 1 OR holder_smart_count >= 1)
      AND market_cap_usd::numeric >= 5000
    ORDER BY token_id, computed_at ASC
  `);
  const calledMcMap = new Map<number, string | null>();
  for (const r of calledMcRows.rows as { token_id: number; called_mc: string | null }[]) {
    calledMcMap.set(r.token_id, r.called_mc);
  }

  const tokens = await db
    .select({
      id:                tracked_tokens.id,
      address:           tracked_tokens.address,
      chain:             tracked_tokens.chain,
      name:              tracked_tokens.name,
      symbol:            tracked_tokens.symbol,
      intelligenceScore: tracked_tokens.intelligenceScore,
      holderKolCount:    tracked_tokens.holderKolCount,
      holderSmartCount:  tracked_tokens.holderSmartCount,
      athGainPct:        tracked_tokens.athGainPct,
      compositeFactors:  tracked_tokens.compositeFactors,
      lastAlertedLabel:  tracked_tokens.lastAlertedLabel,
      athAlertMultiple:  tracked_tokens.athAlertMultiple,
      rawMetadata:       tracked_tokens.rawMetadata,
    })
    .from(tracked_tokens)
    .where(
      sql`intelligence_score >= ${MIN_INTEL_SCORE}
          AND (holder_kol_count >= 1 OR holder_smart_count >= 1)
          AND market_cap_usd::numeric >= 5000`,
    );

  let signalSent = 0;
  let achievementSent = 0;

  for (const t of tokens) {
    const calledMc = calledMcMap.get(t.id) ?? null;

    // ── 1. Signal (postmortem label) transition ──────────────────────────────
    const currentLabel = derivePostmortemLabel(t.compositeFactors);
    if (currentLabel !== "NONE" && currentLabel !== t.lastAlertedLabel) {
      try {
        await sendTelegram(creds, buildSignalMessage(t, calledMc, currentLabel));
        await db.update(tracked_tokens)
          .set({ lastAlertedLabel: currentLabel, lastAlertedAt: new Date() })
          .where(eq(tracked_tokens.id, t.id));
        signalSent++;
        log.info({ tokenId: t.id, symbol: t.symbol, from: t.lastAlertedLabel, to: currentLabel }, "Signal alert sent");
        await new Promise(r => setTimeout(r, 300)); // stay within Telegram rate limits
      } catch (err) {
        log.warn({ err, tokenId: t.id, symbol: t.symbol }, "Failed to send signal alert");
      }
    }

    // ── 2. Achievement (ATH multiple) milestone ──────────────────────────────
    const athX = (t.athGainPct ?? 0) / 100 + 1;
    const nextTier = [...ACHIEVEMENT_TIERS]
      .filter(tier => tier > (t.athAlertMultiple ?? 0) && athX >= tier)
      .sort((a, b) => b - a)[0]; // highest newly-crossed tier
    if (nextTier) {
      try {
        await sendTelegram(creds, buildAchievementMessage(t, calledMc, nextTier));
        await db.update(tracked_tokens)
          .set({ athAlertMultiple: nextTier })
          .where(eq(tracked_tokens.id, t.id));
        achievementSent++;
        log.info({ tokenId: t.id, symbol: t.symbol, tier: nextTier }, "Achievement alert sent");
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        log.warn({ err, tokenId: t.id, symbol: t.symbol }, "Failed to send achievement alert");
      }
    }
  }

  if (signalSent > 0 || achievementSent > 0) {
    log.info({ signalSent, achievementSent }, "Caller alerts cycle complete");
  }
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
    `Caller alerts ready (5 min cycle, label-transition + achievement alerts, min intel ${MIN_INTEL_SCORE})`,
  );
}
