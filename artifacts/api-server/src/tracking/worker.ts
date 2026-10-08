import { pool } from './store.ts';
import { extractBuys, type Transaction, type Buy } from './buys.ts';

export const status = { running: false, lastSync: null as string | null, error: null as string | null,
  heliusConfigured: Boolean(process.env.HELIUS_API_KEY), intervalSeconds: 30 };
const MAX_PAGES = 10;
export async function syncWallet(wallet: { address: string; cursor: string | null }) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return;
  let before: string | undefined;
  let newest: string | undefined;
  let caughtUp = false;
  const buys: Buy[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`https://api.helius.xyz/v0/addresses/${wallet.address}/transactions`);
    url.searchParams.set('api-key', key); url.searchParams.set('limit', '100');
    if (before) url.searchParams.set('before', before);
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Helius HTTP ${response.status}`);
    const txs = await response.json() as Transaction[];
    if (!Array.isArray(txs)) throw new Error('Unexpected Helius response');
    newest ??= txs[0]?.signature;
    for (const tx of txs) {
      if (tx.signature === wallet.cursor) { caughtUp = true; break; }
      buys.push(...extractBuys(tx, wallet.address));
    }
    // Initial sync imports the most recent 100 transactions. Later syncs paginate to the cursor.
    if (!wallet.cursor || caughtUp || txs.length < 100) { caughtUp = true; break; }
    before = txs.at(-1)?.signature;
  }
  if (!caughtUp) throw new Error('Wallet history exceeds 1,000 transactions since last scan; cursor retained');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const b of buys.sort((a, b) => a.timestamp - b.timestamp)) {
      await client.query(`INSERT INTO cw_tokens(mint, entry_price, entry_source, entry_at, peak_price)
        VALUES($1,$2,$3,to_timestamp($4),$2) ON CONFLICT(mint) DO NOTHING`,
        [b.mint, b.purchasePrice, b.purchasePrice ? 'purchase' : null, b.timestamp]);
      await client.query(`INSERT INTO cw_buys(wallet,mint,signature,bought_at,purchase_price)
        VALUES($1,$2,$3,to_timestamp($4),$5) ON CONFLICT DO NOTHING`,
        [b.wallet,b.mint,b.signature,b.timestamp,b.purchasePrice]);
    }
    await client.query('UPDATE cw_wallets SET cursor=COALESCE($2,cursor),synced_at=now(),sync_error=NULL WHERE address=$1', [wallet.address,newest ?? null]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function refreshPrices() {
  const rows = (await pool.query('SELECT mint FROM cw_tokens ORDER BY price_checked_at ASC NULLS FIRST LIMIT 300')).rows;
  for (let i=0; i<rows.length; i+=30) {
    const mints = rows.slice(i,i+30).map(r=>r.mint);
    const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
    const pairs = await response.json() as Array<{chainId:string; baseToken:{address:string;symbol?:string;name?:string};priceUsd?:string;liquidity?:{usd?:number};info?:{imageUrl?:string}}>;
    if (!Array.isArray(pairs)) throw new Error('Unexpected price response');
    for (const mint of mints) {
      const pair = pairs.filter(p=>p.chainId==='solana' && p.baseToken?.address===mint && Number(p.priceUsd)>0)
        .sort((a,b)=>(b.liquidity?.usd??0)-(a.liquidity?.usd??0))[0];
      await pool.query('UPDATE cw_tokens SET price_checked_at=now() WHERE mint=$1',[mint]);
      if (!pair) continue; // Keep unpriced tokens visible; never invent a price or a 0% gain.
      const price = Number(pair.priceUsd);
      if (!Number.isFinite(price)) continue;
      await pool.query(`UPDATE cw_tokens SET symbol=$2,name=$3,image=$4,current_price=$5,
        entry_price=COALESCE(entry_price,$5),entry_source=COALESCE(entry_source,'detection'),
        peak_price=GREATEST(COALESCE(peak_price,$5),$5),priced_at=now() WHERE mint=$1`,
        [mint,pair.baseToken.symbol??null,pair.baseToken.name??null,pair.info?.imageUrl?.startsWith('https://')?pair.info.imageUrl:null,price]);
      await pool.query('INSERT INTO cw_prices(mint,price) VALUES($1,$2)',[mint,price]);
      await pool.query('DELETE FROM cw_prices WHERE mint=$1 AND id NOT IN (SELECT id FROM cw_prices WHERE mint=$1 ORDER BY id DESC LIMIT 100)',[mint]);
    }
    if (i+30 < rows.length) await new Promise(r=>setTimeout(r,250));
  }
}
export async function tick() {
  if (status.running) return;
  status.running = true; status.error = null;
  try {
    const wallets = (await pool.query('SELECT address,cursor FROM cw_wallets ORDER BY created_at')).rows;
    for (const wallet of wallets) {
      try { await syncWallet(wallet); }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Wallet sync failed';
        await pool.query('UPDATE cw_wallets SET sync_error=$2 WHERE address=$1',[wallet.address,message]);
        status.error = message;
      }
    }
    await refreshPrices();
    status.lastSync = new Date().toISOString();
  } catch (error) { status.error = error instanceof Error ? error.message : 'Sync failed'; }
  finally { status.running = false; }
}
let timer: ReturnType<typeof setInterval> | undefined;
export function startTracking() {
  void tick();
  timer = setInterval(()=>void tick(),30_000);
  return () => clearInterval(timer);
}
