import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Use a separately launched API-only server on hunter_browser_test, never production.
const database = new URL(process.env.DATABASE_URL || '');
const origin = new URL(process.env.HUNTER_BROWSER_ORIGIN || 'http://127.0.0.1:3001');
if (!['localhost','127.0.0.1'].includes(database.hostname) || database.pathname !== '/hunter_browser_test'
    || !['localhost','127.0.0.1'].includes(origin.hostname)) throw new Error('Browser smoke requires isolated local hunter_browser_test');
if (!process.env.HUNTER_API_TOKEN) throw new Error('Set HUNTER_API_TOKEN from your local test runtime');
const reset = spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',
  "import {pool,initialize} from './artifacts/api-server/src/db.ts'; await pool.query('DROP SCHEMA IF EXISTS hunter CASCADE'); await initialize(); await pool.end();"],{env:process.env,encoding:'utf8'});
assert.equal(reset.status,0,'Isolated browser database reset failed');
const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,args:['--no-sandbox']});
const context = await browser.newContext({viewport:{width:1440,height:1000}});
const page = await context.newPage();
await context.route('https://fixtures.invalid/synthetic-token.png',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVJkAAAAASUVORK5CYII=','base64')}));
const errors = [];
const apiRequests=[];page.on("request",request=>{const path=new URL(request.url()).pathname;if(path.startsWith("/api/"))apiRequests.push(path);});
page.on('pageerror', error => errors.push(error.message));
const headers = {Authorization:`Bearer ${process.env.HUNTER_API_TOKEN}`};
const wallet = '1'.repeat(32), mint = 'B'.repeat(32);
const fixture = {signature:'s'.repeat(88),feePayer:wallet,timestamp:1700000000,slot:123,
  events:{swap:{nativeInput:{account:wallet,amount:'1000000000'},tokenOutputs:[{mint,userAccount:wallet,rawTokenAmount:{tokenAmount:'1000000',decimals:6}}]}}};
async function api(path, method='GET', data) {
  const response = await context.request.fetch(origin.origin+path,{method,headers,data});
  assert.ok(response.ok(), `Local API ${path} failed: ${response.status()}`);
  return response.json();
}
async function nav(name) {await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button').filter({hasText:name}).click();await page.waitForTimeout(150);}
try {
  await mkdir('test-results',{recursive:true});
  await page.goto(origin.origin);
  await page.getByLabel('API token',{exact:true}).fill(process.env.HUNTER_API_TOKEN);
  await page.getByRole('button',{name:'Unlock workspace'}).click();
  await page.getByRole('heading',{name:'Radar',exact:true}).waitFor();
  await page.screenshot({path:'test-results/radar-empty.png',fullPage:true});
  await nav('Cabin / memory');
  await page.getByLabel('Public Solana address').fill(wallet);
  await page.getByLabel(/Label/).fill('Synthetic browser sensor');
  await page.getByRole('button',{name:'Watch wallet',exact:true}).click();
  await page.getByText('Synthetic browser sensor',{exact:true}).waitFor();
  await api('/api/ingest','POST',{transactions:[fixture]});
  const enrichment = spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',
    "import {pool} from './artifacts/api-server/src/db.ts'; import {runOne} from './artifacts/api-server/src/worker.ts'; import {ingestTransactions} from './artifacts/api-server/src/ingest.ts'; import {fixtureFetch} from './tests/flow-fixtures.mjs'; globalThis.fetch=fixtureFetch; await ingestTransactions(pool,JSON.parse(process.env.SYNTHETIC_PURCHASE_FIXTURE),{trustedCommitment:'finalized'}); for(let i=0;i<4;i++)await runOne(pool); await pool.query(\"INSERT INTO hunter.price_sample(mint,quote_mint,price,source,source_url,fingerprint) VALUES($1,$2,2,'browser_fixture','https://fixtures.invalid/price','browser-peak'),($1,$2,0.5,'browser_fixture','https://fixtures.invalid/price','browser-current')\",['B'.repeat(32),'So11111111111111111111111111111111111111112']); await pool.end();"],{env:{...process.env,HELIUS_API_KEY:'synthetic-test-only',TELEGRAM_ENABLED:'false',SYNTHETIC_PURCHASE_FIXTURE:JSON.stringify([fixture])},encoding:'utf8'});
  assert.equal(enrichment.status,0,'Fixture-backed metadata pipeline failed');
  const populated=await api('/api/tokens/'+mint);
  assert.equal(populated.token.name,'Synthetic Flow Token');assert.equal(populated.token.enrichment_state,'ready');assert.ok(populated.token.price_usd);assert.equal(populated.purchase_count,1);assert.equal(Number(populated.purchases[0].gain_percent),-50);assert.equal(Number(populated.purchases[0].peak_observed_gain_percent),100);
  await nav('Radar');
  await page.getByText('Synthetic Flow Token',{exact:true}).first().waitFor();
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  assert.equal(await page.locator('.mobile-token-card').count(),1);
  await page.getByLabel('Search tokens').fill('no-match');assert.equal(await page.locator('.mobile-token-card').count(),0);
  await page.getByLabel('Search tokens').fill('TEST');assert.equal(await page.locator('.mobile-token-card').count(),1);
  await page.waitForFunction(()=>{const image=document.querySelector('.mobile-token-card img');return image instanceof HTMLImageElement&&image.complete&&image.naturalWidth>0;});
  await page.screenshot({path:'test-results/mobile-radar-populated.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});await page.waitForTimeout(300);
  await page.getByText(mint,{exact:true}).first().waitFor({timeout:2000}).catch(async()=>{
    assert.equal((await api('/api/overview')).stats.tokens,1);
  });
  await nav('Operations');
  await page.getByText('Adjust wallet polling request allowance',{exact:true}).click();
  await page.getByLabel('Daily Helius request limit',{exact:true}).fill('1000');
  await page.getByLabel('Monthly Helius request limit',{exact:true}).fill('20000');
  await page.getByRole('button',{name:'Save tracking limits',exact:true}).click();
  await page.getByText(/Local request limits saved/).waitFor();
  assert.equal((await api('/api/settings')).heliusDailyRequestCap,1000);
  await page.getByRole('button',{name:/Stop all/}).click();
  await page.getByLabel('Reason for this change').fill('Synthetic browser STOP_ALL validation');
  await page.getByRole('button',{name:'Confirm mode change'}).click();
  await page.waitForTimeout(150);
  assert.equal((await api('/api/operations')).mode,'STOP_ALL');
  const blocked = await context.request.post(origin.origin+'/api/ingest',{headers,data:{transactions:[fixture]}});
  assert.equal(blocked.status(),503);
  await page.getByRole('button',{name:/Full research/}).click();
  await page.getByLabel('Reason for this change').fill('Synthetic browser rule-journal validation');
  await page.getByRole('button',{name:'Confirm mode change'}).click();
  await page.waitForTimeout(150);
  const result = spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',
    `import {pool} from './artifacts/api-server/src/db.ts'; import {researchToken} from './artifacts/api-server/src/research.ts'; await researchToken(pool,'${mint}'); await pool.end();`],
    {env:{...process.env,GEMINI_ENABLED:'false',TELEGRAM_ENABLED:'false'},encoding:'utf8'});
  assert.equal(result.status,0,'Rule-only synthetic browser journal failed');
  await nav('Decisions');
  await page.getByText('Rule-based observations',{exact:true}).first().waitFor();
  await nav('Cabin / memory');
  await page.getByRole('button',{name:new RegExp(mint.slice(0,7))}).first().click();
  await page.getByRole('heading',{name:'Token room',exact:true}).waitFor();
  await page.getByText(/explicit provider-reported token swap output/).first().waitFor();
  await page.getByRole('heading',{name:'Actual wallet buys & gains',exact:true}).waitFor();
  assert.ok((await page.locator('.purchase-row').innerText()).includes('-50%'));assert.ok((await page.locator('.purchase-row').innerText()).includes('+100%'));
  assert.equal(await page.getByText('Source URL not recorded',{exact:true}).count(),0);
  assert.equal(await page.getByText('Research coverage gaps',{exact:true}).count(),0);
  await page.getByText('Replay collected quotes and save a paper experiment',{exact:true}).click();
  await page.getByRole('button',{name:'Replay collected quotes',exact:true}).click();
  await page.getByRole('button',{name:'Save paper replay',exact:true}).waitFor();
  await page.getByRole('button',{name:'Save paper replay',exact:true}).click();
  await page.getByText(/saved to memory. This is retrospective/).waitFor();
  assert.equal((await api('/api/experiments')).experiments.length,1);
  const beforeWarm=apiRequests.filter(path=>path===`/api/tokens/${mint}`).length;
  await nav('Radar');
  await page.locator('.token-table .token-button').first().click();
  await page.getByRole('heading',{name:'Token room',exact:true}).waitFor();
  await page.getByText(/explicit provider-reported token swap output/).first().waitFor();
  assert.equal(apiRequests.filter(path=>path===`/api/tokens/${mint}`).length,beforeWarm,'Warm navigation should use the authenticated in-memory report cache');
  assert.equal(await page.locator('.json').count(),0,'Raw records should not be rendered until expanded');
  await page.screenshot({path:'test-results/token-room-synthetic.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(300); // Allow the mobile drawer transition to finish.
  await page.screenshot({path:'test-results/mobile-token-room.png',fullPage:true});
  assert.ok(await page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right<=1),'Mobile drawer remains visible when closed');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile document overflows horizontally');
  assert.deepEqual(errors,[],'Browser runtime errors');
  console.log(JSON.stringify({browser:'Chromium',pages:5,checks:['unlock','empty radar','wallet management','discovery','stop gate','full mode','versioned decision','token evidence','mobile overflow','loaded image','compact report','warm navigation cache','actual purchase entry','negative current gain','persistent observed peak','mobile request limits','saved quote replay'],runtimeErrors:0,fixtures:'synthetic isolated hunter_browser_test only'}));
} finally {await browser.close();}
