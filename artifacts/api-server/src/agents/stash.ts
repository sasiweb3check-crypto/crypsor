/**
 * One-shot: freeze prior pass counts so the desk starts a fresh epoch.
 * Old rows stay in the DB for Logs / patient charts.
 */
import { pool } from "../core/db";
import { getSetting, setSetting } from "../core/settings";

export async function stashFreshCounts(): Promise<string> {
  const existing = await getSetting("stats_epoch");
  if (existing) return existing;

  let payload: Record<string, unknown> = {};
  try {
    const snap = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM ward_trades) AS trades,
         (SELECT COUNT(*)::int FROM ward_trades WHERE status IN ('open','trim')) AS live,
         (SELECT COUNT(*)::int FROM f2_tokens) AS tokens,
         (SELECT MAX(called_at) FROM ward_trades) AS last_pass`,
    );
    payload = snap.rows[0] ?? {};
  } catch {
    payload = { note: "tables empty" };
  }

  try {
    await pool.query(
      `INSERT INTO ward_stats_stash (reason, payload) VALUES ('fresh_desk', $1)`,
      [JSON.stringify(payload)],
    );
  } catch {
    // table lands with schema
  }

  const epoch = new Date().toISOString();
  await setSetting("stats_epoch", epoch);
  return epoch;
}

export async function statsEpoch(): Promise<Date | null> {
  const raw = await getSetting("stats_epoch");
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}
