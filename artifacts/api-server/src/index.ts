import { pool,initialize } from './db.ts';
import { createApp } from './app.ts';
import { startWorker } from './worker.ts';
const role=process.env.PROCESS_ROLE??'all';
if(!['all','api','worker','migrate'].includes(role))throw new Error('PROCESS_ROLE must be all, api, worker or migrate');
if(!process.env.AIVEN_DATABASE_URL&&!process.env.DATABASE_URL)throw new Error('Set DATABASE_URL or AIVEN_DATABASE_URL');
await initialize();
if(role==='migrate'){await pool.end();console.log('Hunter schema migration complete');}
else {
 const port=Number(process.env.PORT??3000);
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
 const server=role==='worker'?undefined:createApp().listen(port,'0.0.0.0',()=>console.log(`Hunter private API listening on ${port}`));
 const worker=role==='api'?undefined:startWorker();
 let stopping=false;
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(stopping)return;stopping=true;
  const closed=new Promise<void>(resolve=>{if(server)server.close(()=>resolve());else resolve();});
  void Promise.all([closed,worker?.stop()]).then(()=>pool.end()).then(()=>process.exit(0));
  setTimeout(()=>process.exit(1),15000).unref();
 });
 server?.on('error',()=>{console.error('Hunter API listener failed');process.exit(1);});
}
