import {test} from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {createWorker,type Env,type Envelope,type Message} from './worker.ts';
const secret='test-secret-only-not-a-real-key-32';
function setup(mode='WATCH_ONLY') {
  const sent:Envelope[]=[];
  const sql:string[]=[];
  let ingests=0,runs=0,ended=0,recoveries=0;
  const pool={query:async(query:string)=>{sql.push(query);return {rows:query.includes('SELECT mode')?[{mode}]:[]};},end:async()=>{ended++;}} as unknown as pg.Pool;
  const env:Env={HYPERDRIVE:{connectionString:'postgresql://test.invalid'},HELIUS_WEBHOOK_SECRET:secret,HUNTER_API_TOKEN:secret,EVENT_QUEUE:{send:async body=>{sent.push(body);}}};
  const worker=createWorker({createPool:()=>pool,ingest:async()=>{ingests++;return{accepted:1,duplicates:0,ignored:0};},runOne:async()=>{runs++;return true;},recover:async()=>{recoveries++;}});
  return {worker,env,sent,sql,counts:()=>({ingests,runs,ended,recoveries})};
}
function request(body:unknown=[{signature:'fixture_signature'}],authorization=secret):Request {
  return new Request('https://hunter.invalid/webhooks/helius',{method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(body)});
}
function message(body:unknown) {
  let acks=0,retries=0;
  const item:Message={body,ack(){acks++;},retry(){retries++;}};
  return{item,counts:()=>({acks,retries})};
}
test('ingress rejects unauthorized requests before connecting to the database',async()=>{
  const s=setup();assert.equal((await s.worker.fetch(request(undefined,'wrong'),s.env)).status,401);assert.equal(s.sql.length,0);assert.equal(s.sent.length,0);
});
test('ingress only accepts small valid enhanced transaction batches',async()=>{
  const s=setup();assert.equal((await s.worker.fetch(request({signature:'fixture'}),s.env)).status,400);assert.equal((await s.worker.fetch(request([]),s.env)).status,400);assert.equal((await s.worker.fetch(request(Array.from({length:11},()=>({signature:'fixture'}))),s.env)).status,400);assert.equal(s.sent.length,0);
});
test('malformed and oversized streamed requests do not enqueue',async()=>{
  const s=setup();
  for(const [body,status] of [['{',400],['x'.repeat(100000),413]] as const){
    const r=new Request('https://hunter.invalid/webhooks/helius',{method:'POST',headers:{Authorization:secret,'Content-Type':'application/json'},body});
    assert.equal((await s.worker.fetch(r,s.env)).status,status);
  }
  assert.equal(s.sent.length,0);
});
test('STOP_ALL refuses ingress without enqueueing',async()=>{
  const s=setup('STOP_ALL');assert.equal((await s.worker.fetch(request(),s.env)).status,503);assert.equal(s.sent.length,0);
});
test('valid delivery acknowledged only after queue acceptance',async()=>{
  const s=setup();assert.equal((await s.worker.fetch(request(),s.env)).status,202);assert.equal(s.sent.length,1);assert.equal(s.sent[0].kind,'events');assert.equal(s.counts().ingests,0);assert.equal(s.counts().ended,1);
});
test('queue rejection results in retriable ingress response',async()=>{
  const s=setup();s.env.EVENT_QUEUE.send=async()=>{throw Error('fixture queue unavailable');};assert.equal((await s.worker.fetch(request(),s.env)).status,503);
});
test('health requires private bearer token and returns live mode',async()=>{
  const s=setup('STOP_ALL');const r=(auth:string)=>new Request('https://hunter.invalid/healthz',{headers:{Authorization:auth}});
  assert.equal((await s.worker.fetch(r(secret),s.env)).status,401);
  const response=await s.worker.fetch(r(`Bearer ${secret}`),s.env);assert.deepEqual(await response.json(),{ok:true,accepting:false});
});
test('queue acknowledges after durable ingestion and schedules bounded background tick',async()=>{
  const s=setup();const m=message({kind:'events',receivedAt:new Date().toISOString(),transactions:[{signature:'fixture'}]});
  await s.worker.queue({messages:[m.item]},s.env);assert.deepEqual(m.counts(),{acks:1,retries:0});assert.equal(s.counts().ingests,1);assert.deepEqual(s.sent,[{kind:'tick'}]);
});
test('queue retries on persistence failure without ack',async()=>{
  const s=setup();const worker=createWorker({createPool:()=>({query:async()=>({rows:[{mode:'WATCH_ONLY'}]}),end:async()=>{}} as unknown as pg.Pool),ingest:async()=>{throw Error('fixture DB error');}});
  const m=message({kind:'events',receivedAt:new Date().toISOString(),transactions:[{signature:'fixture'}]});await worker.queue({messages:[m.item]},s.env);assert.deepEqual(m.counts(),{acks:0,retries:1});
});
test('STOP_ALL retries queued messages without ingest or job execution',async()=>{
  const s=setup('STOP_ALL');const m=message({kind:'tick'});await s.worker.queue({messages:[m.item]},s.env);assert.deepEqual(m.counts(),{acks:0,retries:1});assert.equal(s.counts().runs,0);
});
test('malformed queue envelope reaches configured retries and dead-letter path',async()=>{
  const s=setup();const m=message({arbitrary:true});await s.worker.queue({messages:[m.item]},s.env);assert.deepEqual(m.counts(),{acks:0,retries:1});assert.equal(s.counts().ingests,0);
});
test('a tick recovers leases and executes at most one bounded job',async()=>{
  const s=setup();const m=message({kind:'tick'});await s.worker.queue({messages:[m.item]},s.env);assert.equal(s.counts().runs,1);assert.equal(s.counts().recoveries,1);assert.equal(m.counts().acks,1);
});
test('cron obeys STOP_ALL before scheduling',async()=>{
  const s=setup('STOP_ALL');await s.worker.scheduled({},s.env,{waitUntil(){}});assert.equal(s.sql.length,1);assert.equal(s.sent.length,0);
});

test('mode switch between preflight and ingestion retries rather than discarding events',async()=>{
  const s=setup();const worker=createWorker({createPool:()=>({query:async()=>({rows:[{mode:'WATCH_ONLY'}]}),end:async()=>{}} as unknown as pg.Pool),ingest:async()=>({accepted:0,duplicates:0,ignored:0,stopped:true})});
  const m=message({kind:'events',receivedAt:new Date().toISOString(),transactions:[{signature:'fixture'}]});await worker.queue({messages:[m.item]},s.env);assert.deepEqual(m.counts(),{acks:0,retries:1});assert.equal(s.sent.length,0);
});
