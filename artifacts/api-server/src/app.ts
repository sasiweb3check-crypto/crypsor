import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type pg from 'pg';
import { pool, withTransaction } from './db.ts';
import { enqueue } from './queue.ts';
import { ingestTransactions } from './ingest.ts';
import { isSolanaAddress } from './validation.ts';
const modes = ['FULL','WATCH_ONLY','PAUSE_RESEARCH','STOP_ALL'];
function equalSecret(actual:string,expected:string) {
 const a=Buffer.from(actual),b=Buffer.from(expected);
 return a.length===b.length && timingSafeEqual(a,b);
}
export function createApp(database:pg.Pool=pool) {
 const app=express();
 app.disable('x-powered-by');
 const apiToken=process.env.HUNTER_API_TOKEN;
 const failedAuth=new Map<string,{count:number,until:number}>();
 const mutations=new Map<string,{count:number,until:number}>();
 function limited(store:Map<string,{count:number,until:number}>,ip:string,limit:number){
  const now=Date.now();
  for(const [key,bucket] of store)if(bucket.until<=now)store.delete(key);
  const bucket=store.get(ip)??{count:0,until:now+60000};
  bucket.count++;store.set(ip,bucket);return bucket.count>limit;
 }
 if(!apiToken || apiToken.length<24) throw new Error('Set a random HUNTER_API_TOKEN of at least 24 characters');
 app.use((_req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");next();});
 const auth:express.RequestHandler=(req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  const ip=req.socket.remoteAddress??'unknown';
  if(!equalSecret(req.get('authorization')??'',`Bearer ${apiToken}`)){
   if(limited(failedAuth,ip,30)){res.setHeader('Retry-After','60');res.status(429).json({error:'Authentication rate limit'});return;}
   res.status(401).json({error:'Authentication required'});return;
  }
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&limited(mutations,ip,60)){res.setHeader('Retry-After','60');res.status(429).json({error:'Mutation rate limit'});return;}
  next();
 };
 app.post('/api/webhooks/helius',(req,res,next)=>{
  const secret=process.env.HELIUS_WEBHOOK_SECRET;
  const provided=req.get('authorization')??'';
  if(!secret || !(equalSecret(provided,secret)||equalSecret(provided,`Bearer ${secret}`))){res.status(401).json({error:'Invalid webhook authentication'});return;}
  next();
 },express.json({limit:'1mb'}),async(req,res)=>{
  const mode=(await database.query('SELECT mode FROM hunter.operator_state WHERE singleton=true')).rows[0]?.mode;
  if(mode==='STOP_ALL'){res.status(503).json({error:'STOP_ALL is active'});return;}
  if(!Array.isArray(req.body)||req.body.length>100){res.status(400).json({error:'Expected at most 100 enhanced transactions'});return;}
  res.json(await ingestTransactions(database,req.body,{source:'helius_webhook'}));
 });
 app.use('/api',auth,express.json({limit:'1mb'}));
 app.get('/api/healthz',async(_req,res)=>{await database.query('SELECT 1');res.json({ok:true,service:'hunter',readOnly:true});});
 app.get('/api/wallets',async(_req,res)=>res.json({wallets:(await database.query('SELECT * FROM hunter.watched_wallet ORDER BY created_at DESC LIMIT 200')).rows}));
 app.post('/api/wallets',async(req,res)=>{
  const {address,label=''}=req.body??{};
  if(!isSolanaAddress(address)||typeof label!=='string'||label.length>100){res.status(400).json({error:'Enter a valid Solana address and label up to 100 characters'});return;}
  const result=await withTransaction(async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtext('hunter:wallet-limit'))");
   const count=Number((await c.query('SELECT count(*) FROM hunter.watched_wallet WHERE active=true')).rows[0].count);
   if(count>=20 && !(await c.query('SELECT 1 FROM hunter.watched_wallet WHERE address=$1 AND active=true',[address])).rowCount) return null;
   const row=(await c.query(`INSERT INTO hunter.watched_wallet(address,label) VALUES($1,$2) ON CONFLICT(address) DO UPDATE SET label=$2,active=true RETURNING *`,[address,label])).rows[0];
   await c.query("INSERT INTO hunter.operator_audit(action,reason,data) VALUES('wallet.add','Operator added discovery sensor',$1)",[{address}]);
   return row;
  },database);
  if(!result){res.status(409).json({error:'Pilot limited to 20 active wallets'});return;}
  res.status(201).json({wallet:result});
 });
 app.delete('/api/wallets/:address',async(req,res)=>{
  await withTransaction(async c=>{await c.query('UPDATE hunter.watched_wallet SET active=false WHERE address=$1',[req.params.address]);await c.query("INSERT INTO hunter.operator_audit(action,data) VALUES('wallet.deactivate',$1)",[{address:req.params.address}]);},database);
  res.json({ok:true});
 });
 app.get('/api/overview',async(_req,res)=>{
  const [stats,tokens,state]=await Promise.all([
   database.query(`SELECT (SELECT count(*)::int FROM hunter.watched_wallet WHERE active) wallets,(SELECT count(*)::int FROM hunter.token) tokens,(SELECT count(*)::int FROM hunter.onchain_event) events,(SELECT count(*)::int FROM hunter.decision_version) decisions,(SELECT count(*)::int FROM hunter.investigation_job WHERE status IN('queued','running')) AS "pendingJobs"`),
   database.query(`SELECT t.*,(SELECT jsonb_agg(DISTINCT wallet_address) FROM hunter.onchain_event e WHERE e.mint=t.mint) wallets,
   (SELECT status FROM hunter.alert a WHERE a.mint=t.mint ORDER BY created_at DESC LIMIT 1) alert_status,
   (SELECT status FROM hunter.investigation_job j WHERE j.mint=t.mint ORDER BY created_at DESC LIMIT 1) job_status
   FROM hunter.token t ORDER BY t.discovered_at DESC LIMIT 100`),database.query('SELECT mode FROM hunter.operator_state WHERE singleton=true')
  ]);
  res.json({stats:stats.rows[0],tokens:tokens.rows,mode:state.rows[0].mode});
 });
 app.get('/api/tokens/:mint',async(req,res)=>{
  const mint=req.params.mint;
  const token=(await database.query('SELECT * FROM hunter.token WHERE mint=$1',[mint])).rows[0];
  if(!token){res.status(404).json({error:'Token not observed'});return;}
  const queries:[string,string][]=[['events','SELECT * FROM hunter.onchain_event WHERE mint=$1 ORDER BY observed_at DESC LIMIT 100'],['evidence','SELECT e.*,s.provider,s.url,s.source_timestamp FROM hunter.evidence_claim e LEFT JOIN hunter.source_document s ON s.id=e.source_document_id WHERE e.mint=$1 ORDER BY e.known_at DESC LIMIT 200'],['decisions','SELECT * FROM hunter.decision_version WHERE mint=$1 ORDER BY version DESC LIMIT 50'],['metadata','SELECT * FROM hunter.token_metadata_version WHERE mint=$1 ORDER BY observed_at DESC LIMIT 25'],['holders','SELECT * FROM hunter.holder_snapshot WHERE mint=$1 ORDER BY captured_at DESC LIMIT 25'],['relations','SELECT * FROM hunter.relation_edge WHERE mint=$1 ORDER BY last_seen_at DESC LIMIT 100'],['jobs','SELECT * FROM hunter.investigation_job WHERE mint=$1 ORDER BY created_at DESC LIMIT 50'],['alerts','SELECT * FROM hunter.alert WHERE mint=$1 ORDER BY created_at DESC LIMIT 50']];
  const results=await Promise.all(queries.map(async([key,sql])=>[key,(await database.query(sql,[mint])).rows]));
  res.json({token,...Object.fromEntries(results)});
 });
 app.post('/api/tokens/:mint/research',async(req,res)=>{
  const mode=(await database.query('SELECT mode FROM hunter.operator_state WHERE singleton=true')).rows[0].mode;
  if(mode!=='FULL'){res.status(409).json({error:'Enable FULL mode for bounded research'});return;}
  if(!(await database.query('SELECT 1 FROM hunter.token WHERE mint=$1',[req.params.mint])).rowCount){res.status(404).json({error:'Token not observed'});return;}
  const job=await enqueue('enrich',String(req.params.mint),{},`enrich:${req.params.mint}`,database);
  res.status(202).json({queued:true,job:job??null});
 });
 app.get('/api/decisions',async(_req,res)=>res.json({decisions:(await database.query('SELECT d.*,t.name,t.symbol FROM hunter.decision_version d JOIN hunter.token t USING(mint) ORDER BY d.known_at DESC LIMIT 100')).rows}));
 app.get('/api/memory',async(req,res)=>{
  const query=`%${String(req.query.q??'').slice(0,120)}%`;
  const [wallets,tokens,claims,relations]=await Promise.all([
   database.query('SELECT * FROM hunter.watched_wallet WHERE address ILIKE $1 OR label ILIKE $1 ORDER BY created_at DESC LIMIT 50',[query]),
   database.query('SELECT * FROM hunter.token WHERE mint ILIKE $1 OR name ILIKE $1 OR symbol ILIKE $1 ORDER BY discovered_at DESC LIMIT 50',[query]),
   database.query('SELECT * FROM hunter.evidence_claim WHERE claim ILIKE $1 OR mint ILIKE $1 ORDER BY known_at DESC LIMIT 100',[query]),
   database.query('SELECT * FROM hunter.relation_edge WHERE source ILIKE $1 OR target ILIKE $1 OR kind ILIKE $1 ORDER BY last_seen_at DESC LIMIT 100',[query])
  ]);res.json({wallets:wallets.rows,tokens:tokens.rows,claims:claims.rows,relations:relations.rows});
 });
 app.get('/api/operations',async(_req,res)=>{
  const [state,jobs,usage,audit,metrics,workers,wallets]=await Promise.all([
   database.query('SELECT * FROM hunter.operator_state WHERE singleton=true'),
   database.query('SELECT * FROM hunter.investigation_job ORDER BY created_at DESC LIMIT 100'),
   database.query(`SELECT provider,operation,sum(requests)::int requests,sum(estimated_cost_usd) estimated_cost_usd,max(recorded_at) last_request_at FROM hunter.vendor_usage WHERE recorded_at>=date_trunc('day',now()) GROUP BY provider,operation`),
   database.query('SELECT * FROM hunter.operator_audit ORDER BY created_at DESC LIMIT 50'),
   database.query(`SELECT (SELECT count(*)::int FROM hunter.investigation_job WHERE status='dead') failed_jobs,(SELECT count(*)::int FROM hunter.investigation_job WHERE status='queued') queued_jobs,(SELECT max(observed_at) FROM hunter.onchain_event) last_event_at,(SELECT max(EXTRACT(EPOCH FROM observed_at-block_time)) FROM hunter.onchain_event WHERE block_time IS NOT NULL) max_observed_source_lag_seconds,(SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0)::bigint FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hunter' AND c.relkind='r') schema_bytes`),
   database.query("SELECT id,updated_at,last_error,updated_at>now()-interval '2 minutes' AS healthy FROM hunter.worker_heartbeat"),
   database.query('SELECT address,label,cursor,pending_cursor,last_success_at,last_error FROM hunter.watched_wallet WHERE active ORDER BY created_at LIMIT 20')
  ]);
  const names=['HELIUS_API_KEY','HELIUS_WEBHOOK_SECRET','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','JUPITER_API_KEY','GEMINI_API_KEY','AIVEN_DATABASE_URL','AIVEN_CA_CERT'];
  res.json({mode:state.rows[0].mode,state:state.rows[0],jobs:jobs.rows,usage:usage.rows,audit:audit.rows,metrics:metrics.rows[0],workers:workers.rows,wallets:wallets.rows,
   providers:[{name:'Helius',configured:Boolean(process.env.HELIUS_API_KEY)},{name:'DEX Screener',configured:true},{name:'Jupiter',configured:Boolean(process.env.JUPITER_API_KEY)},{name:'Telegram',configured:process.env.TELEGRAM_ENABLED==='true'&&Boolean(process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID)},{name:'Gemini',configured:process.env.GEMINI_ENABLED==='true'&&process.env.GEMINI_FREE_TIER_CONFIRMED==='true'&&Boolean(process.env.GEMINI_API_KEY),reason:'Optional; requires explicit enablement and confirmed free-tier entitlement'}],
   configuration:names.map(name=>({name,status:process.env[name]?'set':'missing'})),policy:{paidCallsEnabled:false,defaultMode:'WATCH_ONLY',walletLimit:20,rawRetentionDays:7,databaseAccountCapBytes:1000000000,subscriptionControl:'Manual vendor billing controls required'}});
 });
 app.post('/api/operator/mode',async(req,res)=>{
  const {mode,reason}=req.body??{};
  if(!modes.includes(mode)||typeof reason!=='string'||!reason.trim()||reason.length>500){res.status(400).json({error:'Provide a valid mode and a reason up to 500 characters'});return;}
  await withTransaction(async c=>{await c.query('UPDATE hunter.operator_state SET mode=$1,reason=$2,updated_at=now() WHERE singleton=true',[mode,reason]);await c.query("INSERT INTO hunter.operator_audit(action,reason,data) VALUES('mode.change',$1,$2)",[reason,{mode}]);},database);
  res.json({mode});
 });
 app.post('/api/jobs/:id/retry',async(req,res)=>{
  if(!/^\d+$/.test(String(req.params.id))){res.status(400).json({error:'Invalid job id'});return;}
  const result=await withTransaction(async c=>{const r=await c.query("UPDATE hunter.investigation_job SET status='queued',attempts=0,run_after=now(),finished_at=NULL,last_error=NULL WHERE id=$1 AND status='dead' RETURNING id",[req.params.id]);if(r.rowCount)await c.query("INSERT INTO hunter.operator_audit(action,data) VALUES('job.retry',$1)",[{jobId:req.params.id}]);return r.rowCount;},database);
  if(!result){res.status(409).json({error:'Only dead jobs can be retried'});return;}res.json({ok:true});
 });
 app.post('/api/ingest',async(req,res)=>{
  if(!Array.isArray(req.body?.transactions)||req.body.transactions.length>100){res.status(400).json({error:'Expected transactions array, maximum 100'});return;}
  const mode=(await database.query('SELECT mode FROM hunter.operator_state WHERE singleton=true')).rows[0].mode;
  if(mode==='STOP_ALL'){res.status(503).json({error:'STOP_ALL is active'});return;}
  res.json(await ingestTransactions(database,req.body.transactions,{source:'manual_replay'}));
 });
 app.use('/api',(_req,res)=>res.status(404).json({error:'API route not found'}));
 const webDist=process.env.WEB_DIST??path.resolve(import.meta.dirname,'../../crypsor/dist/public');
 app.use(express.static(webDist,{index:false}));
 app.get('/{*path}',(_req,res)=>res.sendFile(path.join(webDist,'index.html')));
 app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if((error as {type?:string})?.type==='entity.too.large'){res.status(413).json({error:'Payload too large'});return;}
  if(error instanceof SyntaxError){res.status(400).json({error:'Invalid JSON'});return;}
  console.error('Hunter request failed',{type:error instanceof Error?error.name:'UnknownError'});
  res.status(503).json({error:'Operation failed; check service configuration and job status'});
 });
 return app;
}
