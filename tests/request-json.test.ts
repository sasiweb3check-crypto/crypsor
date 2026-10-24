import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestJson} from '../artifacts/crypsor/src/request-json.ts';
const original=globalThis.fetch;
test('mobile settings distinguishes HTML/invalid JSON/session/network errors from key rejection',async()=>{
 try{
 globalThis.fetch=async()=>new Response('<html>Render SPA</html>',{headers:{'content-type':'text/html'}});
 await assert.rejects(requestJson('/api/settings/helius'),/web page instead/);
 globalThis.fetch=async()=>new Response('not JSON',{headers:{'content-type':'application/json'}});
 await assert.rejects(requestJson('/api/settings/helius'),/invalid JSON/);
 globalThis.fetch=async()=>new Response('',{status:401});
 await assert.rejects(requestJson('/api/settings/helius'),/session expired/);
 globalThis.fetch=async()=>{throw new TypeError('Failed to fetch');};
 await assert.rejects(requestJson('/api/settings/helius'),/Cannot reach/);
 globalThis.fetch=async()=>Response.json({error:'Helius rejected this key.'},{status:422});
 await assert.rejects(requestJson('/api/settings/helius'),/Helius rejected/);
 globalThis.fetch=async()=>Response.json({ok:true});assert.deepEqual(await requestJson('/api/settings/helius'),{ok:true});
 }finally{globalThis.fetch=original;}
});
