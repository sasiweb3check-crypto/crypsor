/**
 * Caller Alerts Service
 *
 * After every intelligence-engine cycle, scores all tracked tokens using
 * calculateRunnerPotential (same logic as GET /api/caller/tokens).
 * Tokens that newly cross the score >= 50 threshold get a Telegram alert.
 *
 * Deduplication: in-memory Map<tokenId, sentAt ms> with a 6-hour cooldown.
 * On server restart every qualifying token will fire once — intentional,
 * since the pipeline may have been down for hours.
 */

import { db } from "@workspace/db";
import { tracked_tokens, token_intel_log, settings } from "@workspace/db";
import { isNotNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const log = logger.child({ module: "caller-alerts" });

// ── Constants ─────────────────────────────────────────────────────────────────

const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1_000; // 6 hours per token
const CHECK_INTERVAL_MS = 5 * 60 * 1_000;       // run every 5 minutes
const MIN_RUNNER_SCORE  = 50;                    // mirrors caller route filter

// ── Dedup state ───────────────────────────────────────────────────────────────

const lastAlerted = new Map<number, number>(); // tokenId → Date.now() of last alert

// ── Runner scoring (mirrors caller.ts calculateRunnerPotential) ───────────────

interface TokenSignals {
  intelligenceScore:   number;
  kolSmartScore:       number;
  holderVelocityScore: number;
  marketCapUsd:        number;
  athGainPct:          number | null;
  gainPct:             number | null;
  top10Pct:            number | null; // 0-1 fraction
  snapshotCount:       number;
}

type SignalKey = "intel_score" | "kol_smart" | "holder_velocity" | "low_mc" | "ath_gap" | "distributed";

function calculateRunnerPotential(
  t: TokenSignals,
  useAgeBased = true,
): { score: number; signals: SignalKey[] } {
  let score = 0;
  const signals: SignalKey[] = [];

  if (t.intelligenceScore > 75)   { score += 38; signals.push("intel_score"); }
  if (t.kolSmartScore > 45)        { score += 32; signals.push("kol_smart"); }
  if (t.holderVelocityScore > 75)  { score += 22; signals.push("holder_velocity"); }
  if (t.marketCapUsd >= 5_000 && t.marketCapUsd <= 500_000) {
    score += 18; signals.push("low_mc");
  }

  if (useAgeBased && t.snapshotCount >= 3) {
    const athGap = (t.athGainPct ?? 0) - (t.gainPct ?? 0);
    if (athGap > 120)                                      { score += 15; signals.push("ath_gap"); }
    if (t.top10Pct !== null && t.top10Pct < 0.68)          { score += 12; signals.push("distributed"); }
  }

  return { score: Math.min(100, score), signals };
}

// ── Signal labels for the Telegram message ────────────────────────────────────

const SIGNAL_LABEL: Record<SignalKey, string> = {
  intel_score:    "Intel >75",
  kol_smart:      "KOL/Smart >45",
  holder_velocity:"Velocity >75",
  low_mc:         "MC $5K–$500K",
  ath_gap:        "ATH Gap >120%",
  distributed:    "Top10 <68%",
};

// ── Telegram helper ───────────────────────────────────────────────────────────

async function getTelegramCreds(): Promise<{ botToken: string; chatId: string } | null> {
  try {
    const rows = await db.select({ key: settings.key, value: settings.value })
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

// Escape characters that MarkdownV2 treats as special
function escMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

function formatMc(usd: number | null): string {
  if (!usd) return "—";
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000)     return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

async function sendTelegramAlert(
  creds: { botToken: string; chatId: string },
  token: {
    name: string | null; symbol: string | null; address: string; chain: string;
    score: number; signals: SignalKey[];
    marketCapUsd: number | null; calledAtMcUsd: number | null;
    holderKolCount: number | null; holderSmartCount: number | null;
    gainPct: number | null; intelligenceScore: number;
  },
): Promise<void> {
  const name   = escMd(token.name   ?? "Unknown");
  const symbol = escMd(token.symbol ?? "?");
  const score  = token.score;

  const tierEmoji = score >= 90 ? "🔥" : score >= 70 ? "🚀" : "👀";
  const signalLine = token.signals.map(s => SIGNAL_LABEL[s]).join(" · ");

  const mcCalled = formatMc(token.calledAtMcUsd);
  const mcNow    = formatMc(token.marketCapUsd);
  const gainStr  = token.gainPct != null
    ? (token.gainPct >= 0 ? `\\+${token.gainPct.toFixed(1)}x` : `${token.gainPct.toFixed(1)}x`)
    : "—";

  const kolCount   = token.holderKolCount   ?? 0;
  const smartCount = token.holderSmartCount ?? 0;

  const gmgnLink = token.chain === "solana"
    ? `https://gmgn\\.ai/sol/token/${escMd(token.address)}`
    : `https://dexscreener\\.com/${escMd(token.chain)}/${escMd(token.address)}`;

  const text = [
    `${tierEmoji} *Runner Alert* — ${name} \\(${symbol}\\)`,
    ``,
    `Score: *${score}/100*`,
    `Signals: ${escMd(signalLine)}`,
    ``,
    `MC called: ${escMd(mcCalled)} → now: ${escMd(mcNow)}`,
    `Gain: ${gainStr} · Intel: ${escMd(String(token.intelligenceScore))}`,
    `KOL: ${kolCount} · Smart: ${smartCount}`,
    ``,
    `🔗 [View on ${token.chain === "solana" ? "GMGN" : "DexScreener"}](${gmgnLink})`,
  ].join("\n");

  const resp = await fetch(
    `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    creds.chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
    },
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Telegram ${resp.status}: ${body.slice(0, 200)}`);
  }
}

// ── Main check ────────────────────────────────────────────────────────────────

async function checkAndAlertRunners(): Promise<void> {
  const creds = await getTelegramCreds();
  if (!creds) {
    log.debug("Telegram not configured — skipping alert check");
    return;
  }

  // Snapshot counts
  const snapRows = await db.execute(sql`
    SELECT token_id, COUNT(*)::int AS cnt
    FROM token_intel_log
    GROUP BY token_id
  `);
  const snapMap = new Map<number, number>();
  for (const r of snapRows.rows as { token_id: number; cnt: number }[]) {
    snapMap.set(r.token_id, r.cnt);
  }

  // Called-at MC from first intel log entry
  const firstMcRows = await db.execute(sql`
    SELECT DISTINCT ON (token_id) token_id, market_cap_usd AS called_mc
    FROM token_intel_log
    ORDER BY token_id, computed_at ASC
  `);
  const calledMcMap = new Map<number, number>();
  for (const r of firstMcRows.rows as { token_id: number; called_mc: string | null }[]) {
    if (r.called_mc) calledMcMap.set(r.token_id, parseFloat(r.called_mc));
  }

  const tokens = await db
    .select({
      id:                  tracked_tokens.id,
      address:             tracked_tokens.address,
      chain:               tracked_tokens.chain,
      name:                tracked_tokens.name,
      symbol:              tracked_tokens.symbol,
      marketCapUsd:        tracked_tokens.marketCapUsd,
      gainPct:             tracked_tokens.gainPct,
      athGainPct:          tracked_tokens.athGainPct,
      holderKolCount:      tracked_tokens.holderKolCount,
      holderSmartCount:    tracked_tokens.holderSmartCount,
      holderTop10Pct:      tracked_tokens.holderTop10Pct,
      intelligenceScore:   tracked_tokens.intelligenceScore,
      kolSmartScore:       tracked_tokens.kolSmartScore,
      holderVelocityScore: tracked_tokens.holderVelocityScore,
      secTop10HolderRate:  tracked_tokens.secTop10HolderRate,
    })
    .from(tracked_tokens)
    .where(isNotNull(tracked_tokens.intelligenceScore));

  const now  = Date.now();
  let alerts = 0;

  for (const t of tokens) {
    const lastSent = lastAlerted.get(t.id);
    if (lastSent && now - lastSent < ALERT_COOLDOWN_MS) continue; // cooldown active

    const mcUsd = parseFloat(t.marketCapUsd ?? "0") || 0;
    const top10Pct = t.secTop10HolderRate != null
      ? t.secTop10HolderRate
      : t.holderTop10Pct > 0 ? t.holderTop10Pct / 100 : null;

    const { score, signals } = calculateRunnerPotential(
      {
        intelligenceScore:   t.intelligenceScore ?? 0,
        kolSmartScore:       t.kolSmartScore      ?? 0,
        holderVelocityScore: t.holderVelocityScore ?? 0,
        marketCapUsd:        mcUsd,
        athGainPct:          t.athGainPct,
        gainPct:             t.gainPct,
        top10Pct,
        snapshotCount:       snapMap.get(t.id) ?? 0,
      },
      true, // always include age-based signals in alerts
    );

    if (score < MIN_RUNNER_SCORE) continue;

    try {
      await sendTelegramAlert(creds, {
        name:             t.name,
        symbol:           t.symbol,
        address:          t.address,
        chain:            t.chain,
        score,
        signals,
        marketCapUsd:     mcUsd || null,
        calledAtMcUsd:    calledMcMap.get(t.id) ?? null,
        holderKolCount:   t.holderKolCount,
        holderSmartCount: t.holderSmartCount,
        gainPct:          t.gainPct,
        intelligenceScore: t.intelligenceScore ?? 0,
      });

      lastAlerted.set(t.id, now);
      alerts++;
      log.info({ tokenId: t.id, symbol: t.symbol, score }, "Runner alert sent");

      // Rate-limit: 1 message per 300ms to stay within Telegram API limits
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      log.warn({ err, tokenId: t.id }, "Failed to send runner alert");
    }
  }

  if (alerts > 0) {
    log.info({ alerts }, "Caller alerts cycle complete");
  }
}

// ── Public start function ─────────────────────────────────────────────────────

export function startCallerAlerts(): void {
  // First run: wait 35 seconds after startup so the intelligence engine
  // completes its first cycle before we score tokens.
  const loop = () => {
    checkAndAlertRunners()
      .catch(err => log.warn({ err }, "Caller alerts check failed"))
      .finally(() => setTimeout(loop, CHECK_INTERVAL_MS));
  };

  setTimeout(loop, 35_000);
  log.info(
    `Caller alerts ready (5 min cycle, ${ALERT_COOLDOWN_MS / 3600_000}h cooldown per token, min score ${MIN_RUNNER_SCORE})`,
  );
}
