import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { esc, sendTelegram } from "../core/telegram";
import { agentNote } from "./log";

export async function raiseAlert(opts: {
  tokenId: number;
  kind: string;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  telegram?: boolean;
}): Promise<boolean> {
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

  if (opts.telegram) {
    const sent = await sendTelegram(`*${esc(opts.title)}*\n${esc(opts.body)}`);
    if (sent) {
      await pool.query("UPDATE ward_alerts SET telegram_sent = true WHERE id = $1", [ins.rows[0].id]);
    }
  }
  await agentNote("alerts", opts.kind.toUpperCase(), opts.title, { tokenId: opts.tokenId, quiet: true });
  return true;
}
