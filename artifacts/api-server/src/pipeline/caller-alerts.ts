/**
 * Pro Caller Alerts — rebuilt from scratch
 *
 * 1. First Call alert — once when a token enters Pro (good | very_good) and is
 *    scored. Stored on pro_calls.call_alert_sent_at (never on tracked_tokens).
 *
 * 2. Milestone alerts — each of 2× / 5× / 10× / 20× from called_mc fires once.
 *    Stored in pro_calls.milestone_alerts_sent ("2,5,10"). Every crossed tier
 *    is sent (not only the highest jump).
 *
 * Trader payload: entry MC, now MC, gain, ATH, KOL/smart @ call + now, HV,
 * survival, Pro score, CA, GMGN, socials.
 */

import { db } from "@workspace/db";
import { settings } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { extractSocials, type Socials } from "../lib/socials";
import { opsLog } from "../lib/ops-log";
import { healthMonitor } from "./health-monitor";

const log = logger.child({ module: "caller-alerts" });

const CHECK_INTERVAL_MS = 30_000;
const STARTUP_DELAY_MS = 20_000;
const ALERT_MILESTONES = [2, 5, 10, 20] as const;

async function getTelegramCreds(): Promise<{ botToken: string; chatId: string } | null> {
  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(sql`key IN ('telegram_bot_token', 'telegram_chat_id')`);
    const botToken = rows.find(r => r.key === "telegram_bot_token")?.value?.trim() ?? "";
    const chatId = rows.find(r => r.key === "telegram_chat_id")?.value?.trim() ?? "";
    if (!botToken || !chatId) return null;
    return { botToken, chatId };
  } catch {
    return null;
  }
}

async function sendTelegram(
  creds: { botToken: string; chatId: string },
  text: string,
  attempt = 0,
): Promise<void> {
  const chat_id = /^-?\d+$/.test(creds.chatId) ? Number(creds.chatId) : creds.chatId;
  const url = `https://api.telegram.org/bot${creds.botToken}/sendMessage`;
  const MAX_ATTEMPTS = 3;
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
      // MarkdownV2 is brittle — retry as plain text so alerts still deliver
      const plain = text.replace(/\\([_*[\]()~`>#+=|{}.!\-\\])/g, "$1");
      resp = await doFetch({ chat_id, text: plain, disable_web_page_preview: true });
    }
    const latencyMs = Date.now() - t0;
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const err = `Telegram ${resp.status}: ${body.slice(0, 300)}`;
      opsLog("telegram", "error", err, { latencyMs, attempt }, latencyMs);
      healthMonitor.error("caller-alerts", err);
      throw new Error(err);
    }
    opsLog("telegram", "info", "Telegram send OK", { attempt }, latencyMs);
    healthMonitor.ok("caller-alerts", latencyMs);
  } catch (err) {
    const cause = err instanceof Error && "cause" in err && err.cause
      ? String((err as Error & { cause?: unknown }).cause)
      : "";
    const msg = err instanceof Error ? err.message : String(err);
    const transient =
      msg.includes("fetch failed") ||
      msg.includes("Abort") ||
      msg.includes("abort") ||
      msg.includes("ECONN") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("socket") ||
      cause.includes("ECONN") ||
      cause.includes("UND_ERR");
    if (transient && attempt < MAX_ATTEMPTS - 1) {
      const delay = 800 * (attempt + 1) + Math.floor(Math.random() * 400);
      await new Promise(r => setTimeout(r, delay));
      return sendTelegram(creds, text, attempt + 1);
    }
    const latencyMs = Date.now() - t0;
    const full = cause ? `${msg} (${cause.slice(0, 120)})` : msg;
    opsLog("telegram", "error", full.slice(0, 240), { attempt, latencyMs }, latencyMs);
    healthMonitor.error("caller-alerts", full);
    throw err instanceof Error ? err : new Error(full);
  }
}


function fmtMc(usd: string | number | null | undefined): string {
  const n = typeof usd === "string" ? parseFloat(usd) : (usd ?? 0);
  if (!n || !isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(0)}%`;
}

function esc(s: string): string {
  return s.replace(/[_*[\]()~`>#+=|{}.!\-\\]/g, "\\$&");
}

function gmgnLink(chain: string, address: string): string {
  return chain === "solana" || chain === "sol"
    ? `https://gmgn\\.ai/sol/token/${address}`
    : `https://dexscreener\\.com/${esc(chain)}/${address}`;
}

function socialBlock(socials: Socials): string[] {
  const out: string[] = [];
  if (socials.twitter) out.push(`🐦 ${esc(socials.twitter)}`);
  if (socials.telegram) out.push(`✈️ ${esc(socials.telegram)}`);
  if (socials.website) out.push(`🌐 ${esc(socials.website)}`);
  return out;
}

interface ProAlertToken {
  proCallId: number;
  tokenId: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  rawMetadata: unknown;
  calledAt: string | Date;
  calledMcUsd: string | null;
  calledIntel: number | null;
  calledKol: number;
  calledSmart: number;
  calledHv: number | null;
  athMultiple: number | null;
  proScore: number | null;
  survivalScore: number | null;
  qualityLabel: string;
  entryTier: string | null;
  callAlertSentAt: string | Date | null;
  milestoneAlertsSent: string | null;
  currentMc: string | null;
  liveKol: number;
  liveSmart: number;
  liveIntel: number | null;
  liveHv: number | null;
  liquidityUsd: string | null;
  holderCount: number | null;
  secMint: boolean | null;
  secFreeze: boolean | null;
  secHoneypot: boolean | null;
}

function parseSentTiers(raw: string | null | undefined): Set<number> {
  if (!raw) return new Set();
  return new Set(
    raw.split(",").map(s => parseFloat(s.trim())).filter(n => Number.isFinite(n) && n > 0),
  );
}

function buildFirstCallMessage(t: ProAlertToken): string {
  const name = esc(t.name ?? "Unknown");
  const symbol = esc(t.symbol ?? "?");
  const quality = t.qualityLabel === "very_good" ? "Very Good" : "Good";
  const socials = extractSocials(t.rawMetadata);
  const lines = [
    `⭐ *PRO CALL* — *${name}* \\(${symbol}\\)`,
    ``,
    `${esc(quality)} · Pro *${Math.round(t.proScore ?? 0)}* · Survive *${Math.round(t.survivalScore ?? 0)}*`,
    `Entry MC: *${esc(fmtMc(t.calledMcUsd))}*${t.entryTier ? ` · ${esc(t.entryTier)}` : ""}`,
    `Intel *${Math.round(t.calledIntel ?? 0)}* · HV *${Math.round(t.calledHv ?? 0)}*`,
    `KOL *${t.calledKol}* · Smart *${t.calledSmart}* @ call`,
    t.liquidityUsd ? `Liq: *${esc(fmtMc(t.liquidityUsd))}*` : null,
    t.secHoneypot === true ? `⚠️ Honeypot flag` : null,
    t.secMint === false || t.secFreeze === false
      ? `Auth: mint ${t.secMint === true ? "renounced" : "OPEN"} · freeze ${t.secFreeze === true ? "renounced" : "OPEN"}`
      : null,
    ``,
    `\`${t.address}\``,
    `🔗 [GMGN](${gmgnLink(t.chain, t.address)})`,
    ...(() => {
      const s = socialBlock(socials);
      return s.length ? ["", ...s] : [];
    })(),
  ].filter((x): x is string => x != null);
  return lines.join("\n");
}

function buildMilestoneMessage(t: ProAlertToken, tier: number): string {
  const name = esc(t.name ?? "Unknown");
  const symbol = esc(t.symbol ?? "?");
  const called = parseFloat(t.calledMcUsd ?? "0") || 0;
  const current = parseFloat(t.currentMc ?? "0") || 0;
  const athX = t.athMultiple ?? (called > 0 ? current / called : 1);
  const gain = called > 0 ? ((current - called) / called) * 100 : null;
  const athMc = called > 0 ? called * athX : null;
  const emoji: Record<number, string> = { 2: "🔥", 5: "🚀", 10: "💎", 20: "👑" };
  const socials = extractSocials(t.rawMetadata);
  const kolDelta = t.liveKol - t.calledKol;
  const smartDelta = t.liveSmart - t.calledSmart;

  const lines = [
    `${emoji[tier] ?? "🏆"} *${name}* \\(${symbol}\\) hit *${tier}×*`,
    ``,
    `Entry *${esc(fmtMc(t.calledMcUsd))}* → Now *${esc(fmtMc(t.currentMc))}* \\(${esc(fmtPct(gain))}\\)`,
    `ATH *${esc(athX.toFixed(1))}×* \\(~${esc(fmtMc(athMc))}\\)`,
    `Pro *${Math.round(t.proScore ?? 0)}* · Survive *${Math.round(t.survivalScore ?? 0)}* · HV *${Math.round(t.liveHv ?? t.calledHv ?? 0)}*`,
    `KOL ${t.calledKol}→${t.liveKol}${kolDelta !== 0 ? ` \\(${kolDelta >= 0 ? "+" : ""}${kolDelta}\\)` : ""} · Smart ${t.calledSmart}→${t.liveSmart}${smartDelta !== 0 ? ` \\(${smartDelta >= 0 ? "+" : ""}${smartDelta}\\)` : ""}`,
    ``,
    `\`${t.address}\``,
    `🔗 [GMGN](${gmgnLink(t.chain, t.address)})`,
    ...(() => {
      const s = socialBlock(socials);
      return s.length ? ["", ...s] : [];
    })(),
  ];
  return lines.join("\n");
}

async function checkAndAlert(): Promise<void> {
  const t0 = Date.now();
  const creds = await getTelegramCreds();
  if (!creds) {
    // Log at most once per 10 minutes — avoid flooding the ops ring
    const last = (checkAndAlert as { _lastNoTg?: number })._lastNoTg ?? 0;
    if (Date.now() - last > 600_000) {
      (checkAndAlert as { _lastNoTg?: number })._lastNoTg = Date.now();
      opsLog("blocker", "warn", "Telegram not configured — Pro alerts skipped");
    }
    healthMonitor.ok("caller-alerts");
    return;
  }

  const rows = await db.execute(sql`
    SELECT
      pc.id                    AS "proCallId",
      pc.token_id              AS "tokenId",
      t.address,
      t.chain,
      t.name,
      t.symbol,
      t.raw_metadata           AS "rawMetadata",
      pc.called_at             AS "calledAt",
      pc.called_mc_usd         AS "calledMcUsd",
      pc.called_intel_score    AS "calledIntel",
      COALESCE(pc.called_kol_count, 0)   AS "calledKol",
      COALESCE(pc.called_smart_count, 0) AS "calledSmart",
      pc.called_holder_velocity AS "calledHv",
      pc.ath_multiple          AS "athMultiple",
      pc.pro_score             AS "proScore",
      pc.survival_score        AS "survivalScore",
      pc.quality_label         AS "qualityLabel",
      pc.entry_tier            AS "entryTier",
      pc.call_alert_sent_at    AS "callAlertSentAt",
      pc.milestone_alerts_sent AS "milestoneAlertsSent",
      t.market_cap_usd         AS "currentMc",
      COALESCE(t.holder_kol_count, 0)   AS "liveKol",
      COALESCE(t.holder_smart_count, 0) AS "liveSmart",
      t.intelligence_score     AS "liveIntel",
      t.holder_velocity_score  AS "liveHv",
      t.liquidity_usd          AS "liquidityUsd",
      t.holder_count           AS "holderCount",
      t.sec_mint_renounced     AS "secMint",
      t.sec_freeze_renounced   AS "secFreeze",
      t.sec_is_honeypot        AS "secHoneypot"
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    WHERE pc.quality_label IN ('very_good', 'good')
      AND (
        pc.call_alert_sent_at IS NULL
        OR COALESCE(pc.ath_multiple, 1) >= 2
      )
    ORDER BY
      (pc.call_alert_sent_at IS NULL) DESC,
      pc.called_at DESC
    LIMIT 200
  `);

  const tokens = rows.rows as unknown as ProAlertToken[];
  let firstCallSent = 0;
  let milestoneSent = 0;
  // Cap sends per cycle — backlog of 30+ pending was causing TypeError: fetch failed
  const MAX_SENDS_PER_CYCLE = 8;
  let sends = 0;

  for (const t of tokens) {
    if (sends >= MAX_SENDS_PER_CYCLE) {
      opsLog("telegram", "warn", `Alert cap ${MAX_SENDS_PER_CYCLE}/cycle — ${tokens.length - firstCallSent} remain`);
      break;
    }
    // ── 1. First Pro call alert ────────────────────────────────────────────
    if (!t.callAlertSentAt) {
      try {
        await sendTelegram(creds, buildFirstCallMessage(t));
        await db.execute(sql`
          UPDATE pro_calls
          SET call_alert_sent_at = NOW()
          WHERE id = ${t.proCallId} AND call_alert_sent_at IS NULL
        `);
        firstCallSent++;
        sends++;
        log.info(
          { proCallId: t.proCallId, symbol: t.symbol, quality: t.qualityLabel, proScore: t.proScore },
          "Pro first-call alert sent",
        );
        opsLog("telegram", "info", `First-call alert · ${t.symbol ?? t.address.slice(0, 6)}`, {
          quality: t.qualityLabel,
          proScore: t.proScore,
        });
        await new Promise(r => setTimeout(r, 350));
      } catch (err) {
        log.warn({ err, tokenId: t.tokenId, symbol: t.symbol }, "First-call alert failed");
        opsLog("telegram", "error", `First-call failed · ${t.symbol ?? "?"}: ${String(err).slice(0, 160)}`);
      }
      // Milestones next cycle so first-call stands alone
      continue;
    }

    // ── 2. Milestone alerts — fire every newly crossed tier ────────────────
    const athX = t.athMultiple ?? 1;
    const already = parseSentTiers(t.milestoneAlertsSent);
    const due = ALERT_MILESTONES.filter(tier => athX >= tier && !already.has(tier));

    for (const tier of due) {
      try {
        await sendTelegram(creds, buildMilestoneMessage(t, tier));
        already.add(tier);
        const joined = [...already].sort((a, b) => a - b).join(",");
        await db.execute(sql`
          UPDATE pro_calls
          SET milestone_alerts_sent = ${joined}
          WHERE id = ${t.proCallId}
        `);
        milestoneSent++;
        sends++;
        log.info(
          { proCallId: t.proCallId, symbol: t.symbol, tier, athX },
          "Pro milestone alert sent",
        );
        opsLog("telegram", "info", `Milestone ${tier}× · ${t.symbol ?? "?"}`, { athX });
        if (sends >= MAX_SENDS_PER_CYCLE) break;
        await new Promise(r => setTimeout(r, 350));
      } catch (err) {
        log.warn({ err, tokenId: t.tokenId, symbol: t.symbol, tier }, "Milestone alert failed");
        opsLog("telegram", "error", `Milestone ${tier}× failed · ${t.symbol ?? "?"}: ${String(err).slice(0, 140)}`);
        break; // don't mark further tiers if Telegram is failing
      }
    }
  }

  if (firstCallSent > 0 || milestoneSent > 0) {
    log.info({ firstCallSent, milestoneSent }, "Pro alerts cycle complete");
  }
  healthMonitor.ok("caller-alerts", Date.now() - t0);
}

export function startCallerAlerts(): void {
  const loop = () => {
    checkAndAlert()
      .catch(err => {
        log.warn({ err }, "Pro alerts check failed");
        opsLog("telegram", "error", `Alerts loop: ${String(err).slice(0, 180)}`);
        healthMonitor.error("caller-alerts", err);
      })
      .finally(() => setTimeout(loop, CHECK_INTERVAL_MS));
  };
  setTimeout(loop, STARTUP_DELAY_MS);
  log.info(
    { intervalMs: CHECK_INTERVAL_MS, milestones: ALERT_MILESTONES },
    "Pro alerts ready (first-call + 2×/5×/10×/20× milestones, state on pro_calls)",
  );
  opsLog("telegram", "info", "Pro alerts loop started");
}
