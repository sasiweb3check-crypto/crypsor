import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { pool } from "../tracking/store.ts";
import { ProviderError } from "../services/providers.ts";
export type Kind =
  "wallet" | "price" | "metadata" | "intelligence" | "maintenance";
export type Job = {
  id: string;
  kind: Kind;
  payload: Record<string, any>;
  lease_token: string;
  attempts: number;
};
export type Result = { again?: boolean; delayMs?: number };
const kinds: Kind[] = [
  "wallet",
  "price",
  "metadata",
  "intelligence",
  "maintenance",
];
const redisUrl = process.env.REDIS_URL;
const connections: IORedis[] = [];
const queues = new Map<Kind, Queue>();
function connection() {
  const c = new IORedis(redisUrl!, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    tls: redisUrl!.startsWith("rediss:")
      ? { rejectUnauthorized: true }
      : undefined,
  });
  c.on("error", () => {});
  connections.push(c);
  return c;
}
export function queue(kind: Kind) {
  let q = queues.get(kind);
  if (!q) {
    q = new Queue(`cw-${kind}`, { connection: connection() as any });
    q.on("error", () => {});
    queues.set(kind, q);
  }
  return q;
}
export async function enqueue(
  kind: Kind,
  key: string,
  payload: Record<string, unknown>,
  priority = 0,
) {
  const result = await pool.query(
    `INSERT INTO cw_jobs(kind,job_key,payload,priority) VALUES($1,$2,$3,$4) ON CONFLICT(job_key) WHERE state IN('queued','running') DO NOTHING RETURNING id`,
    [kind, key, JSON.stringify(payload), priority],
  );
  return result.rows[0]?.id;
}
export async function claim(kind: Kind, id?: string): Promise<Job | null> {
  const token = randomUUID();
  const r = await pool.query(
    `WITH picked AS(SELECT id FROM cw_jobs WHERE kind=$1 AND state='queued' AND available_at<=now() AND($2::bigint IS NULL OR id=$2::bigint) ORDER BY priority DESC,id FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE cw_jobs j SET state='running',lease_until=now()+interval '90 seconds',lease_token=$3,published_at=NULL FROM picked WHERE j.id=picked.id RETURNING j.id::text,j.kind,j.payload,j.lease_token,j.attempts`,
    [kind, id ?? null, token],
  );
  return r.rows[0] ?? null;
}
export async function finish(job: Job, result: Result = {}) {
  await pool.query(
    `UPDATE cw_jobs SET state=$3,available_at=now()+$4*interval '1 millisecond',attempts=0,lease_until=NULL,lease_token=NULL,published_at=NULL,error=NULL,finished_at=CASE WHEN $3='done' THEN now() ELSE NULL END WHERE id=$1 AND lease_token=$2`,
    [
      job.id,
      job.lease_token,
      result.again ? "queued" : "done",
      result.delayMs ?? 0,
    ],
  );
}
export function retryDelay(attempt: number, retryAfter = 0) {
  return (
    Math.max(retryAfter, Math.min(300_000, 1000 * 2 ** Math.min(attempt, 8))) +
    Math.floor(Math.random() * 250)
  );
}
export async function fail(job: Job, error: unknown) {
  const message =
    error instanceof Error ? error.message.slice(0, 240) : "Job failed";
  const delay = retryDelay(
    job.attempts,
    error instanceof ProviderError ? error.retryAfterMs : 0,
  );
  await pool.query(
    `UPDATE cw_jobs SET attempts=attempts+1,state=CASE WHEN attempts+1>=max_attempts THEN 'dead' ELSE 'queued' END,available_at=now()+$3*interval '1 millisecond',lease_until=NULL,lease_token=NULL,published_at=NULL,error=$4,finished_at=CASE WHEN attempts+1>=max_attempts THEN now() END WHERE id=$1 AND lease_token=$2`,
    [job.id, job.lease_token, delay, message],
  );
}
export async function recover() {
  await pool.query(
    `UPDATE cw_jobs SET attempts=attempts+1,state=CASE WHEN attempts+1>=max_attempts THEN 'dead' ELSE 'queued' END,available_at=now(),lease_until=NULL,lease_token=NULL,published_at=NULL,error='Worker lease expired; recovered after restart',finished_at=CASE WHEN attempts+1>=max_attempts THEN now() END WHERE state='running' AND lease_until<now()`,
  );
}
export async function relay() {
  if (!redisUrl) return;
  const rows = (
    await pool.query(
      `SELECT id::text,kind FROM cw_jobs WHERE state='queued' AND available_at<=now() AND(published_at IS NULL OR published_at<now()-interval '60 seconds') ORDER BY priority DESC,id LIMIT 200`,
    )
  ).rows;
  for (const row of rows) {
    await queue(row.kind).add(
      row.kind,
      { id: row.id },
      { jobId: `j${row.id}`, removeOnComplete: true, removeOnFail: 100 },
    );
    await pool.query(
      "UPDATE cw_jobs SET published_at=now() WHERE id=$1 AND state='queued'",
      [row.id],
    );
  }
}
export async function processOne(
  kind: Kind,
  handler: (job: Job) => Promise<Result | void>,
  id?: string,
) {
  const job = await claim(kind, id);
  if (!job) return false;
  const heartbeat = setInterval(
    () =>
      void pool
        .query(
          "UPDATE cw_jobs SET lease_until=now()+interval '90 seconds' WHERE id=$1 AND lease_token=$2",
          [job.id, job.lease_token],
        )
        .catch(() => {}),
    25_000,
  );
  try {
    const result = await handler(job);
    await finish(job, result ?? {});
  } catch (e) {
    await fail(job, e);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
export function consumers(handler: (job: Job) => Promise<Result | void>) {
  let stopping = false;
  const workers: Worker[] = [];
  const loops: Promise<void>[] = [];
  const concurrency: Record<Kind, number> = {
    wallet: Number(process.env.WALLET_CONCURRENCY ?? 4),
    price: 2,
    metadata: 2,
    intelligence: 2,
    maintenance: 1,
  };
  for (const kind of kinds) {
    if (redisUrl) {
      const w = new Worker(
        `cw-${kind}`,
        async (j) => {
          await processOne(kind, handler, String(j.data.id));
        },
        { connection: connection() as any, concurrency: concurrency[kind] },
      );
      w.on("error", () => {});
      workers.push(w);
    } else
      for (let i = 0; i < concurrency[kind]; i++)
        loops.push(
          (async () => {
            while (!stopping) {
              try {
                if (!(await processOne(kind, handler)))
                  await new Promise((r) =>
                    setTimeout(r, Number(process.env.WORKER_IDLE_MS ?? 1000)),
                  );
              } catch {
                await new Promise((r) => setTimeout(r, 1000));
              }
            }
          })(),
        );
  }
  return async () => {
    stopping = true;
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(loops);
  };
}
export async function closeQueue() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  for (const c of connections) c.disconnect();
}
export const backend = redisUrl ? "bullmq" : "postgres";
