export type MarketObservation={source:string;url:string;priceUsd:number;liquidityUsd:number|null;name:string|null;symbol:string|null;image:string|null;quoteMint:string|null;quotePrice:number|null;data:Record<string,unknown>};
const number=(value:unknown)=>{const n=typeof value==='number'||typeof value==='string'&&value.trim()?Number(value):NaN;return Number.isFinite(n)&&n>=0?n:null;};
export function dexObservation(payload:any,mint:string,quoteMint?:string):MarketObservation|null{
 const pairs=Array.isArray(payload)?payload:Array.isArray(payload?.pairs)?payload.pairs:[];
 const pair=pairs.filter((row:any)=>row.chainId==='solana'&&row.baseToken?.address===mint&&(!quoteMint||row.quoteToken?.address===quoteMint)&&Number(number(row.priceUsd))>0).sort((a:any,b:any)=>(number(b.liquidity?.usd)??0)-(number(a.liquidity?.usd)??0))[0];
 if(!pair)return null;
 // Native SOL is used only for an explicitly SOL-quoted pair, where native
 // and quote denominations agree. Stablecoin quotes require explicit Gecko data.
 const quote=pair.quoteToken?.address==='So11111111111111111111111111111111111111112'?pair.quoteToken.address:null,native=number(pair.priceNative);
 return {source:'dexscreener',url:`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`,priceUsd:Number(pair.priceUsd),liquidityUsd:number(pair.liquidity?.usd),name:pair.baseToken?.name??null,symbol:pair.baseToken?.symbol??null,image:pair.info?.imageUrl??null,quoteMint:quote,quotePrice:quote&&native&&native>0?native:null,data:{venue:pair.dexId,pairUrl:pair.url,poolAddress:pair.pairAddress,volume:pair.volume,priceChange:pair.priceChange,txns:pair.txns,marketCap:pair.marketCap,fdv:pair.fdv,websites:pair.info?.websites??[],socials:pair.info?.socials??[],provider_update_at:null}};
}
export function geckoObservation(payload:any,mint:string,quoteMintFilter?:string):MarketObservation|null{
 const rows=Array.isArray(payload?.data)?payload.data:[];
 const pool=rows.filter((row:any)=>row.relationships?.base_token?.data?.id===`solana_${mint}`&&(!quoteMintFilter||row.relationships?.quote_token?.data?.id===`solana_${quoteMintFilter}`)&&Number(number(row.attributes?.base_token_price_usd))>0).sort((a:any,b:any)=>(number(b.attributes?.reserve_in_usd)??0)-(number(a.attributes?.reserve_in_usd)??0))[0];
 if(!pool)return null;
 const a=pool.attributes,base=(payload.included??[]).find((item:any)=>item.id===`solana_${mint}`)?.attributes??{};
 const quoteId=pool.relationships?.quote_token?.data?.id,quoteMint=typeof quoteId==='string'&&quoteId.startsWith('solana_')?quoteId.slice(7):null;
 const quotePrice=number(a.base_token_price_quote_token);
 return {source:'geckoterminal',url:`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?include=base_token,quote_token`,priceUsd:Number(a.base_token_price_usd),liquidityUsd:number(a.reserve_in_usd),name:base.name??null,symbol:base.symbol??null,image:base.image_url??null,quoteMint,quotePrice:quotePrice&&quotePrice>0?quotePrice:null,data:{venue:pool.relationships?.dex?.data?.id??null,poolAddress:a.address,pairUrl:a.address?`https://www.geckoterminal.com/solana/pools/${a.address}`:null,marketCap:number(a.market_cap_usd),fdv:number(a.fdv_usd),volume:a.volume_usd,priceChange:a.price_change_percentage,provider_update_at:null}};
}
