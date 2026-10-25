import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
/** Gains compare matching quote currencies only. No tracking-price or USD-peg substitution. */
export const purchasePerformanceSelect=`SELECT b.*,s.price AS current_quote_price,s.source AS current_price_source,s.observed_at AS current_observed_at,
 s.observed_at>now()-interval '15 minutes' AS quote_fresh,
 CASE WHEN s.price IS NOT NULL THEN (s.price/b.entry_quote_price-1)*100 END AS gain_percent,
 CASE WHEN p.peak IS NOT NULL THEN GREATEST(0,(p.peak/b.entry_quote_price-1)*100) END AS peak_observed_gain_percent,
 p.samples,p.first_sample_at,p.last_sample_at,
 EXTRACT(EPOCH FROM e.observed_at-e.block_time) AS detection_lag_seconds
 FROM hunter.wallet_purchase b JOIN hunter.onchain_event e ON e.id=b.event_id
 LEFT JOIN LATERAL(SELECT price,source,observed_at FROM hunter.price_sample WHERE mint=b.mint AND quote_mint=b.quote_mint AND observed_at>=COALESCE(b.block_time,b.known_at) ORDER BY observed_at DESC,id DESC LIMIT 1)s ON true
 LEFT JOIN LATERAL(SELECT max(price) peak,count(*)::int samples,min(observed_at) first_sample_at,max(observed_at) last_sample_at FROM hunter.price_sample WHERE mint=b.mint AND quote_mint=b.quote_mint AND observed_at>=COALESCE(b.block_time,b.known_at))p ON true`;
export const purchasePerformanceSql=`${purchasePerformanceSelect} WHERE b.mint=$1 ORDER BY b.block_time NULLS LAST,b.id LIMIT 50`;
export async function replayPurchase(pool:Pool,mint:string,buyId:string|undefined,takeProfit=20,stopLoss=10){
 if(!Number.isFinite(takeProfit)||!Number.isFinite(stopLoss)||takeProfit<=0||takeProfit>10000||stopLoss<=0||stopLoss>100)throw new Error('Invalid replay thresholds');
 if(buyId&&!/^\d+$/.test(buyId))throw new Error('Invalid purchase id');
 const purchase=(await pool.query('SELECT * FROM hunter.wallet_purchase WHERE mint=$1 AND ($2::bigint IS NULL OR id=$2::bigint) ORDER BY block_time NULLS LAST,id LIMIT 1',[mint,buyId??null])).rows[0];
 if(!purchase)return {available:false as const,reason:'No eligible finalized wallet purchase with unambiguous raw input/output amounts is recorded. A displayed market price is never used as entry.'};
 const rows=(await pool.query('SELECT id,price,quote_mint,source,source_url,observed_at FROM hunter.price_sample WHERE mint=$1 AND quote_mint=$2 AND observed_at>=COALESCE($3::timestamptz,$4::timestamptz) ORDER BY observed_at,id LIMIT 5001',[mint,purchase.quote_mint,purchase.block_time,purchase.known_at])).rows;
 const truncated=rows.length>5000,samples=rows.slice(0,5000);
 if(!samples.length)return {available:false as const,purchase,reason:'The actual purchase entry is known, but a subsequent market quote in the same currency has not been collected.'};
 const entry=Number(purchase.entry_quote_price),points=samples.map(row=>({...row,price:Number(row.price),gain_percent:(Number(row.price)/entry-1)*100}));
 const exit=points.find(row=>row.gain_percent>=takeProfit||row.gain_percent<=-stopLoss)??null;
 const maxGap=points.reduce((max,row,i)=>Math.max(max,i?(new Date(row.observed_at).getTime()-new Date(points[i-1].observed_at).getTime())/1000:Math.max(0,(new Date(row.observed_at).getTime()-new Date(purchase.block_time??purchase.known_at).getTime())/1000)),0);
 const fingerprint=createHash('sha256').update(JSON.stringify([purchase.id,points.map(row=>[row.id,row.price,row.observed_at])])).digest('hex');
 return {available:true as const,classification:'retrospective_sample_replay',purchase,parameters:{takeProfit,stopLoss},samples:points,truncated,dataset_fingerprint:fingerprint,
  result:{exit_observed:exit,mark_to_market_gain_percent:points.at(-1)!.gain_percent,max_observed_gain_percent:Math.max(...points.map(row=>row.gain_percent)),max_unobserved_gap_seconds:maxGap,first_observed_at:points[0].observed_at,last_observed_at:points.at(-1)!.observed_at},
  limitations:[...(truncated?['Replay is limited to the first 5,000 samples; later prices are excluded.']:[]),'Actual covered-window purchase is the baseline; it may not be the first lifetime wallet buy.','Replay uses collected quotes, not complete OHLCV candles. Gaps cannot prove a candle was missed.','Thresholds execute at the first observed qualifying quote; fees, slippage, liquidity and intrabar paths are not modeled.','This is retrospective research, not a forward prediction or realized wallet PnL.']};
}
