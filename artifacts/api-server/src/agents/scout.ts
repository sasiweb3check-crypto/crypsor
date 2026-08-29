/**
 * Wallet scout — mint in, reconstruct this-token fills, rank profitable wallets.
 * GMGN unofficial routes gap-fill missing wallets/trades/tags. ROI stays from fills.
 * Runs one job at a time so intake/scan keep the desk alive.
 */
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { heliusKey } from "../core/settings";
import {
  bookWallet, expandTape, mergeFillGaps, rankWallets,
  type ScoutWallet, type TokenFill,
} from "../scoring/scout-fills";
import { loadScoutToken, type ScoutToken } from "../sources/scout-meta";
import {
  loadGeckoTrades, loadHolders, loadOhlcv, loadPoolTxs, loadPumpTrades, skipSet, stampMc,
} from "../sources/scout-tape";
import { mergeLabels } from "../sources/gmgn-client";
import { gmgnWalletLabels, loadGmgnTokenTape, loadGmgnWalletActivity } from "../sources/gmgn-tape";
import { logger } from "../core/log";
import { sqlJson } from "./scout-json";

export type ScoutJob = {
  id: number;
  mint: string;
  status: "queued" | "running" | "done" | "error";
  phase: string | null;
  detail: string | null;
  progress_n: number | null;
  progress_of: number | null;
  token: ScoutToken | null;
  wallets: ScoutWallet[] | null;
  fills_n: number | null;
  notes: string[] | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ACTIVITY_CAP = 15;
let running = false;

function rowToJob(r: Record<string, unknown>): ScoutJob {
  return {
    id: Number(r.id),
    mint: String(r.mint),
    status: r.status as ScoutJob["status"],
    phase: (r.phase as string | null) ?? null,
    detail: (r.detail as string | null) ?? null,
    progress_n: r.progress_n != null ? Number(r.progress_n) : null,
    progress_of: r.progress_of != null ? Number(r.progress_of) : null,
    token: (r.token as ScoutToken | null) ?? null,
    wallets: Array.isArray(r.wallets) ? r.wallets as ScoutWallet[] : null,
    fills_n: r.fills_n != null ? Number(r.fills_n) : null,
    notes: Array.isArray(r.notes) ? r.notes as string[] : null,
    error: (r.error as string | null) ?? null,
    created_at: new Date(r.created_at as string | Date).toISOString(),
    updated_at: new Date(r.updated_at as string | Date).toISOString(),
  };
}

const JSONB_KEYS = new Set(["token", "wallets", "notes"]);

/** Drop fill tape from API payloads. Enrich still reads it from the job row. */
export function publicScoutJob(job: ScoutJob): ScoutJob {
  if (!job.wallets) return job;
  return { ...job, wallets: job.wallets.map((w) => ({ ...w, tape: [] })) };
}

async function patch(id: number, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const values = keys.map((k) => JSONB_KEYS.has(k) ? sqlJson(fields[k]) : fields[k]);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await pool.query(
    `UPDATE scout_jobs SET ${sets}, updated_at = NOW() WHERE id = $1`,
    [id, ...values],
  );
  emitSse("scout:update", { id });
}

export async function getScoutJob(id: number): Promise<ScoutJob | null> {
  const r = await pool.query(`SELECT * FROM scout_jobs WHERE id = $1`, [id]);
  if (!r.rows[0]) return null;
  return rowToJob(r.rows[0] as Record<string, unknown>);
}

export async function startScoutJob(mintRaw: string): Promise<ScoutJob> {
  const mint = mintRaw.trim();
  if (!MINT_RE.test(mint)) throw new Error("invalid solana mint");
  const ins = await pool.query(
    `INSERT INTO scout_jobs (mint, status, phase, detail) VALUES ($1,'queued','queued','Waiting to start')
     RETURNING *`,
    [mint],
  );
  const job = rowToJob(ins.rows[0] as Record<string, unknown>);
  void scoutTick();
  return job;
}

async function runJob(job: ScoutJob): Promise<void> {
  const on = async (phase: string, detail: string, n?: number, of?: number) => {
    await patch(job.id, {
      status: "running", phase, detail,
      progress_n: n ?? null, progress_of: of ?? null,
    });
  };

  if (!(await heliusKey())) {
    throw new Error("Helius key required — add it in Settings. Dex/pump/Gecko still need it for pool history and holders.");
  }

  await on("meta", "Token metadata");
  const token = await loadScoutToken(job.mint);
  await patch(job.id, { token, notes: token.notes });

  await on("holders", "Current holders");
  const holders = await loadHolders(job.mint, token.decimals, (p, d, n, o) => { void on(p, d, n, o); });
  const bal = new Map(holders.map((h) => [h.owner, h.amount]));
  const skip = skipSet(token);

  const fills: TokenFill[] = [];
  if (token.launchpad === "pump.fun" || job.mint.toLowerCase().endsWith("pump")) {
    fills.push(...await loadPumpTrades(token, (p, d, n, o) => { void on(p, d, n, o); }));
  }
  const pools = new Set<string>();
  if (token.bondingCurve) pools.add(token.bondingCurve);
  if (token.pairAddress) pools.add(token.pairAddress);
  for (const addr of pools) {
    fills.push(...await loadPoolTxs(token, addr, (p, d, n, o) => { void on(p, d, n, o); }));
  }
  if (token.pairAddress) {
    fills.push(...await loadGeckoTrades(token));
  }

  await on("gmgn", "GMGN token tape");
  let gmgn;
  try {
    gmgn = await loadGmgnTokenTape(job.mint, skip, (p, d, n, o) => { void on(p, d, n, o); });
  } catch (err) {
    logger.warn({ err, mint: job.mint.slice(0, 8) }, "gmgn token tape failed");
    gmgn = {
      fills: [] as TokenFill[],
      labels: new Map<string, string[]>(),
      discovered: [] as string[],
      notes: ["GMGN tape failed; continuing with on-chain fills only."],
      routes: {},
    };
  }
  const labels = new Map(gmgn.labels);
  let merged = mergeFillGaps(fills, gmgn.fills);

  const have = new Set(merged.map((f) => f.wallet));
  const thin = gmgn.discovered.filter((w) => !skip.has(w) && !have.has(w)).slice(0, ACTIVITY_CAP);
  let activityWallets = 0;
  const activityFills: TokenFill[] = [];
  for (let i = 0; i < thin.length; i++) {
    const w = thin[i];
    await on("gmgn", `GMGN activity ${w.slice(0, 4)}…`, i + 1, thin.length);
    try {
      const act = await loadGmgnWalletActivity(w, job.mint, skip);
      if (act.fills.length) {
        activityFills.push(...act.fills);
        activityWallets += 1;
      }
      if (act.labels.length) labels.set(w, mergeLabels(labels.get(w), act.labels));
    } catch (err) {
      logger.debug({ err, wallet: w.slice(0, 6) }, "gmgn activity failed");
    }
  }
  merged = mergeFillGaps(merged, activityFills);

  await on("mc", "OHLCV market-cap stamps");
  const candles = token.pairAddress ? await loadOhlcv(token.pairAddress) : [];
  const stamped = stampMc(merged, candles, token.supply);

  await on("score", "Cycles and ROI");
  const grouped = new Map<string, TokenFill[]>();
  for (const f of stamped) {
    if (skip.has(f.wallet)) continue;
    const arr = grouped.get(f.wallet) ?? [];
    arr.push(f);
    grouped.set(f.wallet, arr);
  }
  for (const w of labels.keys()) {
    if (skip.has(w) || grouped.has(w)) continue;
    grouped.set(w, []);
  }

  const books: ScoutWallet[] = [];
  for (const [wallet, wf] of grouped) {
    const tag = labels.get(wallet) ?? [];
    if (!wf.length && !tag.length) continue;
    books.push(bookWallet(wallet, wf, {
      balance: bal.get(wallet) ?? null,
      priceUsd: token.priceUsd,
      supply: token.supply,
      labels: tag,
    }));
  }
  const ranked = rankWallets(books.filter((w) =>
    w.investedUsd > 0 || w.proceedsUsd > 0 || w.remainingTokens > 0 || w.labels.length > 0,
  )).slice(0, 500);

  const gmgnFills = stamped.filter((f) => f.src === "gmgn").length;
  const notes = [
    ...(token.notes ?? []),
    `Reconstructed ${stamped.length} fills across ${ranked.length} wallets (cap 500).`,
    candles.length
      ? `Gecko OHLCV: ${candles.length} 5m candles for MC interpolation.`
      : "No OHLCV — pump curve MC used when reserves printed; other fills may lack MC.",
    "Gecko public trades are last-24h only and merged by signature.",
    ...gmgn.notes,
    activityWallets
      ? `GMGN wallet activity gap-filled ${activityWallets}/${thin.length} thin wallets.`
      : thin.length
        ? "GMGN wallet activity added no extra this-token fills (blocked or empty)."
        : "No thin GMGN wallets needed activity gap-fill.",
    `${gmgnFills} fills are GMGN gap-fill (src gmgn). ROI / averages / cycles are reconstructed from the merged fill list — GMGN PnL is ignored.`,
  ];

  await patch(job.id, {
    status: "done",
    phase: "done",
    detail: `Ranked ${ranked.length} wallets`,
    token,
    wallets: ranked,
    fills_n: stamped.length,
    notes,
    progress_n: ranked.length,
    progress_of: ranked.length,
  });
}

export async function scoutTick(): Promise<{ ran: number }> {
  if (running) return { ran: 0 };
  running = true;
  try {
    const r = await pool.query(
      `SELECT * FROM scout_jobs
       WHERE status IN ('queued','running')
       ORDER BY id ASC LIMIT 1`,
    );
    const row = r.rows[0];
    if (!row) return { ran: 0 };
    const job = rowToJob(row as Record<string, unknown>);
    try {
      await runJob(job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "scout failed";
      logger.warn({ err, id: job.id }, "scout job failed");
      await patch(job.id, { status: "error", phase: "error", detail: msg, error: msg });
    }
    return { ran: 1 };
  } catch (err) {
    logger.warn({ err }, "scout tick failed");
    return { ran: 0 };
  } finally {
    running = false;
    const more = await pool.query(
      `SELECT id FROM scout_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1`,
    ).catch(() => ({ rows: [] as Array<{ id: number }> }));
    if (more.rows[0]) void scoutTick();
  }
}

export async function enrichScoutWallet(jobId: number, wallet: string): Promise<ScoutJob> {
  const job = await getScoutJob(jobId);
  if (!job) throw new Error("job not found");
  if (job.status !== "done" || !job.wallets) throw new Error("job not finished");
  const row = job.wallets.find((w) => w.wallet === wallet);
  if (!row) throw new Error("wallet not in this scout");
  const skip = job.token ? skipSet(job.token) : new Set<string>();
  const { labels, note } = await gmgnWalletLabels(wallet);
  const act = await loadGmgnWalletActivity(wallet, job.mint, skip);
  const merged = mergeFillGaps(expandTape(wallet, row.tape), act.fills);
  const book = bookWallet(wallet, merged, {
    balance: row.balance,
    priceUsd: job.token?.priceUsd ?? null,
    supply: job.token?.supply ?? null,
    labels: mergeLabels(row.labels, [...labels, ...act.labels]),
  });
  const wallets = job.wallets.map((w) => w.wallet === wallet ? book : w);
  const notes = [...(job.notes ?? [])];
  if (note) notes.push(note);
  if (act.note && !act.fills.length) notes.push(act.note);
  if (act.fills.length) notes.push(`Enrich ${wallet.slice(0, 4)}… added ${act.fills.length} GMGN this-token fills; ROI rebuilt from the merged tape.`);
  const added = Math.max(0, book.legs - (row.tape?.length ?? 0));
  await patch(jobId, { wallets, notes, fills_n: (job.fills_n ?? 0) + added });
  return (await getScoutJob(jobId))!;
}
