import { providerMetrics } from "../services/metrics.ts";
import { archiveReceipts } from "../services/archive.ts";
import { randomUUID } from "node:crypto";
import { pool } from "../tracking/store.ts";
import {
  enqueue,
  recover,
  relay,
  consumers,
  closeQueue,
  backend,
  type Job,
} from "./queue.ts";
import { ingestTransactions } from "../tracking/ingest.ts";
import {
  syncWallet,
  refreshPrices,
  enrichMetadata,
  computeIntelligence,
} from "../tracking/worker.ts";
export const instance = randomUUID();
export async function schedule() {
  const count = Number(
    (
      await pool.query(
        "SELECT count(*) FROM cw_jobs WHERE state IN('queued','running')",
      )
    ).rows[0].count,
  );
  if (count >= 2000) return;
  const blocked = `NOT EXISTS(SELECT 1 FROM cw_jobs j WHERE j.job_key=('wallet:'||w.address) AND (j.state IN('queued','running') OR(j.state='dead' AND j.finished_at>now()-interval '1 hour')))`;
  if (process.env.HELIUS_API_KEY) {
    const wallets = (
      await pool.query(
        `SELECT address FROM cw_wallets w WHERE next_sync_at<=now() AND ${blocked} ORDER BY next_sync_at LIMIT 100`,
      )
    ).rows;
    for (const w of wallets)
      await enqueue(
        "wallet",
        `wallet:${w.address}`,
        { address: w.address },
        10,
      );
  }
  const mints = (
    await pool.query(
      `SELECT mint FROM cw_tokens t WHERE price_due_at<=now() AND NOT EXISTS(SELECT 1 FROM cw_jobs j WHERE j.kind='price' AND (j.state IN('queued','running') OR(j.state='dead' AND j.finished_at>now()-interval '1 hour')) AND j.payload->'mints' ? t.mint) ORDER BY price_due_at LIMIT 300`,
    )
  ).rows.map((t) => t.mint);
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    await enqueue("price", `price:${batch[0]}`, { mints: batch }, 5);
  }
  const metas = (
    await pool.query(
      `SELECT mint FROM cw_tokens t WHERE metadata_due_at<=now() AND NOT EXISTS(SELECT 1 FROM cw_jobs j WHERE j.job_key=('metadata:'||t.mint) AND(j.state IN('queued','running') OR(j.state='dead' AND j.finished_at>now()-interval '1 hour'))) ORDER BY metadata_due_at LIMIT 40`,
    )
  ).rows;
  for (const t of metas)
    await enqueue("metadata", `metadata:${t.mint}`, { mint: t.mint }, 1);
  await enqueue("maintenance", "maintenance", {});
}
export async function maintenance() {
  await recover();
  await pool.query(
    "DELETE FROM cw_jobs WHERE id IN(SELECT id FROM cw_jobs WHERE state IN('done','dead') AND finished_at<now()-interval '7 days' LIMIT 2000)",
  );
  await archiveReceipts();
  await pool.query(
    "DELETE FROM cw_receipts WHERE signature IN(SELECT signature FROM cw_receipts WHERE received_at<now()-interval '7 days' AND($1::boolean=false OR archived=true) AND NOT EXISTS(SELECT 1 FROM cw_jobs j WHERE j.payload->>'receipt'=cw_receipts.signature AND j.state IN('queued','running','dead')) LIMIT 1000)",
    [Boolean(process.env.ARCHIVE_BUCKET)],
  );
  // The legacy price table is retired; preserve its recent records while expiring old samples.
  await pool.query(
    "DELETE FROM cw_prices WHERE id IN(SELECT id FROM cw_prices WHERE at<now()-interval '7 days' LIMIT 1000)",
  );
  await pool.query(
    "DELETE FROM cw_workers WHERE seen_at<now()-interval '7 days'",
  );
}
export async function handle(job: Job) {
  try {
    switch (job.kind) {
      case "wallet":
        if (job.payload.receipt) {
          const receipt = (
            await pool.query(
              "SELECT payload FROM cw_receipts WHERE signature=$1",
              [job.payload.receipt],
            )
          ).rows[0];
          if (receipt)
            await ingestTransactions(String(job.payload.address), [
              receipt.payload,
            ]);
          return;
        }
        return await syncWallet(String(job.payload.address));
      case "price":
        await refreshPrices(job.payload.mints as string[]);
        break;
      case "metadata":
        await enrichMetadata(String(job.payload.mint));
        break;
      case "intelligence":
        await computeIntelligence(String(job.payload.mint));
        break;
      case "maintenance":
        await maintenance();
        return { again: true, delayMs: 60_000 };
    }
    return {};
  } catch (e) {
    if (job.kind === "wallet")
      await pool.query("UPDATE cw_wallets SET sync_error=$2 WHERE address=$1", [
        job.payload.address,
        e instanceof Error ? e.message : "Sync failed",
      ]);
    throw e;
  }
}
export async function startRuntime() {
  const stop = consumers(handle);
  let stopping = false;
  const pulse = async () => {
    if (stopping) return;
    try {
      await recover();
      await schedule();
      await relay();
      await pool.query(
        `INSERT INTO cw_workers(id,details) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET seen_at=now(),details=EXCLUDED.details`,
        [
          instance,
          JSON.stringify({
            backend,
            role: "worker",
            error: null,
            providers: providerMetrics,
          }),
        ],
      );
    } catch (e) {
      await pool
        .query(
          `INSERT INTO cw_workers(id,details) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET seen_at=now(),details=EXCLUDED.details`,
          [
            instance,
            JSON.stringify({
              backend,
              role: "worker",
              providers: providerMetrics,
              error: e instanceof Error ? e.message : "Scheduler failed",
            }),
          ],
        )
        .catch(() => {});
    }
  };
  // One leader schedules globally; multiple consumer processes still claim different jobs safely.
  const scheduler = async () => {
    const c = await pool.connect();
    try {
      const locked = (
        await c.query("SELECT pg_try_advisory_lock(731926) AS ok")
      ).rows[0].ok;
      if (!locked) {
        await pool.query(
          `INSERT INTO cw_workers(id,details) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET seen_at=now(),details=EXCLUDED.details`,
          [
            instance,
            JSON.stringify({
              backend,
              role: "worker",
              error: null,
              providers: providerMetrics,
            }),
          ],
        );
        return;
      }
      try {
        await pulse();
      } finally {
        await c.query("SELECT pg_advisory_unlock(731926)");
      }
    } finally {
      c.release();
    }
  };
  let ticking = false;
  const run = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await scheduler();
    } finally {
      ticking = false;
    }
  };
  await run();
  const timer = setInterval(() => void run().catch(() => {}), 5000);
  return async () => {
    stopping = true;
    clearInterval(timer);
    await stop();
    await closeQueue();
  };
}
export async function trackingStatus() {
  const [jobs, workers, errors, last] = await Promise.all([
    pool.query(
      "SELECT state,count(*)::int AS n,extract(epoch FROM now()-min(created_at))::int AS oldest_seconds FROM cw_jobs WHERE state IN('queued','running','dead') GROUP BY state",
    ),
    pool.query(
      "SELECT id,seen_at,details FROM cw_workers WHERE seen_at>now()-interval '2 minutes' ORDER BY seen_at DESC",
    ),
    pool.query(
      "SELECT kind,error,attempts FROM cw_jobs WHERE error IS NOT NULL AND state IN('queued','dead') ORDER BY id DESC LIMIT 5",
    ),
    pool.query("SELECT max(synced_at) AS at FROM cw_wallets"),
  ]);
  const counts = Object.fromEntries(jobs.rows.map((j) => [j.state, j.n]));
  const workerErrors = workers.rows
    .map((w) => w.details?.error)
    .filter(Boolean);
  return {
    heliusConfigured: Boolean(process.env.HELIUS_API_KEY),
    running: (counts.running ?? 0) > 0,
    lastSync: last.rows[0].at,
    error: workerErrors[0] ?? errors.rows[0]?.error ?? null,
    intervalSeconds: Number(process.env.WALLET_POLL_SECONDS ?? 30),
    backend,
    providers: workers.rows.map((w) => ({
      worker: w.id,
      ...w.details?.providers,
    })),
    workers: workers.rowCount,
    queued: counts.queued ?? 0,
    active: counts.running ?? 0,
    failed: counts.dead ?? 0,
    oldestJobSeconds: Math.max(
      0,
      ...jobs.rows
        .filter((j) => j.state === "queued")
        .map((j) => j.oldest_seconds ?? 0),
    ),
    recentErrors: errors.rows,
    workersHealthy: workers.rows.some((w) => !w.details?.error),
  };
}
