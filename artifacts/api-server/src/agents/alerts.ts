import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { esc, sendTelegram } from "../core/telegram";
import { agentNote } from "./log";
import type { AlertLane } from "../scoring/desk";

export async function raiseAlert(opts: {
  tokenId: number;
  kind: string;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  telegram?: boolean;
  /** false = notifications only, no desk toast */
  screen?: boolean;
  lane?: AlertLane;
  score?: number | null;
}): Promise<boolean> {
  const lane = opts.lane ?? "early";
  const screen = opts.screen ?? lane === "early";
  const telegram = opts.telegram ?? screen;
  const payload = {
    ...(opts.payload ?? {}),
    lane,
    score: opts.score ?? null,
    screen,
  };

  let id: number | null = null;
  try {
    const ins = await pool.query(
      `INSERT INTO ward_alerts (token_id, kind, title, body, payload, lane, score)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [opts.tokenId, opts.kind, opts.title, opts.body, JSON.stringify(payload), lane, opts.score ?? null],
    );
    id = Number(ins.rows[0].id);
  } catch {
    const ins = await pool.query(
      `INSERT INTO ward_alerts (token_id, kind, title, body, payload)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [opts.tokenId, opts.kind, opts.title, opts.body, JSON.stringify(payload)],
    );
    id = Number(ins.rows[0].id);
  }

  if (screen) {
    emitSse("alert:new", {
      id,
      kind: opts.kind,
      title: opts.title,
      body: opts.body,
      tokenId: opts.tokenId,
      lane,
      score: opts.score ?? null,
      at: new Date().toISOString(),
    });
  }

  if (telegram && id != null) {
    const sent = await sendTelegram(`*${esc(opts.title)}*\n${esc(opts.body)}`);
    if (sent) {
      await pool.query("UPDATE ward_alerts SET telegram_sent = true WHERE id = $1", [id]);
    }
  }
  await agentNote("alerts", opts.kind.toUpperCase(), opts.title, { tokenId: opts.tokenId, quiet: true });
  return true;
}
