/**
 * Pump desk alert emitter — notable signals from pump-fullend scoring.
 *
 * Fires once per (token, kind):
 *   STRONG_BUY · INTRA_NOW · GRADE_S · GRADE_A · EEI · LARRY
 *   GAIN_50 · ATH_2X · ATH_5X · ATH_10X
 *
 * Telegram is wired ONLY to these alerts (legacy Runner ENTRY is backup/off).
 */

import { db, tracked_tokens } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { opsLog } from "../lib/ops-log";
import {
  escTelegram,
  fmtUsdCompact,
  sendTelegramMessage,
} from "../lib/telegram-send";
import {
  effectivePumpAthGain,
  effectivePumpGain,
  type PumpScanPayload,
} from "../lib/pump-sdk-score";
import { eventBus } from "./event-bus";
import { healthMonitor } from "./health-monitor";

const log = logger.child({ module: "pump-alerts" });

healthMonitor.register("pump-alerts");

export type PumpAlertKind =
  | "STRONG_BUY"
  | "INTRA_NOW"
  | "GRADE_S"
  | "GRADE_A"
  | "EEI"
  | "LARRY"
  | "GAIN_50"
  | "ATH_2X"
  | "ATH_5X"
  | "ATH_10X";

const KIND_META: Record<PumpAlertKind, { label: string; priority: number }> = {
  STRONG_BUY: { label: "READY TO BUY", priority: 100 },
  INTRA_NOW: { label: "INTRADAY NOW", priority: 95 },
  GRADE_S: { label: "S GRADE", priority: 90 },
  GRADE_A: { label: "A GRADE", priority: 80 },
  LARRY: { label: "LARRY SIGNAL", priority: 88 },
  EEI: { label: "EEI ACTIVE", priority: 75 },
  GAIN_50: { label: "GAINED 50%+", priority: 85 },
  ATH_2X: { label: "ATH 2×", priority: 86 },
  ATH_5X: { label: "ATH 5×", priority: 92 },
  ATH_10X: { label: "ATH 10×", priority: 98 },
};

export type PumpAlertEvent = {
  id: number;
  tokenId: number;
  kind: PumpAlertKind;
  label: string;
  title: string;
  body: string | null;
  score: number | null;
  grade: string | null;
  buySignal: string | null;
  intraSignal: string | null;
  marketCapUsd: number | null;
  mcAtDetection: number | null;
  gainPct: number | null;
  athGainPct: number | null;
  symbol: string | null;
  name: string | null;
  address: string | null;
  telegramSent: boolean;
  createdAt: string;
};

function candidatesFromScan(scan: PumpScanPayload): PumpAlertKind[] {
  const out: PumpAlertKind[] = [];
  if (scan.buySignal === "STRONG_BUY") out.push("STRONG_BUY");
  if (scan.intraSignal === "INTRA_NOW") out.push("INTRA_NOW");
  if (scan.grade === "S") out.push("GRADE_S");
  if (scan.grade === "A" || scan.grade === "S") out.push("GRADE_A");
  if (scan.scores.earlyExplosionIndex >= 8) out.push("LARRY");
  else if (scan.scores.earlyExplosionIndex >= 5) out.push("EEI");

  const mcGain = effectivePumpGain(scan);
  const athGain = effectivePumpAthGain(scan);
  if (mcGain >= 50) out.push("GAIN_50");
  if (athGain >= 900) out.push("ATH_10X");
  else if (athGain >= 400) out.push("ATH_5X");
  else if (athGain >= 100) out.push("ATH_2X");
  return out;
}

function buildTitle(kind: PumpAlertKind, sym: string, scan: PumpScanPayload): string {
  const gain = Math.round(effectivePumpGain(scan));
  const ath = Math.round(effectivePumpAthGain(scan));
  switch (kind) {
    case "STRONG_BUY":
      return `$${sym} READY TO BUY · ${scan.grade}${scan.score}`;
    case "INTRA_NOW":
      return `$${sym} INTRADAY NOW · act window`;
    case "GRADE_S":
      return `$${sym} S-GRADE · score ${scan.score}`;
    case "GRADE_A":
      return `$${sym} A-GRADE · score ${scan.score}`;
    case "LARRY":
      return `$${sym} LARRY SIGNAL · EEI ${scan.scores.earlyExplosionIndex}/10`;
    case "EEI":
      return `$${sym} EEI ACTIVE · EEI ${scan.scores.earlyExplosionIndex}/10`;
    case "GAIN_50":
      return `$${sym} GAINED ${gain >= 0 ? "+" : ""}${gain}% since detect`;
    case "ATH_2X":
      return `$${sym} ATH 2× · +${ath}% peak`;
    case "ATH_5X":
      return `$${sym} ATH 5× · +${ath}% peak`;
    case "ATH_10X":
      return `$${sym} ATH 10× · +${ath}% peak`;
    default:
      return `$${sym} ${kind}`;
  }
}

function buildBody(kind: PumpAlertKind, scan: PumpScanPayload): string {
  const detect = fmtUsdCompact(scan.mcAtDetection);
  const now = fmtUsdCompact(scan.marketCap);
  const gain = Math.round(effectivePumpGain(scan));
  const ath = Math.round(effectivePumpAthGain(scan));
  const parts = [
    `Detect ${detect} → Now ${now}`,
    `Gain ${gain >= 0 ? "+" : ""}${gain}% · ATH +${ath}%`,
    `Score ${scan.score} ${scan.grade}`,
  ];
  if (scan.buySignal) parts.push(`Buy ${scan.buySignal} (${scan.buyPassCount}/8)`);
  if (scan.intraSignal) parts.push(`Intra ${scan.intraSignal} (${scan.intraPassCount}/6)`);
  const tags = scan.tags.filter((t) => t.type === "positive").slice(0, 3).map((t) => t.label);
  if (tags.length) parts.push(tags.join(" · "));
  return parts.join(" · ");
}

function buildTelegramText(opts: {
  kind: PumpAlertKind;
  label: string;
  sym: string;
  address: string;
  scan: PumpScanPayload;
  title: string;
}): string {
  const { kind, label, sym, address, scan } = opts;
  const detect = fmtUsdCompact(scan.mcAtDetection);
  const nowMc = fmtUsdCompact(scan.marketCap);
  const gain = Math.round(effectivePumpGain(scan));
  const ath = Math.round(effectivePumpAthGain(scan));
  const gmgn = `https://gmgn.ai/sol/token/${address}`;
  return [
    `*${escTelegram(label)}*`,
    `$${escTelegram(sym)} · Grade *${escTelegram(scan.grade)}* ${scan.score}`,
    `Detect ${escTelegram(detect)} → Now ${escTelegram(nowMc)}`,
    `Gain ${gain >= 0 ? "+" : ""}${gain}% · ATH \\+${ath}%`,
    scan.buySignal ? `Buy ${escTelegram(scan.buySignal)} \\(${scan.buyPassCount}/8\\)` : null,
    scan.intraSignal ? `Intra ${escTelegram(scan.intraSignal)} \\(${scan.intraPassCount}/6\\)` : null,
    kind.startsWith("ATH") || kind === "GAIN_50"
      ? `Milestone ${escTelegram(label)}`
      : null,
    `[GMGN](${escTelegram(gmgn)})`,
  ].filter(Boolean).join("\n");
}

async function loadTokenMeta(tokenId: number): Promise<{
  address: string;
  symbol: string | null;
  name: string | null;
} | null> {
  const rows = await db
    .select({
      address: tracked_tokens.address,
      symbol: tracked_tokens.symbol,
      name: tracked_tokens.name,
    })
    .from(tracked_tokens)
    .where(eq(tracked_tokens.id, tokenId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    address: r.address,
    symbol: r.symbol,
    name: r.name,
  };
}

/**
 * Evaluate scan payload and fire any new notable alerts (deduped by token+kind).
 */
export async function evaluatePumpAlerts(
  tokenId: number,
  scan: PumpScanPayload,
): Promise<PumpAlertEvent[]> {
  const t0 = Date.now();
  const fired: PumpAlertEvent[] = [];
  try {
    const kinds = candidatesFromScan(scan);
    if (!kinds.length) {
      healthMonitor.ok("pump-alerts", Date.now() - t0);
      return fired;
    }

    const meta = await loadTokenMeta(tokenId);
    if (!meta) return fired;
    const sym = (meta.symbol || meta.name || meta.address.slice(0, 6)).trim() || "?";

    for (const kind of kinds) {
      const metaK = KIND_META[kind];
      const title = buildTitle(kind, sym, scan);
      const body = buildBody(kind, scan);

      // Insert-once; skip if already alerted this kind for token
      const inserted = await db.execute(sql`
        INSERT INTO pump_alerts (
          token_id, kind, label, title, body,
          score, grade, buy_signal, intra_signal,
          market_cap_usd, mc_at_detection, gain_pct, ath_gain_pct,
          symbol, name, address
        ) VALUES (
          ${tokenId}, ${kind}, ${metaK.label}, ${title}, ${body},
          ${scan.score}, ${scan.grade}, ${scan.buySignal}, ${scan.intraSignal},
          ${String(scan.marketCap)}, ${String(scan.mcAtDetection)},
          ${effectivePumpGain(scan)}, ${effectivePumpAthGain(scan)},
          ${meta.symbol}, ${meta.name}, ${meta.address}
        )
        ON CONFLICT (token_id, kind) DO NOTHING
        RETURNING id, created_at, telegram_sent
      `);

      const row = inserted.rows[0] as
        | { id: number; created_at: Date | string; telegram_sent: boolean }
        | undefined;
      if (!row) continue;

      const tgText = buildTelegramText({
        kind,
        label: metaK.label,
        sym,
        address: meta.address,
        scan,
        title,
      });
      const tg = await sendTelegramMessage(tgText);
      if (tg.ok || tg.error) {
        await db.execute(sql`
          UPDATE pump_alerts
          SET telegram_sent = ${tg.ok},
              telegram_error = ${tg.ok ? null : (tg.error ?? "send_failed")}
          WHERE id = ${row.id}
        `);
      }

      const evt: PumpAlertEvent = {
        id: Number(row.id),
        tokenId,
        kind,
        label: metaK.label,
        title,
        body,
        score: scan.score,
        grade: scan.grade,
        buySignal: scan.buySignal,
        intraSignal: scan.intraSignal,
        marketCapUsd: scan.marketCap,
        mcAtDetection: scan.mcAtDetection,
        gainPct: effectivePumpGain(scan),
        athGainPct: effectivePumpAthGain(scan),
        symbol: meta.symbol,
        name: meta.name,
        address: meta.address,
        telegramSent: tg.ok,
        createdAt: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
      };
      fired.push(evt);

      opsLog(
        "telegram",
        tg.ok ? "info" : "warn",
        `Pump alert ${kind} $${sym}${tg.ok ? " → TG" : ` (tg: ${tg.error})`}`,
        { tokenId, kind, alertId: evt.id },
      );

      eventBus.emit("alert:pump", evt);
      eventBus.emit("calls:changed", {
        reason: "score",
        tokenId,
        symbol: meta.symbol,
        at: new Date().toISOString(),
      });
    }

    healthMonitor.ok("pump-alerts", Date.now() - t0);
  } catch (err) {
    healthMonitor.error("pump-alerts", err);
    log.warn({ err, tokenId }, "evaluatePumpAlerts failed");
  }
  return fired;
}

export function startPumpAlerts(): void {
  log.info("pump-alerts ready (evaluate on each buy-scan)");
}
