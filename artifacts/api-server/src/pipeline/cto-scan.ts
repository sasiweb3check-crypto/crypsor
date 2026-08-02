/**
 * CTO Scan — keep community-takeover flags fresh on the desk
 *
 * Every 5 minutes:
 *   1. Live-refresh GMGN `dev.cto_flag` for good / very_good pro_calls
 *   2. Persist security columns (CTO / creator)
 *   3. Telegram push once when a token newly flips to CTO (or first confirm)
 *
 * CTOs that are not ENTRY-served stay on the Waiting lane
 * (see /api/calls/waiting) — valued regardless of other gates.
 */

import { db } from "@workspace/db";
import { settings } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { opsLog } from "../lib/ops-log";
import { healthMonitor } from "./health-monitor";
import { fetchTokenSecurity, nextProxy } from "../lib/gmgn-client";
import { ensureProIndexes } from "../lib/pro-indexes";
import { isTelegramPushEnabled } from "../lib/telegram-push";

const log = logger.child({ module: "cto-scan" });

const CYCLE_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 45_000;
/** Cap live GMGN fetches per cycle — OpenAPI rate budget. */
const MAX_PER_CYCLE = 18;

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

function esc(s: string): string {
  return s.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

function fmtMc(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return "?";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

async function sendTelegram(
  creds: { botToken: string; chatId: string },
  text: string,
): Promise<void> {
  const chat_id = /^-?\d+$/.test(creds.chatId) ? Number(creds.chatId) : creds.chatId;
  const url = `https://api.telegram.org/bot${creds.botToken}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!resp.ok) {
    const plain = text.replace(/\\([_*[\]()~`>#+=|{}.!\-\\])/g, "$1");
    const retry = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text: plain, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!retry.ok) {
      const body = await retry.text().catch(() => "");
      throw new Error(`Telegram ${retry.status}: ${body.slice(0, 200)}`);
    }
  }
}

function buildCtoMessage(opts: {
  name: string | null;
  symbol: string | null;
  address: string;
  chain: string;
  qualityLabel: string;
  calledMc: number | null;
  currentMc: number | null;
  creatorClose: boolean | null;
  creatorCreated: number | null;
}): string {
  const name = esc(opts.name ?? "Unknown");
  const symbol = esc(opts.symbol ?? "?");
  const chain = (opts.chain || "solana").toLowerCase() === "solana" ? "sol" : opts.chain;
  const lines = [
    `🏴 *CTO DETECTED* — *${name}* \\(${symbol}\\)`,
    ``,
    `Quality *${esc(opts.qualityLabel)}* · MC *${esc(fmtMc(opts.calledMc))}* → Now *${esc(fmtMc(opts.currentMc))}*`,
    opts.creatorClose === true ? `Creator exited · community tape` : `Creator status updating`,
    opts.creatorCreated != null
      ? `Creator history *${opts.creatorCreated}* tokens \\(ignored on CTO\\)`
      : null,
    ``,
    `Held on Waiting until ENTRY gates clear — CTO is valued\\.`,
    ``,
    `CA: \`${opts.address}\``,
    `🔗 [GMGN](https://gmgn.ai/${chain}/token/${opts.address}) · [Dex](https://dexscreener.com/solana/${opts.address})`,
  ].filter((x): x is string => x != null);
  return lines.join("\n");
}

type DeskRow = {
  proCallId: number;
  tokenId: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  qualityLabel: string;
  calledMcUsd: string | null;
  marketCapUsd: string | null;
  prevCto: boolean | null;
  ctoAlertSentAt: string | Date | null;
};

async function loadDeskBatch(): Promise<DeskRow[]> {
  // Prefer unknown / not-yet-CTO / stale security first; already-CTO last (still refresh).
  const result = await db.execute(sql`
    SELECT
      pc.id AS pro_call_id,
      pc.token_id,
      pc.quality_label,
      pc.called_mc_usd,
      pc.cto_alert_sent_at,
      t.address, t.chain, t.name, t.symbol, t.market_cap_usd,
      t.sec_cto_flag,
      t.sec_fetched_at
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    WHERE pc.quality_label IN ('good', 'very_good')
      AND COALESCE(t.status, '') NOT IN ('ignored', 'archive')
    ORDER BY
      CASE WHEN t.sec_cto_flag IS DISTINCT FROM TRUE THEN 0 ELSE 1 END,
      CASE WHEN pc.cto_alert_sent_at IS NULL THEN 0 ELSE 1 END,
      t.sec_fetched_at ASC NULLS FIRST,
      pc.called_at DESC NULLS LAST
    LIMIT ${MAX_PER_CYCLE}
  `);

  return (result.rows as Array<Record<string, unknown>>).map(r => ({
    proCallId: Number(r.pro_call_id),
    tokenId: Number(r.token_id),
    address: String(r.address),
    chain: String(r.chain ?? "solana"),
    name: (r.name as string | null) ?? null,
    symbol: (r.symbol as string | null) ?? null,
    qualityLabel: String(r.quality_label ?? "good"),
    calledMcUsd: r.called_mc_usd != null ? String(r.called_mc_usd) : null,
    marketCapUsd: r.market_cap_usd != null ? String(r.market_cap_usd) : null,
    prevCto: r.sec_cto_flag == null ? null : Boolean(r.sec_cto_flag),
    ctoAlertSentAt: (r.cto_alert_sent_at as string | Date | null) ?? null,
  }));
}

async function ctoCycle(): Promise<void> {
  const t0 = Date.now();
  let batch: DeskRow[];
  try {
    batch = await loadDeskBatch();
  } catch (err) {
    log.warn({ err }, "CTO batch query failed — ensuring schema then retry");
    await ensureProIndexes().catch(() => {});
    batch = await loadDeskBatch();
  }

  if (batch.length === 0) {
    healthMonitor.ok("cto-scan", Date.now() - t0);
    return;
  }

  const creds = (await isTelegramPushEnabled()) ? await getTelegramCreds() : null;
  let checked = 0;
  let newCtos = 0;
  let alerted = 0;
  let failed = 0;

  for (const row of batch) {
    try {
      const proxy = nextProxy();
      const { ok, security: s } = await fetchTokenSecurity(row.chain, row.address, proxy);
      checked++;
      if (!ok) {
        failed++;
        await new Promise(r => setTimeout(r, 350));
        continue;
      }

      await db.execute(sql`
        UPDATE tracked_tokens SET
          sec_is_honeypot = ${s.isHoneypot},
          sec_mint_renounced = ${s.mintRenounced},
          sec_freeze_renounced = ${s.freezeRenounced},
          sec_top10_holder_rate = ${s.top10HolderRate},
          sec_creator_address = ${s.creatorAddress},
          sec_creator_close = ${s.creatorClose},
          sec_creator_token_status = ${s.creatorTokenStatus},
          sec_cto_flag = ${s.ctoFlag},
          sec_creator_created_count = ${s.creatorCreatedCount},
          sec_lp_locked = ${s.lpLocked},
          sec_lp_lock_percent = ${s.lpLockPercent},
          sec_fetched_at = NOW()
        WHERE id = ${row.tokenId}
      `);

      const nowCto = s.ctoFlag === true;
      const wasCto = row.prevCto === true;
      const alreadyAlerted = Boolean(row.ctoAlertSentAt);

      if (nowCto && (!wasCto || !alreadyAlerted)) {
        if (!wasCto) newCtos++;
        opsLog(
          "cto",
          wasCto ? "info" : "warn",
          `CTO · ${row.symbol ?? row.address.slice(0, 6)} · ${row.qualityLabel}`,
          {
            tokenId: row.tokenId,
            proCallId: row.proCallId,
            creatorClose: s.creatorClose,
            creatorCreated: s.creatorCreatedCount,
            prevCto: row.prevCto,
            flip: !wasCto,
          },
        );

        if (!alreadyAlerted) {
          let sentOk = false;
          if (creds) {
            try {
              const calledMc = row.calledMcUsd != null ? parseFloat(row.calledMcUsd) : null;
              const currentMc = row.marketCapUsd != null ? parseFloat(row.marketCapUsd) : null;
              await sendTelegram(creds, buildCtoMessage({
                name: row.name,
                symbol: row.symbol,
                address: row.address,
                chain: row.chain,
                qualityLabel: row.qualityLabel,
                calledMc: calledMc != null && Number.isFinite(calledMc) ? calledMc : null,
                currentMc: currentMc != null && Number.isFinite(currentMc) ? currentMc : null,
                creatorClose: s.creatorClose,
                creatorCreated: s.creatorCreatedCount,
              }));
              sentOk = true;
              alerted++;
              opsLog("telegram", "info", `CTO alert · ${row.symbol ?? row.address.slice(0, 6)}`, {
                tokenId: row.tokenId,
              });
              await new Promise(r => setTimeout(r, 350));
            } catch (err) {
              log.warn({ err, tokenId: row.tokenId }, "CTO Telegram failed");
              opsLog(
                "telegram",
                "error",
                `CTO alert failed · ${row.symbol ?? "?"}: ${String(err).slice(0, 120)}`,
              );
            }
          } else {
            // Mute / no creds — mark in-app so Waiting shows CTO without later spam
            sentOk = true;
            opsLog("cto", "info", `CTO in-app · ${row.symbol ?? row.address.slice(0, 6)} (push muted)`, {
              tokenId: row.tokenId,
            });
          }

          if (sentOk) {
            await db.execute(sql`
              UPDATE pro_calls
              SET cto_alert_sent_at = COALESCE(cto_alert_sent_at, NOW())
              WHERE id = ${row.proCallId}
            `);
          }
        }
      }

      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      failed++;
      log.warn({ err, tokenId: row.tokenId }, "CTO scan token failed");
    }
  }

  healthMonitor.ok("cto-scan", Date.now() - t0);
  opsLog("cto", "info", `CTO scan · ${checked} checked · ${newCtos} new · ${alerted} pushed`, {
    checked, newCtos, alerted, failed, batch: batch.length,
  });
  log.info({ checked, newCtos, alerted, failed, ms: Date.now() - t0 }, "CTO scan cycle complete");
}

export function startCtoScan(): void {
  setTimeout(() => {
    ctoCycle().catch(err => {
      healthMonitor.error("cto-scan", err);
      log.error({ err }, "CTO scan cycle error");
    });
    setInterval(() => {
      ctoCycle().catch(err => {
        healthMonitor.error("cto-scan", err);
        log.error({ err }, "CTO scan cycle error");
      });
    }, CYCLE_MS);
  }, STARTUP_DELAY_MS);

  log.info("CTO scan started (5m · good/very_good · Telegram on flip)");
}
