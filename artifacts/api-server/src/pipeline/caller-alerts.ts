/**
 * Runner Entry Alerts — momentum-confirmed entries (MC-agnostic)
 *
 * 1. ENTRY ping — when Runner phase hits `entry` (velocity / structure),
 *    soft tagged presence (smart OR KOL), mint preferred. No $5–15K gate.
 * 2. Milestone alerts — 2× / 5× / 10× / 20× after an ENTRY ping.
 *
 * Radar / Heating stay on the desk — never silent, just not Telegram ENTRY.
 */

import { db } from "@workspace/db";
import { settings } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { extractSocials, type Socials } from "../lib/socials";
import { opsLog } from "../lib/ops-log";
import { healthMonitor } from "./health-monitor";
import { computeRunnerScore, type RunnerScoreResult } from "../lib/runner-score";
import { convictionFieldsFromVerified } from "../lib/pro-confidence";

const log = logger.child({ module: "caller-alerts" });

const CHECK_INTERVAL_MS = 20_000;
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
      healthMonitor.error("caller-alerts", err);
      throw new Error(err);
    }
    opsLog("telegram", "info", "Telegram send OK", { attempt }, latencyMs);
    healthMonitor.ok("caller-alerts", latencyMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const transient =
      msg.includes("fetch failed") ||
      msg.includes("Abort") ||
      msg.includes("ECONN") ||
      msg.includes("ETIMEDOUT");
    if (transient && attempt < 2) {
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      return sendTelegram(creds, text, attempt + 1);
    }
    throw err;
  }
}

function esc(s: string): string {
  return s.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

function fmtMc(v: string | null | undefined): string {
  const n = parseFloat(v ?? "0");
  if (!Number.isFinite(n) || n <= 0) return "?";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

function gmgnLink(chain: string, address: string): string {
  const map: Record<string, string> = { solana: "sol", eth: "eth", base: "base", bsc: "bsc" };
  return `https://gmgn.ai/${map[chain] ?? "sol"}/token/${address}`;
}

function socialBlock(socials: Socials): string[] {
  const out: string[] = [];
  if (socials.twitter) out.push(`𝕏 ${esc(socials.twitter)}`);
  if (socials.telegram) out.push(`TG ${esc(socials.telegram)}`);
  if (socials.website) out.push(`Web ${esc(socials.website)}`);
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
  verifiedWallets: unknown;
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
  runnerScore: number | null;
  runnerPhase: string | null;
  runnerAlertSentAt: string | Date | null;
  callAlertSentAt: string | Date | null;
  milestoneAlertsSent: string | null;
  currentMc: string | null;
  liveKol: number;
  liveSmart: number;
  liveIntel: number | null;
  liveHv: number | null;
  volumeIntensity: number | null;
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

function evaluateRunner(t: ProAlertToken): RunnerScoreResult {
  const calledMc = parseFloat(t.calledMcUsd ?? "0") || 0;
  const currentMc = parseFloat(t.currentMc ?? "0") || 0;
  const velocity = calledMc > 0 && currentMc > 0 ? currentMc / calledMc : 1;
  const gainPct = calledMc > 0 && currentMc > 0 ? ((currentMc - calledMc) / calledMc) * 100 : 0;
  const calledAt = t.calledAt instanceof Date ? t.calledAt.getTime() : new Date(t.calledAt).getTime();
  const ageMinutes = Number.isFinite(calledAt) ? (Date.now() - calledAt) / 60_000 : 9999;
  const vw = convictionFieldsFromVerified(t.verifiedWallets);

  return computeRunnerScore({
    calledIntelScore: t.calledIntel,
    calledSmartCount: t.calledSmart,
    calledKolCount: t.calledKol,
    calledMcUsd: calledMc || null,
    currentMcUsd: currentMc || null,
    athMultiple: t.athMultiple ?? velocity,
    gainPct,
    ageMinutes,
    velocity,
    snapDeltaPct: null,
    liveSmart: t.liveSmart,
    liveKol: t.liveKol,
    secIsHoneypot: t.secHoneypot,
    secMintRenounced: t.secMint,
    secFreezeRenounced: t.secFreeze,
    holderVelocityScore: t.liveHv ?? t.calledHv,
    volumeIntensityScore: t.volumeIntensity,
    smartHoldRate: vw.smartHoldRate,
  });
}

function buildEntryMessage(t: ProAlertToken, runner: RunnerScoreResult): string {
  const name = esc(t.name ?? "Unknown");
  const symbol = esc(t.symbol ?? "?");
  const socials = extractSocials(t.rawMetadata);
  const why = runner.reasons.slice(0, 4).map(r => `• ${esc(r)}`);
  const lines = [
    `🚀 *RUNNER ENTRY* — *${name}* \\(${symbol}\\)`,
    ``,
    `Phase *${esc(runner.label)}* · Score *${runner.score}* · Vel *${esc(String(runner.signals.velocity))}×*`,
    `Entry MC: *${esc(fmtMc(t.calledMcUsd))}* · Now: *${esc(fmtMc(t.currentMc))}* · Gain *${Math.round(runner.signals.gainPct)}%*`,
    `Size *${esc(runner.sizeLabel)}* · Tagged smart *${t.calledSmart}* / KOL *${t.calledKol}*`,
    t.secMint === true ? `✅ Mint renounced` : null,
    ``,
    `*Why this entry*`,
    ...why,
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
  const emoji: Record<number, string> = { 2: "🔥", 5: "🚀", 10: "💎", 20: "👑" };
  const socials = extractSocials(t.rawMetadata);
  const lines = [
    `${emoji[tier] ?? "🏆"} *${name}* \\(${symbol}\\) hit *${tier}×*`,
    ``,
    `ATH *${athX.toFixed(1)}×* · Now *${esc(fmtMc(t.currentMc))}* · Entry *${esc(fmtMc(t.calledMcUsd))}*`,
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
    const last = (checkAndAlert as { _lastNoTg?: number })._lastNoTg ?? 0;
    if (Date.now() - last > 600_000) {
      (checkAndAlert as { _lastNoTg?: number })._lastNoTg = Date.now();
      opsLog("blocker", "warn", "Telegram not configured — Runner alerts skipped");
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
      pc.verified_wallets      AS "verifiedWallets",
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
      pc.runner_score          AS "runnerScore",
      pc.runner_phase          AS "runnerPhase",
      pc.runner_alert_sent_at  AS "runnerAlertSentAt",
      pc.call_alert_sent_at    AS "callAlertSentAt",
      pc.milestone_alerts_sent AS "milestoneAlertsSent",
      t.market_cap_usd         AS "currentMc",
      COALESCE(t.holder_kol_count, 0)   AS "liveKol",
      COALESCE(t.holder_smart_count, 0) AS "liveSmart",
      t.intelligence_score     AS "liveIntel",
      t.holder_velocity_score  AS "liveHv",
      t.volume_intensity_score AS "volumeIntensity",
      t.liquidity_usd          AS "liquidityUsd",
      t.holder_count           AS "holderCount",
      t.sec_mint_renounced     AS "secMint",
      t.sec_freeze_renounced   AS "secFreeze",
      t.sec_is_honeypot        AS "secHoneypot"
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    WHERE pc.surfaced_at IS NOT NULL
      AND pc.quality_label IN ('very_good', 'good')
      AND (
        (pc.runner_alert_sent_at IS NULL AND pc.called_at >= NOW() - INTERVAL '3 hours')
        OR (
          (pc.runner_alert_sent_at IS NOT NULL OR pc.call_alert_sent_at IS NOT NULL)
          AND COALESCE(pc.ath_multiple, 1) >= 2
        )
      )
    ORDER BY
      (pc.runner_alert_sent_at IS NULL) DESC,
      pc.called_at DESC
    LIMIT 200
  `);

  const tokens = rows.rows as unknown as ProAlertToken[];
  let entrySent = 0;
  let milestoneSent = 0;
  let skipped = 0;
  const MAX_SENDS_PER_CYCLE = 8;
  let sends = 0;

  for (const t of tokens) {
    if (sends >= MAX_SENDS_PER_CYCLE) {
      opsLog("telegram", "warn", `Alert cap ${MAX_SENDS_PER_CYCLE}/cycle — remain queued`);
      break;
    }

    const alreadyEntry = Boolean(t.runnerAlertSentAt || t.callAlertSentAt);

    if (!alreadyEntry) {
      const runner = evaluateRunner(t);
      // Persist live phase even when not alerting
      await db.execute(sql`
        UPDATE pro_calls
        SET runner_score = ${runner.score},
            runner_phase = ${runner.phase}
        WHERE id = ${t.proCallId}
      `);

      if (!runner.alertEligible) {
        skipped++;
        continue;
      }
      try {
        await sendTelegram(creds, buildEntryMessage(t, runner));
        await db.execute(sql`
          UPDATE pro_calls
          SET runner_alert_sent_at = NOW(),
              call_alert_sent_at = COALESCE(call_alert_sent_at, NOW()),
              runner_score = ${runner.score},
              runner_phase = ${runner.phase}
          WHERE id = ${t.proCallId} AND runner_alert_sent_at IS NULL
        `);
        entrySent++;
        sends++;
        log.info(
          { proCallId: t.proCallId, symbol: t.symbol, runner: runner.score, phase: runner.phase },
          "Runner ENTRY alert sent",
        );
        opsLog("telegram", "info", `Runner ENTRY · ${t.symbol ?? t.address.slice(0, 6)} · ${runner.score}`, {
          velocity: runner.signals.velocity,
          phase: runner.phase,
        });
        await new Promise(r => setTimeout(r, 350));
      } catch (err) {
        log.warn({ err, tokenId: t.tokenId, symbol: t.symbol }, "Runner ENTRY alert failed");
        opsLog("telegram", "error", `ENTRY failed · ${t.symbol ?? "?"}: ${String(err).slice(0, 160)}`);
      }
      continue;
    }

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
        opsLog("telegram", "info", `Milestone ${tier}× · ${t.symbol ?? "?"}`, { athX });
        if (sends >= MAX_SENDS_PER_CYCLE) break;
        await new Promise(r => setTimeout(r, 350));
      } catch (err) {
        log.warn({ err, tokenId: t.tokenId, symbol: t.symbol, tier }, "Milestone alert failed");
        break;
      }
    }
  }

  if (entrySent > 0 || milestoneSent > 0 || skipped > 0) {
    log.info({ entrySent, milestoneSent, skipped }, "Runner alerts cycle complete");
  }
  healthMonitor.ok("caller-alerts", Date.now() - t0);
}

export function startCallerAlerts(): void {
  const loop = () => {
    checkAndAlert()
      .catch(err => {
        log.warn({ err }, "Runner alerts check failed");
        opsLog("telegram", "error", `Alerts loop: ${String(err).slice(0, 180)}`);
        healthMonitor.error("caller-alerts", err);
      })
      .finally(() => setTimeout(loop, CHECK_INTERVAL_MS));
  };
  setTimeout(loop, STARTUP_DELAY_MS);
  log.info(
    { intervalMs: CHECK_INTERVAL_MS, milestones: ALERT_MILESTONES },
    "Runner alerts ready (ENTRY momentum + milestones)",
  );
  opsLog("telegram", "info", "Runner alerts loop started");
}
