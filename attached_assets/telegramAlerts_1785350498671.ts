/**
 * telegramAlerts.ts
 *
 * Builds formatted Telegram alert payloads from ScoreResult objects produced
 * by scoringEngine.ts. Delivery (bot token, chat routing, BullMQ job, retry
 * logic) is intentionally left to the caller — this module only classifies
 * an alert type and renders the message.
 */

import { FactorTag, RawSignal, ScoreResult } from "./scoringEngine";

export type AlertType =
  | "GOOD_SETUP"
  | "SURPRISE_SIGNAL"
  | "DUMP_WARNING"
  | "NONE";

export interface TelegramAlert {
  type: AlertType;
  severity: "info" | "warning" | "critical";
  text: string; // Markdown, ready for sendMessage parse_mode=MarkdownV2 (escape before send)
  factors: FactorTag[];
  compositeScore: number;
  tokenAddress: string;
}

const GOOD: FactorTag[] = ["GOOD_MOMENTUM", "GOOD_LIQUIDITY", "GOOD_SMART_MONEY"];
const SURPRISE: FactorTag[] = ["SURPRISE_ACCUMULATION", "SURPRISE_HOLDER_SURGE"];
const DUMP: FactorTag[] = ["DUMP_LIQUIDITY_DRAIN", "DUMP_HOLDER_EXODUS", "DUMP_STALE_PUMP"];

const FACTOR_LABEL: Record<FactorTag, string> = {
  GOOD_MOMENTUM: "Strong holder momentum",
  GOOD_LIQUIDITY: "Healthy liquidity",
  GOOD_SMART_MONEY: "Confirmed smart/KOL buying",
  SURPRISE_ACCUMULATION: "Smart money entering before price move",
  SURPRISE_HOLDER_SURGE: "Holder surge ahead of price",
  DUMP_LIQUIDITY_DRAIN: "Liquidity draining under volume spike",
  DUMP_HOLDER_EXODUS: "Holders exiting under sell pressure",
  DUMP_STALE_PUMP: "Price pumped without holder/liquidity support",
};

/**
 * Priority order when a token trips multiple categories in one pass:
 * dump warnings always win (protect capital first), then surprise
 * (time-sensitive entries), then good setups.
 */
export function classifyAlert(result: ScoreResult): AlertType {
  if (result.factors.some((f) => DUMP.includes(f))) return "DUMP_WARNING";
  if (result.factors.some((f) => SURPRISE.includes(f))) return "SURPRISE_SIGNAL";
  if (result.factors.some((f) => GOOD.includes(f))) return "GOOD_SETUP";
  return "NONE";
}

function severityFor(type: AlertType, result: ScoreResult): TelegramAlert["severity"] {
  if (type === "DUMP_WARNING") {
    return result.factors.includes("DUMP_LIQUIDITY_DRAIN") ? "critical" : "warning";
  }
  if (type === "SURPRISE_SIGNAL") return "info";
  return "info";
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function buildTelegramAlert(
  sig: RawSignal,
  result: ScoreResult
): TelegramAlert | null {
  const type = classifyAlert(result);
  if (type === "NONE") return null;

  const severity = severityFor(type, result);
  const icon = { GOOD_SETUP: "🟢", SURPRISE_SIGNAL: "🟡", DUMP_WARNING: "🔴" }[type];
  const heading = {
    GOOD_SETUP: "Good Setup",
    SURPRISE_SIGNAL: "Surprising Signal",
    DUMP_WARNING: "Dump Warning",
  }[type];

  const relevantFactors = result.factors.filter((f) =>
    type === "GOOD_SETUP" ? GOOD.includes(f) : type === "SURPRISE_SIGNAL" ? SURPRISE.includes(f) : DUMP.includes(f)
  );

  const lines = [
    `${icon} *${heading}* — score ${result.compositeScore}/100`,
    `\`${sig.tokenAddress}\``,
    "",
    ...relevantFactors.map((f) => `• ${FACTOR_LABEL[f]}`),
    "",
    `MC: ${fmtUsd(sig.marketCapUsd)} | Vol24h: ${fmtUsd(sig.volume24hUsd)} | Liq: ${fmtUsd(sig.liquidityUsd)}`,
    `Holders: ${sig.holderCount} (KOL ${sig.holderKolCount} / Smart ${sig.holderSmartCount})`,
    `Age: ${sig.ageHours.toFixed(1)}h`,
  ];

  return {
    type,
    severity,
    text: lines.join("\n"),
    factors: relevantFactors,
    compositeScore: result.compositeScore,
    tokenAddress: sig.tokenAddress,
  };
}

/**
 * Thin fetch-based sender using the raw Bot API — swap for your own
 * queueing/rate-limit wrapper (BullMQ job, etc). Left unopinionated on
 * purpose since you said you'd wire delivery yourself.
 */
export async function sendTelegramAlert(
  alert: TelegramAlert,
  opts: { botToken: string; chatId: string }
): Promise<void> {
  const url = `https://api.telegram.org/bot${opts.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: opts.chatId,
      text: alert.text,
      parse_mode: "Markdown",
    }),
  });
  if (!res.ok) {
    throw new Error(`Telegram send failed: ${res.status} ${await res.text()}`);
  }
}
