import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pool, type Queryable } from './db.ts';
export type Job = {id:string;kind:string;mint:string|null;payload:Record<string,unknown>;attempts:number;max_attempts:number;lease_token:string;};
export async function enqueue(kind:string,mint:string|null,payload:Record<string,unknown>={},dedupeKey?:string,database:Queryable=pool) {
 return (await database.query(`INSERT INTO hunter.investigation_job(kind,mint,payload,dedupe_key) VALUES($1,$2,$3,$4)
 ON CONFLICT(dedupe_key) DO UPDATE SET status='queued',payload=EXCLUDED.payload,attempts=0,run_after=now(),finished_at=NULL,last_error=NULL
 WHERE hunter.investigation_job.status='done' RETURNING *`,[kind,mint,payload,dedupeKey??null])).rows[0];
}
export async function claimJob(database:pg.Pool=pool):Promise<Job|undefined> {
 const token=randomUUID();
 const result=await database.query(`UPDATE hunter.investigation_job SET status='running',attempts=attempts+1,lease_until=now()+interval '120 seconds',lease_token=$1
 WHERE id=(SELECT j.id FROM hunter.investigation_job j CROSS JOIN hunter.operator_state o
 WHERE j.status='queued' AND j.run_after<=now() AND o.singleton AND o.mode<>'STOP_ALL'
 AND (o.mode='FULL' OR j.kind IN('alert','reconcile','parse_transaction','prices','retention','maintenance') OR (o.mode='WATCH_ONLY' AND j.kind='enrich')) ORDER BY CASE WHEN j.kind IN('reconcile','parse_transaction') THEN 0 WHEN j.kind='prices' THEN 1 WHEN j.kind='alert' THEN 2 ELSE 3 END,j.run_after,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING *`,[token]);
 return result.rows[0];
}
export async function finishJob(job:Job,database:Queryable=pool) {
 return (await database.query("UPDATE hunter.investigation_job SET status='done',finished_at=now(),lease_until=NULL,lease_token=NULL WHERE id=$1 AND status='running' AND lease_token=$2 RETURNING id",[job.id,job.lease_token])).rowCount===1;
}
export async function failJob(job:Job,error:unknown,database:Queryable=pool) {
 // Provider messages may include credential-bearing URLs. Store a classification only.
 const candidate=(error as {code?:unknown})?.code;
 const safe=typeof candidate==='string'&&/^[A-Z][A-Z0-9_]{0,100}$/.test(candidate)?candidate:error instanceof Error?error.name:'UnknownError';
 const requested=Number((error as {retryAfterSeconds?:unknown})?.retryAfterSeconds);
 const quota=['REQUEST_CAP_EXHAUSTED','TOKEN_AI_CAP_EXHAUSTED','PROVIDER_HTTP_429','PROVIDER_RATE_LIMIT'].includes(safe);
 const retryAfter=quota?3600:Number.isFinite(requested)?Math.max(0,Math.min(86400,Math.ceil(requested))):0;
 return (await database.query(`UPDATE hunter.investigation_job SET status=CASE WHEN NOT $5::boolean AND attempts>=max_attempts THEN 'dead' ELSE 'queued' END,
 attempts=CASE WHEN $5::boolean THEN GREATEST(0,attempts-1) ELSE attempts END,
 run_after=now()+make_interval(secs=>GREATEST($4::int,LEAST(3600, power(2,LEAST(attempts,10))::int*5))),
 lease_until=NULL,lease_token=NULL,last_error=$3,finished_at=CASE WHEN NOT $5::boolean AND attempts>=max_attempts THEN now() ELSE NULL END
 WHERE id=$1 AND status='running' AND lease_token=$2 RETURNING id`,[job.id,job.lease_token,safe,retryAfter,quota])).rowCount===1;
}
export async function recoverJobs(database:Queryable=pool) {
 const recovered=await database.query(`UPDATE hunter.investigation_job SET status=CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'queued' END,
 lease_until=NULL,lease_token=NULL,run_after=now(),last_error='Expired lease recovered',finished_at=CASE WHEN attempts>=max_attempts THEN now() ELSE NULL END
 WHERE status='running' AND lease_until<now()`);
 await database.query(`UPDATE hunter.alert a SET status='uncertain',last_error='Worker interrupted during delivery; verify Telegram manually before replay'
 WHERE a.status='sending' AND a.created_at<now()-interval '5 minutes'
 AND NOT EXISTS(SELECT 1 FROM hunter.investigation_job j WHERE j.kind='alert' AND j.payload->>'alertId'=a.id AND j.status='running' AND j.lease_until>now())`);
 return recovered;
}
