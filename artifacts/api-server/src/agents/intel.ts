/**
 * Fund-tape agent — observation log only.
 * Never inserts f2_tokens, never fires admit/rung toasts or telegram.
 */
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { sqlJson } from "./scout-json";
import { skipWallet, type IntelDraft } from "../scoring/intel";
import { collectSolDrafts } from "../sources/intel-sol";
import { collectDexRumorDrafts, collectRhBlockDrafts, ethUsdSpot } from "../sources/intel-rh";
import { solUsdSpot } from "../sources/scout-meta";
import { agentNote } from "./log";
import { logger } from "../core/log";

const log = logger.child({ module: "intel" });
let ticking = false;

export type IntelEvent = {
  id: number;
  chain: string;
  kind: string;
  at: string;
  wallet: string;
  counterparty: string | null;
  mint: string | null;
  symbol: string | null;
  name: string | null;
  usd: number | null;
  nativeAmt: number | null;
  tx: string;
  rumor: string | null;
  tags: string[];
  detail: string | null;
};

function rowToEvent(r: Record<string, unknown>): IntelEvent {
  const tags = Array.isArray(r.tags) ? r.tags as string[] : [];
  return {
    id: Number(r.id),
    chain: String(r.chain),
    kind: String(r.kind),
    at: new Date(r.at as string | Date).toISOString(),
    wallet: String(r.wallet),
    counterparty: (r.counterparty as string | null) ?? null,
    mint: (r.mint as string | null) ?? null,
    symbol: (r.symbol as string | null) ?? null,
    name: (r.name as string | null) ?? null,
    usd: r.usd != null ? Number(r.usd) : null,
    nativeAmt: r.native_amt != null ? Number(r.native_amt) : null,
    tx: String(r.tx),
    rumor: (r.rumor as string | null) ?? null,
    tags,
    detail: (r.detail as string | null) ?? null,
  };
}

async function trackedSet(): Promise<Set<string>> {
  try {
    const r = await pool.query("SELECT address FROM walletdatasource");
    return new Set((r.rows as Array<{ address: string }>).map((x) => x.address));
  } catch {
    return new Set();
  }
}

async function insertDraft(d: IntelDraft): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO intel_events
       (chain, kind, at, wallet, counterparty, mint, symbol, name, usd, native_amt, tx, rumor, tags, detail, extra)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb)
     ON CONFLICT (chain, tx, kind, wallet) DO NOTHING
     RETURNING id`,
    [
      d.chain,
      d.kind,
      new Date(d.at),
      d.wallet,
      d.counterparty,
      d.mint,
      d.symbol,
      d.name,
      d.usd,
      d.nativeAmt,
      d.tx,
      d.rumor,
      sqlJson(d.tags),
      d.detail,
      sqlJson(d.extra ?? null),
    ],
  );
  return Boolean(r.rowCount);
}

export async function intelTick(): Promise<{ seen: number; inserted: number }> {
  if (ticking) return { seen: 0, inserted: 0 };
  ticking = true;
  try {
    return await intelTickInner();
  } finally {
    ticking = false;
  }
}

async function intelTickInner(): Promise<{ seen: number; inserted: number }> {
  const tracked = await trackedSet();
  const [solUsd, ethUsd] = await Promise.all([solUsdSpot(), ethUsdSpot()]);
  const drafts: IntelDraft[] = [];
  try { drafts.push(...await collectSolDrafts(tracked, solUsd)); }
  catch (err) { log.warn({ err }, "sol collect failed"); }
  try { drafts.push(...await collectRhBlockDrafts(tracked, ethUsd)); }
  catch (err) { log.warn({ err }, "rh collect failed"); }
  try { drafts.push(...await collectDexRumorDrafts()); }
  catch (err) { log.warn({ err }, "dex rumor collect failed"); }

  const seenKeys = new Set<string>();
  let inserted = 0;
  for (const d of drafts) {
    if (skipWallet(d.wallet, tracked)) continue;
    const k = `${d.chain}:${d.tx}:${d.kind}:${d.wallet}`;
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    try {
      if (await insertDraft(d)) inserted += 1;
    } catch (err) {
      log.debug({ err, k }, "intel insert failed");
    }
  }

  if (inserted > 0) emitSse("intel:update", { inserted, at: new Date().toISOString() });
  await agentNote("intel", "TICK", `${inserted} new · ${drafts.length} seen`, { quiet: true });
  return { seen: drafts.length, inserted };
}

export type MovesQuery = {
  chain?: string;
  kind?: string;
  rumor?: boolean;
  page?: number;
  limit?: number;
};

export async function listMoves(q: MovesQuery = {}): Promise<{
  at: string;
  items: IntelEvent[];
  total: number;
  page: number;
  pages: number;
  limit: number;
}> {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(Math.max(q.limit ?? 40, 1), 80);
  const offset = (page - 1) * limit;
  const chain = q.chain === "sol" || q.chain === "robinhood" ? q.chain : null;
  const kind = q.kind === "fund" || q.kind === "buy" || q.kind === "sell" || q.kind === "deploy" ? q.kind : null;
  const rumor = Boolean(q.rumor);
  const count = await pool.query(
    `SELECT COUNT(*)::int AS n FROM intel_events
     WHERE ($1::text IS NULL OR chain = $1)
       AND ($2::text IS NULL OR kind = $2)
       AND ($3::boolean IS NOT TRUE OR rumor IS NOT NULL)`,
    [chain, kind, rumor],
  );
  const total = Number(count.rows[0]?.n ?? 0);
  const r = await pool.query(
    `SELECT * FROM intel_events
     WHERE ($1::text IS NULL OR chain = $1)
       AND ($2::text IS NULL OR kind = $2)
       AND ($3::boolean IS NOT TRUE OR rumor IS NOT NULL)
     ORDER BY at DESC, id DESC
     LIMIT $4 OFFSET $5`,
    [chain, kind, rumor, limit, offset],
  );
  return {
    at: new Date().toISOString(),
    items: r.rows.map((row) => rowToEvent(row as Record<string, unknown>)),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    limit,
  };
}
