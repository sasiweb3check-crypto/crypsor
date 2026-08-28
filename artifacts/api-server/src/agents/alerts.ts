import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { esc, sendTelegram } from "../core/telegram";
import { agentNote } from "./log";

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
}): Promise<void> {
  const lines = [
    `TRADE $${p.symbol}`,
    `score ${p.score} · ${p.phase}`,
    `mc ${p.mc != null ? `$${Math.round(p.mc)}` : "—"} · liq ${p.liq != null ? `$${Math.round(p.liq)}` : "—"} · holders ${p.holders ?? "—"}`,
    `tape ${p.tape} · ${p.wallets} tracked wallets`,
    p.holds.length ? `holds: ${p.holds.slice(0, 3).join("; ")}` : "",
    p.fails.length ? `fails: ${p.fails.slice(0, 3).join("; ")}` : "",
    `https://dexscreener.com/solana/${p.mint}`,
    `https://solscan.io/token/${p.mint}`,
  ].filter(Boolean);
  await sendTelegram(lines.map(esc).join("\n"));
}
