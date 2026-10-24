import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
const testUrl=process.env.TEST_DATABASE_URL;
if(!testUrl)throw new Error('Set TEST_DATABASE_URL to isolated loopback hunter_pilot_test');
const parsed=new URL(testUrl);
if(!['localhost','127.0.0.1'].includes(parsed.hostname)||parsed.pathname!=='/hunter_pilot_test')throw new Error('Provider tests require isolated loopback hunter_pilot_test');
process.env.DATABASE_URL=testUrl;
delete process.env.AIVEN_DATABASE_URL;
const {pool,initialize}=await import('../artifacts/api-server/src/db.ts');
const {reserveVendorCall,ProviderUnavailable,heliusRpc,deliverAlert,geminiHypotheses}=await import('../artifacts/api-server/src/providers.ts');
before(async()=>{await pool.query('DROP SCHEMA IF EXISTS hunter CASCADE');await initialize();});
after(async()=>{await pool.end();});
test('atomic request reservations cap concurrent calls and include failed attempts',async()=>{
 await pool.query("UPDATE hunter.operator_state SET mode='FULL'");
 const config={HELIUS_DAILY_REQUEST_CAP:'1',HELIUS_MONTHLY_REQUEST_CAP:'10'};
 const attempts=await Promise.allSettled(Array.from({length:12},()=>reserveVendorCall(pool,'helius','synthetic_budget_test',undefined,config)));
 assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
 assert.ok(attempts.filter(a=>a.status==='rejected').every((a:any)=>a.reason instanceof ProviderUnavailable&&a.reason.code==='REQUEST_CAP_EXHAUSTED'));
 assert.equal((await pool.query("SELECT sum(requests)::int AS n FROM hunter.vendor_usage WHERE provider='helius'")).rows[0].n,1);
 await pool.query("UPDATE hunter.vendor_usage SET outcome='failed' WHERE provider='helius'");
 await assert.rejects(reserveVendorCall(pool,'helius','still_metered',undefined,config),(e:any)=>e.code==='REQUEST_CAP_EXHAUSTED');
});
test('monthly cap independently blocks work while daily allowance remains',async()=>{
 await pool.query("INSERT INTO hunter.vendor_usage(provider,operation,requests) VALUES('jupiter','synthetic_existing_month',3)");
 await assert.rejects(reserveVendorCall(pool,'jupiter','blocked',undefined,{JUPITER_DAILY_REQUEST_CAP:'100',JUPITER_MONTHLY_REQUEST_CAP:'3'}),(e:any)=>e.code==='REQUEST_CAP_EXHAUSTED');
});
test('STOP_ALL prevents vendor fetch before any request and Gemini remains opt-in',async()=>{
 const originalFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error('No external calls permitted in integration test');};
 try{
  await pool.query("UPDATE hunter.operator_state SET mode='STOP_ALL'");
  await assert.rejects(heliusRpc(pool,'getSlot',[],undefined,{HELIUS_API_KEY:'synthetic-do-not-send'}),(e:any)=>e.code==='OPERATOR_PAUSED');
  assert.equal(await geminiHypotheses(pool,'B'.repeat(32),{},{}),null);
  assert.equal(calls,0);
 }finally{globalThis.fetch=originalFetch;}
});
test('Telegram without exact single-user allowlist persists configuration gap without sending',async()=>{
 await pool.query("UPDATE hunter.operator_state SET mode='WATCH_ONLY'");
 const mint='B'.repeat(32);
 await pool.query('INSERT INTO hunter.token(mint) VALUES($1)',[mint]);
 await pool.query("INSERT INTO hunter.alert(id,mint,payload) VALUES('synthetic-alert',$1,'{}')",[mint]);
 const originalFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error('No external calls permitted');};
 try{
  const result=await deliverAlert(pool,'synthetic-alert',{TELEGRAM_ENABLED:'true',TELEGRAM_BOT_TOKEN:'synthetic-do-not-send',TELEGRAM_CHAT_ID:'12',TELEGRAM_ALLOWED_CHAT_IDS:'12,13'});
  assert.equal(result.skipped,'TELEGRAM_NOT_CONFIGURED');assert.equal(calls,0);
  assert.equal((await pool.query("SELECT status FROM hunter.alert WHERE id='synthetic-alert'")).rows[0].status,'awaiting_configuration');
 }finally{globalThis.fetch=originalFetch;}
});
test('reconciliation works with one connection and never advances checkpoint after STOP_ALL mid-flight',async()=>{
 const {reconcileWallet}=await import('../artifacts/api-server/src/providers.ts');
 const single=new (pool.constructor as any)({connectionString:testUrl,max:1});
 const wallet='C'.repeat(32), stoppedWallet='D'.repeat(32), mint='B'.repeat(32);
 await pool.query('INSERT INTO hunter.watched_wallet(address) VALUES($1),($2)',[wallet,stoppedWallet]);
 const originalFetch=globalThis.fetch;
 let stopDuringDecode=false;
 const signature='r'.repeat(88);
 globalThis.fetch=async (_url,init)=>{
  const request=JSON.parse(String(init?.body));
  if(request.method==='getSignaturesForAddress')return Response.json({jsonrpc:'2.0',id:'hunter',result:[{signature,err:null}]});
  if(request.transactions){
   if(stopDuringDecode)await pool.query("UPDATE hunter.operator_state SET mode='STOP_ALL'");
   return Response.json([{signature,timestamp:1700000000,slot:100,feePayer:stopDuringDecode?stoppedWallet:wallet,events:{swap:{nativeInput:{account:stopDuringDecode?stoppedWallet:wallet,amount:'1000'},tokenOutputs:[{mint,userAccount:stopDuringDecode?stoppedWallet:wallet,rawTokenAmount:{tokenAmount:'10',decimals:0}}]}}}]);
  }
  throw new Error('Unexpected fixture request');
 };
 try{
  const config={HELIUS_API_KEY:'synthetic-fixture-only',HELIUS_DAILY_REQUEST_CAP:'100',HELIUS_MONTHLY_REQUEST_CAP:'1000'};
  await pool.query("UPDATE hunter.operator_state SET mode='FULL'");
  const result=await reconcileWallet(single,wallet,config);
  assert.equal(result.complete,true);
  assert.equal((await pool.query('SELECT cursor FROM hunter.watched_wallet WHERE address=$1',[wallet])).rows[0].cursor,signature);
  assert.equal((await pool.query("SELECT commitment FROM hunter.onchain_event WHERE wallet_address=$1 AND event_kind='SWAP_BUY'",[wallet])).rows[0].commitment,'finalized');
  stopDuringDecode=true;
  await assert.rejects(reconcileWallet(single,stoppedWallet,config),(e:any)=>e.code==='OPERATOR_PAUSED');
  const stopped=(await pool.query('SELECT cursor,reconcile_lease_token FROM hunter.watched_wallet WHERE address=$1',[stoppedWallet])).rows[0];
  assert.equal(stopped.cursor,null);assert.equal(stopped.reconcile_lease_token,null);
 }finally{globalThis.fetch=originalFetch;await single.end();}
});
