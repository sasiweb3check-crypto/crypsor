import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { pool, overview } from './tracking/store';
import { status, tick } from './tracking/worker';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '8kb' }));
const password = process.env.WALLET_ADMIN_PASSWORD;
const sessionSecret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const sign = (value:string) => createHmac('sha256', sessionSecret).update(value).digest('hex');
const equal = (a:string,b:string) => { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); };
function authorized(req:Request) {
  const token = req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('cw_session='))?.slice(11);
  if (!token) return false;
  const [expiry,signature] = token.split('.');
  return Number(expiry)>Date.now() && equal(signature??'',sign(expiry));
}
function admin(req:Request,res:Response,next:NextFunction) {
  if (!authorized(req)) { res.status(401).json({error:'Sign in to manage wallets'}); return; }
  next();
}
const attempts = new Map<string,{n:number;at:number}>();
app.get('/api/auth', (req,res)=>res.json({authorized:authorized(req),configured:Boolean(password)}));
app.post('/api/auth',(req,res)=>{
  if (!password) { res.status(503).json({error:'Set WALLET_ADMIN_PASSWORD in Render to enable wallet management'}); return; }
  const ip=req.ip??'unknown',now=Date.now();
  for (const [key,value] of attempts) if(now-value.at>15*60_000) attempts.delete(key);
  const previous=attempts.get(ip)??{n:0,at:now};
  if(previous.n>=10 || attempts.size>1000) { res.status(429).json({error:'Too many attempts. Try again in 15 minutes.'}); return; }
  attempts.set(ip,{n:previous.n+1,at:previous.at});
  if(typeof req.body?.password!=='string' || !equal(req.body.password,password)) { res.status(401).json({error:'Incorrect password'}); return; }
  attempts.delete(ip);
  const expiry=String(now+12*60*60_000);
  res.cookie('cw_session',`${expiry}.${sign(expiry)}`,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:12*60*60_000,path:'/'});
  res.json({authorized:true});
});
app.delete('/api/auth',(_req,res)=>{res.clearCookie('cw_session',{path:'/'});res.json({ok:true});});
app.get('/api/healthz',async(_req,res)=>{
  try {await pool.query('SELECT 1');res.json({ok:true,tracking:status});}
  catch {res.status(503).json({ok:false,error:'Database unavailable'});}
});
app.get('/api/keepalive',(_req,res)=>res.json({ok:true}));
app.get('/api/dashboard',async(_req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try {res.json({...await overview(),tracking:status});}
  catch {res.status(503).json({error:'Unable to load dashboard. Check the database connection.'});}
});
function validAddress(address:string) {
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  let value=0n;
  for(const c of address)value=value*58n+BigInt(alphabet.indexOf(c));
  let bytes=0;while(value>0n){bytes++;value>>=8n;}
  return bytes+(address.match(/^1*/)?.[0].length??0)===32;
}
app.post('/api/wallets',admin,async(req,res)=>{
  const address=typeof req.body?.address==='string'?req.body.address.trim():'';
  const label=typeof req.body?.label==='string'?req.body.label.trim().slice(0,60):'';
  if(!validAddress(address)){res.status(400).json({error:'Enter a valid Solana wallet address'});return;}
  try {
    const count=await pool.query('SELECT COUNT(*)::int AS n FROM cw_wallets');
    if(count.rows[0].n>=100){res.status(400).json({error:'This instance supports up to 100 wallets'});return;}
    const added=await pool.query('INSERT INTO cw_wallets(address,label) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING address',[address,label]);
    if(!added.rowCount){res.status(409).json({error:'This wallet is already tracked'});return;}
    res.status(201).json({ok:true});void tick();
  }catch{res.status(503).json({error:'Unable to save wallet'});}
});
app.delete('/api/wallets/:address',admin,async(req,res)=>{
  try {await pool.query('DELETE FROM cw_wallets WHERE address=$1',[req.params.address]);res.json({ok:true});}
  catch{res.status(503).json({error:'Unable to remove wallet'});}
});
app.post('/api/sync',admin,(_req,res)=>{void tick();res.status(202).json({ok:true});});
app.use('/api',(_req,res)=>res.status(404).json({error:'Not found'}));
const publicDir=process.env.WEB_DIST??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../crypsor/dist/public');
app.use(express.static(publicDir));
app.use((_req,res)=>res.status(404).type('text').send('Not found'));
app.use((err:unknown,_req:Request,res:Response,_next:NextFunction)=>{
  res.status(400).json({error:'Invalid request'});
});
export default app;
