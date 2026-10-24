import {runtimeConfig} from './settings.ts';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { pool } from './db.ts';
import { claimJob,enqueue,failJob,finishJob,recoverJobs } from './queue.ts';
import { researchToken } from './research.ts';
import { enrichToken,deliverAlert,reconcileWallet } from './providers.ts';
let sharedWorkerId=process.env.WORKER_ID;
function getWorkerId(){return sharedWorkerId??=randomUUID();}
export async function runOne(database:pg.Pool=pool):Promise<boolean> {
 const workerId=getWorkerId();
 await database.query(`INSERT INTO hunter.worker_heartbeat(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET updated_at=now(),last_error=NULL`,[workerId]);
 const job=await claimJob(database);
 if(!job)return false;
 try {
  // Re-check after lease claim so a recently activated STOP_ALL blocks new calls.
  const mode=(await database.query('SELECT mode FROM hunter.operator_state WHERE singleton=true')).rows[0].mode;
  if(mode==='STOP_ALL')throw new Error('OperatorStopped');
  switch(job.kind){
   case 'alert': await deliverAlert(database,String(job.payload.alertId??'')); break;
   case 'enrich':
    if(!job.mint)throw new Error('MissingMint');
    await enrichToken(database,job.mint);
    if(mode==='FULL')await enqueue('research',job.mint,{},`research:${job.mint}`,database);break;
   case 'research': if(!job.mint)throw new Error('MissingMint');await researchToken(database,job.mint);break;
   case 'reconcile': await reconcileWallet(database,String(job.payload.address??''));break;
   case 'retention':case 'maintenance':
    await database.query("UPDATE hunter.source_document SET payload=NULL WHERE expires_at<now() AND payload IS NOT NULL");
    await database.query("DELETE FROM hunter.investigation_job WHERE status='done' AND finished_at<now()-interval '7 days'");
    await database.query("DELETE FROM hunter.worker_heartbeat WHERE updated_at<now()-interval '1 day'");break;
   default: throw new Error('UnsupportedJobKind');
  }
  await finishJob(job,database);
 }catch(error){
  await failJob(job,error,database);
  await database.query('UPDATE hunter.worker_heartbeat SET last_error=$2 WHERE id=$1',[workerId,error instanceof Error?error.name:'UnknownError']);
 }
 return true;
}
export async function schedule(database:pg.Pool=pool) {
 const mode=(await database.query('SELECT mode FROM hunter.operator_state WHERE singleton=true')).rows[0].mode;
 if(mode==='STOP_ALL')return;
 await recoverJobs(database);
 const config=await runtimeConfig(database);
 if(config.HELIUS_API_KEY){
  const count=Number((await database.query('SELECT count(*) FROM hunter.watched_wallet WHERE active')).rows[0].count);
  const interval=pollIntervalSeconds(count,config);
  const wallets=(await database.query("SELECT address FROM hunter.watched_wallet WHERE active AND (last_success_at IS NULL OR last_success_at<now()-make_interval(secs=>$1::int)) ORDER BY last_success_at NULLS FIRST LIMIT 20",[interval])).rows;
  for(const {address} of wallets)await enqueue('reconcile',null,{address},`reconcile:${address}`,database);
 }
 if(['FULL','WATCH_ONLY'].includes(mode)){
  const due=(await database.query("SELECT mint FROM hunter.token t WHERE (enrichment_checked_at IS NULL OR enrichment_checked_at<now()-interval '1 hour') AND NOT EXISTS(SELECT 1 FROM hunter.investigation_job j WHERE j.mint=t.mint AND j.kind='enrich' AND j.status IN('queued','running','dead')) ORDER BY enrichment_checked_at NULLS FIRST LIMIT 10")).rows;
  for(const {mint} of due)await enqueue('enrich',mint,{},`metadata-refresh:${mint}`,database);
 }
 if(mode==='FULL'){
  // Existing watched-only discoveries become researchable after opt-in. Dead work
  // stays dead until an explicit operator retry; no scheduler resets its budget.
  const pending=(await database.query(`SELECT t.mint FROM hunter.token t
   WHERE NOT EXISTS(SELECT 1 FROM hunter.decision_version d WHERE d.mint=t.mint)
   AND NOT EXISTS(SELECT 1 FROM hunter.investigation_job j WHERE j.mint=t.mint AND j.kind IN('enrich','research') AND j.status IN('queued','running','dead'))
   ORDER BY t.discovered_at LIMIT 20`)).rows;
  for(const row of pending)await enqueue('enrich',row.mint,{},`enrich:${row.mint}:initial`,database);
 }
 await enqueue('retention',null,{},`retention:${new Date().toISOString().slice(0,10)}`,database);
}
export function startWorker(database:pg.Pool=pool) {
 let stopping=false;
 let wake:ReturnType<typeof setTimeout>|undefined;
 let wakeResolve:(()=>void)|undefined;
 const done=(async()=>{
  let lastSchedule=0;
  while(!stopping){
   try{if(Date.now()-lastSchedule>60000){await schedule(database);lastSchedule=Date.now();}const worked=await runOne(database);if(worked)continue;}
   catch(error){console.error('Hunter worker iteration failed',{type:error instanceof Error?error.name:'UnknownError'});}
   await new Promise<void>(resolve=>{wakeResolve=resolve;wake=setTimeout(resolve,1000);});
  }
 })();
 return {stop:async()=>{stopping=true;if(wake)clearTimeout(wake);wakeResolve?.();/* let in-flight bounded task finish */ await Promise.race([done,new Promise(resolve=>setTimeout(resolve,2500))]);}};
}

/** Split half of the local request allowance to polling; reserve the rest for metadata.
 * This is a request budget, not a claim about Helius free-tier credit entitlement. */
export function pollIntervalSeconds(wallets:number,config:Record<string,string|undefined>){
 const daily=Number(config.HELIUS_DAILY_REQUEST_CAP??500),monthly=Number(config.HELIUS_MONTHLY_REQUEST_CAP??10000);
 const allowance=Math.min(Number.isFinite(daily)?daily:500,(Number.isFinite(monthly)?monthly:10000)/31);
 if(allowance<=0)return 86400;
 return Math.min(2147483647,Math.max(120,Math.ceil(Math.max(1,wallets)*2*86400/(allowance*0.5))));
}
