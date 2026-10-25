import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
const target=new URL(process.env.TEST_DATABASE_URL||'');
if(!['127.0.0.1','localhost'].includes(target.hostname)||target.pathname!=='/hunter_pilot_test')throw new Error('Use isolated hunter_pilot_test');
process.env.DATABASE_URL=target.toString();delete process.env.AIVEN_DATABASE_URL;process.env.HUNTER_API_TOKEN='synthetic-report-test-token-1234567';
const {pool,initialize}=await import('../artifacts/api-server/src/db.ts');
const {createApp}=await import('../artifacts/api-server/src/app.ts');
let server:any,base:string;
before(async()=>{await pool.query('DROP SCHEMA IF EXISTS hunter CASCADE');await initialize();server=createApp(pool).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await pool.end();});
test('first report is one compact query; full historical judgments remain available on demand',async()=>{
 await pool.query("INSERT INTO hunter.token(mint) VALUES('synthetic-report')");
 await pool.query("INSERT INTO hunter.decision_version(mint,version,action,thesis,counter_thesis,context) SELECT 'synthetic-report',n,'WATCH','Synthetic fact','Synthetic limitation',jsonb_build_object('observations',repeat('audit fixture ',1000)) FROM generate_series(1,25) n");
 await pool.query("INSERT INTO hunter.evidence_claim(mint,claim,data) SELECT 'synthetic-report','Same measured fact','{\"supply\":\"100\"}' FROM generate_series(1,100)");
 await pool.query("INSERT INTO hunter.evidence_claim(mint,claim,status) VALUES('synthetic-report','Research coverage gaps','UNKNOWN')");
 const original=pool.query.bind(pool);let queries=0;(pool as any).query=(...args:any[])=>{queries++;return (original as any)(...args);};
 try{
  const headers={Authorization:`Bearer ${process.env.HUNTER_API_TOKEN}`};
  const response=await fetch(base+'/api/tokens/synthetic-report',{headers});const body=await response.text();const report=JSON.parse(body);
  assert.equal(response.status,200);assert.equal(queries,1);assert.ok(Buffer.byteLength(body)<10000);assert.equal(report.decisions.length,1);assert.equal(report.evidence.length,1);assert.equal(report.history_loaded,false);assert.equal(report.decisions[0].context.observations,undefined);
  const audit=await (await fetch(base+'/api/tokens/synthetic-report?history=1',{headers})).json() as any;assert.equal(audit.decisions.length,25);assert.ok(audit.decisions[0].context.observations.length>1000);assert.equal(audit.history_loaded,true);
  assert.equal((await fetch(base+'/api/tokens/synthetic-report?history=1')).status,401);
 }finally{(pool as any).query=original;}
});
