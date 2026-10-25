import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
const url=new URL(process.env.TEST_DATABASE_URL||'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/hunter_pilot_test')throw new Error('Isolated hunter_pilot_test required');
process.env.DATABASE_URL=url.toString();delete process.env.AIVEN_DATABASE_URL;
process.env.HUNTER_API_TOKEN='synthetic-purchase-test-token-123456';process.env.HELIUS_API_KEY='synthetic-no-network-key';
const {pool,initialize}=await import('../artifacts/api-server/src/db.ts');
const {reconcileWallet,collectPrices}=await import('../artifacts/api-server/src/providers.ts');
const {ingestTransactions}=await import('../artifacts/api-server/src/ingest.ts');
const {purchasePerformanceSql,replayPurchase}=await import('../artifacts/api-server/src/performance.ts');
const {schedule,runOne}=await import('../artifacts/api-server/src/worker.ts');
const {enqueue}=await import('../artifacts/api-server/src/queue.ts');
const {createApp}=await import('../artifacts/api-server/src/app.ts');
const wallet='1'.repeat(32),mint='B'.repeat(32),SOL='So11111111111111111111111111111111111111112';
const originalFetch=globalThis.fetch;
let signatures:any[]=[],decoded:any[]=[],beforeSeen:any[]=[],nativePrice=2,dexFails=false,raw:any=null,server:any,base:string;
const buy=(signature:string,amount='1000000000')=>({signature,timestamp:1700000000,slot:100,feePayer:wallet,type:'SWAP',events:{swap:{nativeInput:{account:wallet,amount},tokenOutputs:[{userAccount:wallet,mint,rawTokenAmount:{tokenAmount:'1000000',decimals:6}}]}}});
const config={HELIUS_API_KEY:'synthetic-no-network-key',HELIUS_DAILY_REQUEST_CAP:'1000',HELIUS_MONTHLY_REQUEST_CAP:'10000'};
before(async()=>{
 await pool.query('DROP SCHEMA IF EXISTS hunter CASCADE');await initialize();await pool.query('INSERT INTO hunter.watched_wallet(address) VALUES($1)',[wallet]);
 globalThis.fetch=async(input:any,init:any)=>{
  // Keep fixture calls deterministic without real pacing sleeps; usage is still reserved.
  await pool.query("UPDATE hunter.vendor_usage SET recorded_at=now()-interval '20 seconds'");
  const url=String(input),body=init?.body?JSON.parse(init.body):{};
  if(url.includes('helius-rpc')){
   if(body.method==='getSignaturesForAddress'){beforeSeen.push(body.params[1]);return Response.json({result:signatures});}
   if(body.method==='getTransaction')return Response.json({result:raw});
  }
  if(url.includes('api.helius.xyz'))return Response.json(decoded.filter(tx=>body.transactions.includes(tx.signature)));
  if(url.includes('dexscreener'))return dexFails?new Response('',{status:503}):Response.json([{chainId:'solana',baseToken:{address:mint},quoteToken:{address:SOL},priceUsd:'300',priceNative:String(nativePrice),liquidity:{usd:10000}}]);
  if(url.includes('geckoterminal'))return Response.json({data:[{attributes:{base_token_price_usd:'300',base_token_price_quote_token:String(nativePrice)},relationships:{base_token:{data:{id:`solana_${mint}`}},quote_token:{data:{id:`solana_${SOL}`}}}}]});
  throw new Error('Unexpected fixture request');
 };
 server=createApp(pool).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{globalThis.fetch=originalFetch;await new Promise<void>(r=>server.close(()=>r()));await pool.end();});

test('successive finalized buys and duplicate deliveries preserve each actual entry exactly once',async()=>{
 decoded=[buy('a'.repeat(88))];signatures=[{signature:decoded[0].signature,err:null}];
 await reconcileWallet(pool,wallet,config);
 assert.equal((await pool.query('SELECT count(*)::int n FROM hunter.wallet_purchase')).rows[0].n,1);
 await ingestTransactions(pool,decoded,{trustedCommitment:'finalized'});
 decoded=[buy('b'.repeat(88),'2000000000'),...decoded];signatures=decoded.map(tx=>({signature:tx.signature,err:null}));
 await reconcileWallet(pool,wallet,config);
 const rows=(await pool.query('SELECT entry_quote_price FROM hunter.wallet_purchase ORDER BY id')).rows;
 assert.deepEqual(rows.map(r=>Number(r.entry_quote_price)),[1,2]);
 assert.equal((await pool.query('SELECT cursor FROM hunter.watched_wallet')).rows[0].cursor,'b'.repeat(88));
 assert.equal((await pool.query("SELECT count(*)::int n FROM hunter.onchain_event WHERE event_kind='SWAP_BUY'")).rows[0].n,2);
});
test('failed or incomplete decoding never advances the cursor past unrecorded transactions',async()=>{
 signatures=[{signature:'c'.repeat(88),err:null},...signatures];
 await assert.rejects(reconcileWallet(pool,wallet,config),(e:any)=>e.code==='INCOMPLETE_TRANSACTION_REPLAY');
 assert.equal((await pool.query('SELECT cursor FROM hunter.watched_wallet')).rows[0].cursor,'b'.repeat(88));
 signatures=signatures.slice(1);
});
test('current matching-currency gains fall while all-time observed peak remains in durable memory',async()=>{
 await collectPrices(pool,config);
 let rows=(await pool.query(purchasePerformanceSql,[mint])).rows;
 assert.equal(Number(rows[0].gain_percent),100);assert.equal(Number(rows[1].gain_percent),0);
 nativePrice=0.5;await pool.query("UPDATE hunter.token SET price_checked_at=now()-interval '2 days'");await collectPrices(pool,config);
 rows=(await pool.query(purchasePerformanceSql,[mint])).rows;
 assert.equal(Number(rows[0].gain_percent),-50);assert.equal(Number(rows[0].peak_observed_gain_percent),100);
 assert.equal(Number(rows[1].gain_percent),-75);assert.equal(Number(rows[1].peak_observed_gain_percent),0);
 await assert.rejects(pool.query('DELETE FROM hunter.price_sample'),/append-only/);
 const replay=await replayPurchase(pool,mint,rows[0].id);assert.equal(replay.available,true);if(replay.available){assert.equal(replay.result.exit_observed?.gain_percent,100);assert.equal(replay.result.mark_to_market_gain_percent,-50);}
});
test('public price fallback fills missing primary data and keeps quote provenance',async()=>{
 dexFails=true;nativePrice=3;await pool.query("UPDATE hunter.token SET price_checked_at=now()-interval '2 days'");await collectPrices(pool,config);
 const rows=(await pool.query(purchasePerformanceSql,[mint])).rows;
 assert.equal(Number(rows[0].gain_percent),200);assert.equal(rows[0].current_price_source,'geckoterminal');
 assert.equal((await pool.query('SELECT price_error FROM hunter.token')).rows[0].price_error,null);dexFails=false;
});
test('unsupported enhanced Pump layout queues RPC fallback and records actual transfers, not wallet SOL delta',async()=>{
 const signature='d'.repeat(88);
 const pump={signature,feePayer:wallet,type:'SWAP',source:'PUMP_FUN'};decoded=[pump as any,...decoded];signatures=decoded.map(tx=>({signature:tx.signature,err:null}));
 raw={slot:101,blockTime:1700000001,transaction:{signatures:[signature],message:{accountKeys:[{pubkey:wallet,signer:true},{pubkey:'user-token',signer:false},{pubkey:'pool-token',signer:false}],instructions:[{programId:'6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'}]}},meta:{err:null,preBalances:[9999999999],postBalances:[1],preTokenBalances:[],postTokenBalances:[{accountIndex:1,owner:wallet,mint,uiTokenAmount:{amount:'1000000',decimals:6}},{accountIndex:2,owner:'vault',mint,uiTokenAmount:{amount:'9000000',decimals:6}}],innerInstructions:[{index:0,instructions:[{programId:'11111111111111111111111111111111',parsed:{type:'transfer',info:{source:wallet,destination:'vault',lamports:500000000}}},{programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',parsed:{type:'transferChecked',info:{source:'pool-token',destination:'user-token',tokenAmount:{amount:'1000000',decimals:6}}}}]}]}};
 await reconcileWallet(pool,wallet,config);
 const pending=(await pool.query("SELECT * FROM hunter.investigation_job WHERE kind='parse_transaction'")).rows;assert.equal(pending.length,1);
 await pool.query("UPDATE hunter.investigation_job SET status='done' WHERE kind<>'parse_transaction'");
 assert.equal(await runOne(pool),true);
 const entry=(await pool.query('SELECT * FROM hunter.wallet_purchase WHERE signature=$1',[signature])).rows[0];
 assert.ok(entry);assert.equal(Number(entry.entry_quote_price),0.5);assert.equal(entry.data.amount_source,'rpc_parsed_swap_transfers');
 await enqueue('parse_transaction',null,{signature},`parse-transaction-v1:${signature}`,pool);await runOne(pool);
 assert.equal((await pool.query('SELECT count(*)::int n FROM hunter.wallet_purchase WHERE signature=$1',[signature])).rows[0].n,1);
});
test('tracking remains scheduled in PAUSE_RESEARCH, catch-up pages bypass poll delay, and repairs are automatic',async()=>{
 await pool.query("UPDATE hunter.investigation_job SET status='done'");
 await pool.query("UPDATE hunter.operator_state SET mode='PAUSE_RESEARCH'");
 await pool.query("UPDATE hunter.watched_wallet SET pending_cursor='pending',last_success_at=now(),purchase_replay_version=0");
 await pool.query("UPDATE hunter.token SET price_checked_at=now()-interval '2 days'");
 await schedule(pool);
 const kinds=(await pool.query("SELECT kind,payload FROM hunter.investigation_job WHERE status='queued'")).rows;
 assert.ok(kinds.some(r=>r.kind==='prices'));assert.ok(kinds.some(r=>r.kind==='reconcile'&&!r.payload.replayRecent));assert.ok(kinds.some(r=>r.kind==='reconcile'&&r.payload.replayRecent));
 // Replay recent must not touch a partially completed normal catch-up cursor.
 const cursor=(await pool.query('SELECT cursor,pending_cursor FROM hunter.watched_wallet')).rows[0];
 await reconcileWallet(pool,wallet,config,{replayRecent:true});
 assert.deepEqual((await pool.query('SELECT cursor,pending_cursor FROM hunter.watched_wallet')).rows[0],cursor);
 assert.equal(beforeSeen.at(-1).before,undefined);
});
test('a gap exceeding 100 signatures resumes immediately and records the next buy without losing the cursor',async()=>{
 const address='2'.repeat(32),stable='e'.repeat(88),alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
 await pool.query('INSERT INTO hunter.watched_wallet(address,cursor,last_success_at) VALUES($1,$2,now())',[address,stable]);
 await pool.query("UPDATE hunter.investigation_job SET status='done'");
 const page=Array.from({length:100},(_,i)=>'f'.repeat(86)+alphabet[Math.floor(i/58)]+alphabet[i%58]);
 signatures=page.map(signature=>({signature,err:null}));decoded=page.map(signature=>({signature,feePayer:address,timestamp:1700000000}) as any);
 await enqueue('reconcile',null,{address},`reconcile:${address}`,pool);await runOne(pool);
 let state=(await pool.query('SELECT cursor,pending_cursor FROM hunter.watched_wallet WHERE address=$1',[address])).rows[0];
 assert.equal(state.cursor,stable);assert.equal(state.pending_cursor,page.at(-1));
 const continuation=(await pool.query('SELECT status,attempts,run_after<=now() due FROM hunter.investigation_job WHERE dedupe_key=$1',[`reconcile:${address}`])).rows[0];
 assert.equal(continuation.status,'queued');assert.equal(continuation.attempts,0);assert.equal(continuation.due,true);
 const newBuy=buy('g'.repeat(88));newBuy.feePayer=address;newBuy.events.swap.nativeInput.account=address;newBuy.events.swap.tokenOutputs[0].userAccount=address;
 signatures=[{signature:newBuy.signature,err:null},{signature:stable,err:null}];decoded=[newBuy];
 await runOne(pool);
 state=(await pool.query('SELECT cursor,pending_cursor FROM hunter.watched_wallet WHERE address=$1',[address])).rows[0];
 assert.equal(beforeSeen.at(-1).before,page.at(-1));assert.equal(state.cursor,page[0]);assert.equal(state.pending_cursor,null);
 assert.equal((await pool.query('SELECT count(*)::int n FROM hunter.wallet_purchase WHERE wallet_address=$1',[address])).rows[0].n,1);
});
test('API exposes every recorded buy, real gains and visible background status; invalid replay is 400',async()=>{
 const headers={Authorization:`Bearer ${process.env.HUNTER_API_TOKEN}`,'Content-Type':'application/json'};
 const response=await originalFetch(base+'/api/buys',{headers});assert.equal(response.status,200);const result=await response.json() as any;assert.equal(result.buys.length,4);assert.equal(result.nextOffset,null);
 const overview=await (await originalFetch(base+'/api/overview',{headers})).json() as any;assert.equal(overview.stats.buys,4);assert.equal(overview.tokens[0].buy_count,4);
 const operations=await (await originalFetch(base+'/api/operations',{headers})).json() as any;assert.ok(operations.tracking.priceBatchIntervalSeconds>=120);assert.ok(operations.wallets[0].last_scan_at);
 const report=await (await originalFetch(base+'/api/tokens/'+mint,{headers})).json() as any;assert.equal(report.purchase_count,4);assert.equal(report.purchases.length,4);
 assert.equal((await originalFetch(base+'/api/tokens/'+mint+'/experiments',{method:'POST',headers,body:JSON.stringify({takeProfit:-1})})).status,400);
 assert.equal((await originalFetch(base+'/api/buys')).status,401);
});
