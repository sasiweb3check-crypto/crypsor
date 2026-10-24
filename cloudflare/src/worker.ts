import pg from 'pg';
import {timingSafeEqual} from 'node:crypto';
import {ingestTransactions} from '../../artifacts/api-server/src/ingest.ts';
import {runOne,schedule} from '../../artifacts/api-server/src/worker.ts';
import {recoverJobs} from '../../artifacts/api-server/src/queue.ts';

// These are the small runtime contracts used here, not a simulated Worker runtime.
export interface QueueBinding { send(body: Envelope, options?: {contentType: 'json'}): Promise<void> }
export interface Env {
  HYPERDRIVE: { connectionString: string };
  EVENT_QUEUE: QueueBinding;
  HELIUS_WEBHOOK_SECRET: string;
  HUNTER_API_TOKEN: string;
}
export type Envelope = {kind:'events';receivedAt:string;transactions:unknown[]} | {kind:'tick'};
export interface Message { body:unknown; ack():void; retry(options?:{delaySeconds:number}):void }
export interface Batch { messages:Message[] }
export interface Context { waitUntil(promise:Promise<unknown>):void }
export interface Dependencies {
  createPool(env:Env):pg.Pool;
  ingest(pool:pg.Pool, transactions:unknown[], options:{source:string}):Promise<{accepted:number;duplicates:number;ignored:number;stopped?:boolean}>;
  runOne(pool:pg.Pool):Promise<boolean>;
  recover(pool:pg.Pool):Promise<unknown>;
  schedule(pool:pg.Pool):Promise<unknown>;
}
const MAX_BYTES=96*1024;
const MAX_TRANSACTIONS=10;
const defaults:Dependencies={
  createPool:env=>new pg.Pool({connectionString:env.HYPERDRIVE.connectionString,max:1,idleTimeoutMillis:1000,connectionTimeoutMillis:10000,statement_timeout:15000}),
  ingest:ingestTransactions,
  runOne,
  recover:recoverJobs,
  schedule,
};
function authorized(request:Request, secret:string|undefined):boolean {
  if (!secret || secret.length<24) return false;
  const actual=Buffer.from(request.headers.get('Authorization')??'');
  const expected=Buffer.from(secret);
  return actual.length===expected.length && timingSafeEqual(actual,expected);
}
function privateAuthorized(request:Request, secret:string|undefined):boolean {
  if (!secret || secret.length<24) return false;
  return authorized(request,`Bearer ${secret}`);
}
function response(status:number,body:Record<string,unknown>):Response {
  return Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
async function readBounded(request:Request):Promise<unknown> {
  const length=Number(request.headers.get('Content-Length')??0);
  if (!Number.isFinite(length)||length>MAX_BYTES) throw new Error('Payload too large');
  if (!request.body) throw new Error('Empty payload');
  const reader=request.body.getReader();
  const chunks:Uint8Array[]=[];
  let size=0;
  while(true) {
    const {done,value}=await reader.read();
    if (done) break;
    size+=value.byteLength;
    if(size>MAX_BYTES) {await reader.cancel();throw new Error('Payload too large');}
    chunks.push(value);
  }
  const bytes=new Uint8Array(size);
  let offset=0;
  for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
function transactions(body:unknown):unknown[]|null {
  if(!Array.isArray(body)||body.length<1||body.length>MAX_TRANSACTIONS) return null;
  if(body.some(t=>!t||typeof t!=='object'||Array.isArray(t)||typeof t.signature!=='string'||t.signature.length<1||t.signature.length>128)) return null;
  return body;
}
function envelope(body:unknown):Envelope|null {
  if(!body||typeof body!=='object') return null;
  const item=body as Record<string,unknown>;
  if(item.kind==='tick') return {kind:'tick'};
  if(item.kind==='events'&&typeof item.receivedAt==='string'&&Number.isFinite(Date.parse(item.receivedAt))) {
    const txs=transactions(item.transactions);
    if(txs) return {kind:'events',receivedAt:item.receivedAt,transactions:txs};
  }
  return null;
}
async function stopped(pool:pg.Pool):Promise<boolean> {
  const state=await pool.query('SELECT mode FROM hunter.operator_state WHERE singleton=true');
  if(!state.rows[0]) throw new Error('Operator state missing');
  return state.rows[0].mode==='STOP_ALL';
}
async function usingPool<T>(env:Env,deps:Dependencies,fn:(pool:pg.Pool)=>Promise<T>):Promise<T> {
  const pool=deps.createPool(env);
  try{return await fn(pool);}finally{await pool.end();}
}

export function createWorker(overrides:Partial<Dependencies>={}) {
  const deps={...defaults,...overrides};
  return {
    async fetch(request:Request,env:Env):Promise<Response> {
      const path=new URL(request.url).pathname;
      if(path==='/healthz') {
        if(!privateAuthorized(request,env.HUNTER_API_TOKEN)) return response(401,{error:'Unauthorized'});
        try {
          return await usingPool(env,deps,async pool=>response(200,{ok:true,accepting:!await stopped(pool)}));
        }catch{return response(503,{ok:false,error:'Database unavailable'});}
      }
      if(path!=='/webhooks/helius') return response(404,{error:'Not found'});
      if(request.method!=='POST') return response(405,{error:'POST required'});
      // Helius sends the configured Authorization string, not a per-request HMAC.
      if(!authorized(request,env.HELIUS_WEBHOOK_SECRET)) return response(401,{error:'Unauthorized'});
      if(!(request.headers.get('Content-Type')??'').toLowerCase().startsWith('application/json')) return response(415,{error:'application/json required'});
      let body:unknown;
      try {body=await readBounded(request);}catch(error) {
        return response(error instanceof Error&&error.message==='Payload too large'?413:400,{error:'Invalid or oversized JSON payload'});
      }
      const txs=transactions(body);
      if(!txs) return response(400,{error:'Expected 1–10 enhanced transactions with signatures'});
      try {
        const isStopped=await usingPool(env,deps,pool=>stopped(pool));
        if(isStopped) return response(503,{error:'STOP_ALL is active'});
        // Acknowledge only after Cloudflare durably accepted this message.
        await env.EVENT_QUEUE.send({kind:'events',receivedAt:new Date().toISOString(),transactions:txs},{contentType:'json'});
        return response(202,{accepted:txs.length});
      }catch{return response(503,{error:'Intake unavailable; retry delivery'});}
    },
    async queue(batch:Batch,env:Env):Promise<void> {
      // max_batch_size=1 bounds normalization and database contention per invocation.
      for(const message of batch.messages) {
        const item=envelope(message.body);
        if(!item) {message.retry({delaySeconds:60});continue;}
        try {
          const canAck=await usingPool(env,deps,async pool=>{
            if(await stopped(pool)) return false;
            if(item.kind==='events') {
              const result=await deps.ingest(pool,item.transactions,{source:'helius-webhook'});
              if(result.stopped) return false;
              // Durable alert/research jobs are handled by separate, bounded invocations.
              await env.EVENT_QUEUE.send({kind:'tick'},{contentType:'json'});
            }else{
              await deps.recover(pool);
              await deps.runOne(pool);
            }
            return true;
          });
          if(canAck) message.ack();else message.retry({delaySeconds:300});
        }catch {message.retry({delaySeconds:60});}
      }
    },
    async scheduled(_controller:unknown,env:Env,_context:Context):Promise<void> {
      await usingPool(env,deps,async pool=>{
        if(await stopped(pool)) return;
        await deps.recover(pool);
        // Shared scheduler pages from durable wallet cursors, queues due revisits,
        // and schedules retention. It never migrates the database in the Worker.
        await deps.schedule(pool);
        // Queue one lightweight dispatch per due job, up to a bounded pilot-sized batch.
        const due=await pool.query("SELECT id FROM hunter.investigation_job WHERE status='queued' AND run_after<=now() ORDER BY run_after LIMIT 20");
        for(const _job of due.rows) await env.EVENT_QUEUE.send({kind:'tick'},{contentType:'json'});
      });
    },
  };
}
export default createWorker();
