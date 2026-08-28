import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { esc, sendTelegram } from "../core/telegram";
import { agentNote } from "./log";
import type { Factor, TapeWindow } from "../scoring/ward";

export type AlertKind = "admit" | "trade" | "critical" | "deceased" | "revived" | "report";

const DEDUPE_MS: Record<string, number> = {
  admit: 0,
  trade: 6 * 3600_000,
  critical: 30 * 60_000,
  deceased: 12 * 3600_000,
  revived: 6 * 3600_000,
  report: 0,
};

export async function raiseAlert(opts: {
  tokenId: number;
  kind: AlertKind;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  telegram?: boolean;
}): Promise<boolean> {
  const windowMs = DEDUPE_MS[opts.kind] ?? 0;
  if (windowMs > 0) {
    const recent = await pool.query(
      `SELECT id FROM ward_alerts
       WHERE token_id = $1 AND kind = $2 AND at > NOW() - ($3::int || ' milliseconds')::interval
       LIMIT 1`,
      [opts.tokenId, opts.kind, windowMs],
    );
    if (recent.rows.length) return false;
  }

  const ins = await pool.query(
    `INSERT INTO ward_alerts (token_id, kind, title, body, payload)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [opts.tokenId, opts.kind, opts.title, opts.body, JSON.stringify(opts.payload ?? {})],
  );

  emitSse("alert:new", {
    id: ins.rows[0].id,
    kind: opts.kind,
    title: opts.title,
    body: opts.body,
    tokenId: opts.tokenId,
    at: new Date().toISOString(),
  });

  let sent = false;
  if (opts.telegram) {
    const msg = `*${esc(opts.title)}*\n${esc(opts.body)}`;
    sent = await sendTelegram(msg);
    if (sent) {
      await pool.query("UPDATE ward_alerts SET telegram_sent = true WHERE id = $1", [ins.rows[0].id]);
    }
  }
  await agentNote("alerts", opts.kind.toUpperCase(), opts.title, { tokenId: opts.tokenId });
  return true;
}

function tapeLine(label: string, w: TapeWindow | undefined): string {
  if (!w || (w.buys == null && w.sells == null)) return "";
  const ch = w.changePct != null ? ` ${w.changePct >= 0 ? "+" : ""}${Math.round(w.changePct)}%` : "";
  return `${label} ${w.buys ?? "—"}/${w.sells ?? "—"} buy/sell${ch}`;
}

export async function tradeTelegram(p: {
  symbol: string;
  mint: string;
  score: number;
  phase: string;
  mc: number | null;
  liq: number | null;
  holders: number | null;
  wallets: number;
  tape: string;
  holds: string[];
  fails: string[];
  factors?: Factor[];
  m5?: TapeWindow;
  h1?: TapeWindow;
  h6?: TapeWindow;
  top10?: number | null;
  bundlers?: number | null;
  bots?: number | null;
}): Promise<void> {
  const factorBits = (p.factors ?? [])
    .map((f) => `${f.label} ${Math.round(f.points)}/${f.max}`)
    .slice(0, 6);
  const lines = [
    `TRADE $${p.symbol}`,
    `score ${p.score} · ${p.phase} · tape ${p.tape}`,
    `mc ${p.mc != null ? `$${Math.round(p.mc)}` : "—"} · liq ${p.liq != null ? `$${Math.round(p.liq)}` : "—"} · holders ${p.holders ?? "—"}`,
    `top10 ${p.top10 != null ? `${Math.round(p.top10)}%` : "—"} · bundlers ${p.bundlers != null ? `${Math.round(p.bundlers)}%` : "—"} · bots ${p.bots != null ? `${Math.round(p.bots)}%` : "—"}`,
    `${p.wallets} tracked wallets`,
    tapeLine("5m", p.m5),
    tapeLine("1h", p.h1),
    tapeLine("6h", p.h6),
    p.holds.length ? `holds: ${p.holds.slice(0, 3).join("; ")}` : "",
    p.fails.length ? `fails: ${p.fails.slice(0, 3).join("; ")}` : "",
    factorBits.length ? `factors: ${factorBits.join(" · ")}` : "",
    `https://dexscreener.com/solana/${p.mint}`,
    `https://solscan.io/token/${p.mint}`,
  ].filter(Boolean);
  await sendTelegram(lines.map(esc).join("\n"));
}
