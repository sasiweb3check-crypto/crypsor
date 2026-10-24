import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fixtureFetch,fixtureMint} from './flow-fixtures.mjs';
const url=new URL(process.env.TEST_DATABASE_URL||'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/hunter_pilot_test')throw new Error('Isolated test database required');
process.env.DATABASE_URL=url.toString();delete process.env.AIVEN_DATABASE_URL;
process.env.HUNTER_API_TOKEN='synthetic-flow-test-api-token-12345';process.env.HELIUS_API_KEY='synthetic-flow-test-key';process.env.TELEGRAM_ENABLED='false';
const {pool,initialize}=await import('../artifacts/api-server/src/db.ts');
const {ingestTransactions}=await import('../artifacts/api-server/src/ingest.ts');
const {runOne,pollIntervalSeconds}=await import('../artifacts/api-server/src/worker.ts');
const {enqueue,claimJob,failJob}=await import('../artifacts/api-server/src/queue.ts');
const {enrichToken}=await import('../artifacts/api-server/src/providers.ts');
let requests:string[]=[];const original=globalThis.fetch;
before(async()=>{await pool.query('DROP SCHEMA IF EXISTS hunter CASCADE');await initialize();globalThis.fetch=async(input:any,init:any)=>{requests.push(String(input).includes('helius-rpc')?JSON.parse(init.body).method:'dex');return fixtureFetch(input,init);};});
after(async()=>{globalThis.fetch=original;await pool.end();});
test('Watch Only discovery flows through jobs into populated identity, price, image and explicit readiness',async()=>{
 const wallet='1'.repeat(32);await pool.query('INSERT INTO hunter.watched_wallet(address) VALUES($1)',[wallet]);
 await ingestTransactions(pool,[{signature:'s'.repeat(88),feePayer:wallet,events:{swap:{nativeInput:{account:wallet,amount:'1'},tokenOutputs:[{mint:fixtureMint,userAccount:wallet,rawTokenAmount:{tokenAmount:'1',decimals:6}}]}}}]);
 await runOne(pool);await runOne(pool);
 const token=(await pool.query('SELECT * FROM hunter.token WHERE mint=$1',[fixtureMint])).rows[0];
 assert.equal(token.name,'Synthetic Flow Token');assert.equal(token.symbol,'TEST');assert.equal(token.price_usd,'0.25');assert.ok(token.image_uri);assert.ok(token.description);assert.equal(token.enrichment_state,'ready');assert.equal(token.risk,'UNASSESSED');assert.equal(token.priority,'LOW');assert.deepEqual(token.coverage.missing_fields,[]);
 assert.ok(!requests.includes('getTokenLargestAccounts'),'Watch Only must not spend requests on deep holder research');
 const count=requests.length;await enrichToken(pool,fixtureMint);assert.equal(requests.length,count,'fresh source cache should avoid redundant requests');
});
test('polling scales with wallet count and reserves half of request allowance',()=>{
 const one=pollIntervalSeconds(1,{}),twenty=pollIntervalSeconds(20,{});assert.ok(twenty>=one*19);
 assert.ok(20*2*86400/twenty<=Math.min(500,10000/31)*0.5+1);
 assert.equal(pollIntervalSeconds(1,{HELIUS_DAILY_REQUEST_CAP:'0'}),86400);
});
test('quota exhaustion defers jobs without consuming terminal retry attempts',async()=>{
 await enqueue('reconcile',null,{address:'1'.repeat(32)},'quota-fixture',pool);
 const job=await claimJob(pool);assert.ok(job);
 await pool.query('UPDATE hunter.investigation_job SET attempts=max_attempts WHERE id=$1',[job.id]);
 await failJob(job,Object.assign(new Error('cap'),{code:'REQUEST_CAP_EXHAUSTED'}),pool);
 const row=(await pool.query('SELECT * FROM hunter.investigation_job WHERE id=$1',[job.id])).rows[0];assert.equal(row.status,'queued');assert.ok(row.attempts<row.max_attempts);assert.ok(new Date(row.run_after).getTime()>Date.now()+3500000);
});
