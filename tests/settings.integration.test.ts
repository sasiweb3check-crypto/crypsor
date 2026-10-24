import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
const url=new URL(process.env.TEST_DATABASE_URL||'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/hunter_pilot_test')throw new Error('Isolated hunter_pilot_test required');
process.env.DATABASE_URL=url.toString();delete process.env.AIVEN_DATABASE_URL;
process.env.HUNTER_API_TOKEN='settings-test-token-not-for-real-use-1234';
const {pool,initialize}=await import('../artifacts/api-server/src/db.ts');
const {createApp}=await import('../artifacts/api-server/src/app.ts');
const {runtimeConfig,decryptSetting}=await import('../artifacts/api-server/src/settings.ts');
let server:any,base:string;const original=globalThis.fetch;
before(async()=>{await pool.query('DROP SCHEMA IF EXISTS hunter CASCADE');await initialize();server=createApp(pool).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{globalThis.fetch=original;await new Promise<void>(r=>server.close(()=>r()));await pool.end();});
test('mobile key settings authenticate, validate, encrypt, replace and never disclose provider secrets',async()=>{
 assert.equal((await original(base+'/api/settings')).status,401);
 const headers={Authorization:`Bearer ${process.env.HUNTER_API_TOKEN}`,'Content-Type':'application/json'};
 let seen='';
 globalThis.fetch=async(input:any,init:any)=>{
  if(String(input).startsWith('https://mainnet.helius-rpc.com/')){seen=new URL(String(input)).searchParams.get('api-key')||'';return Response.json({result:'ok'});}
  return original(input,init);
 };
 for(const secret of ['synthetic-provider-key-one','synthetic-provider-key-two']){
  await pool.query('DELETE FROM hunter.vendor_usage');
  const response=await original(base+'/api/settings/helius',{method:'POST',headers,body:JSON.stringify({apiKey:secret})});
  assert.equal(response.status,200);assert.equal(seen,secret);
  const stored=(await pool.query("SELECT ciphertext FROM hunter.runtime_setting WHERE name='HELIUS_API_KEY'")).rows[0].ciphertext;
  assert.ok(!stored.includes(secret));assert.equal(decryptSetting(stored),secret);
  assert.equal((await runtimeConfig(pool,{})).HELIUS_API_KEY,secret);
  const status=await (await original(base+'/api/settings',{headers})).text();assert.ok(!status.includes(secret));
  const audit=JSON.stringify((await pool.query('SELECT * FROM hunter.operator_audit')).rows);assert.ok(!audit.includes(secret));
 }
 const invalid=await original(base+'/api/settings/helius',{method:'POST',headers,body:JSON.stringify({apiKey:'bad key'})});assert.equal(invalid.status,400);
 const rejected=await original(base+'/api/wallets',{method:'POST',headers,body:JSON.stringify({network:'ethereum',address:'1'.repeat(32),label:'Wrong network'})});assert.equal(rejected.status,400);
});
