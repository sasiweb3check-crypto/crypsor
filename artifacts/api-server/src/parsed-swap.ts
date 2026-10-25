import {SOL} from './purchase-entry.ts';

// Pump addresses checked against pump-fun/pump-public-docs IDLs, 25 October 2026.
// Only parsed transfers inside these swap instructions may establish a fallback entry.
export const SWAP_PROGRAMS = new Set([
 '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
]);
const quotes = new Map([[SOL,9],['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',6],['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',6]]);
const integer=(n:unknown):bigint|null=>typeof n==='string'&&/^\d{1,78}$/.test(n)?BigInt(n):typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?BigInt(n):null;
const TOKEN_PROGRAMS=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);

/** Conservative fallback for Helius layouts without events.swap. Never infer cost from
 * a SOL balance change: that includes rent, tips and fees. Use actual parsed transfers
 * within a recognized swap instruction, and check the acquired token balance delta.
 */
export function parsedSwapTransaction(raw:any,signature:string,watched:Iterable<string>){
 if(!raw?.meta||raw.meta.err!=null||raw.transaction?.signatures?.[0]!==signature)return null;
 const message=raw.transaction.message,keys=message.accountKeys??[];
 if(!Array.isArray(keys)||!Array.isArray(message.instructions))return null;
 const accounts=new Map<string,{owner:string;mint:string;decimals:number}>();
 const deltas=new Map<string,bigint>();
 for(const [balances,sign] of [[raw.meta.preTokenBalances??[],-1n],[raw.meta.postTokenBalances??[],1n]] as const){
  for(const b of balances){
   const address=typeof keys[b.accountIndex]==='string'?keys[b.accountIndex]:keys[b.accountIndex]?.pubkey;
   const amount=integer(b.uiTokenAmount?.amount),decimals=b.uiTokenAmount?.decimals;
   if(!address||!b.owner||amount===null||!Number.isInteger(decimals)||decimals<0||decimals>30)continue;
   accounts.set(address,{owner:b.owner,mint:b.mint,decimals});
   const key=`${b.owner}:${b.mint}`;deltas.set(key,(deltas.get(key)??0n)+sign*amount);
  }
 }
 const tokenOutputs:any[]=[],tokenInputs:any[]=[];
 let nativeInput:any=null;
 for(const wallet of watched){
  if(!keys.some((k:any)=>k.pubkey===wallet&&k.signer===true))continue;
  const changes=new Map<string,bigint>();let unsupported=false;
  const add=(mint:string,n:bigint)=>changes.set(mint,(changes.get(mint)??0n)+n);
  for(const [index,instruction] of message.instructions.entries()){
   if(!SWAP_PROGRAMS.has(instruction.programId))continue;
   for(const ix of raw.meta.innerInstructions?.find((g:any)=>g.index===index)?.instructions??[]){
    const info=ix.parsed?.info,type=ix.parsed?.type;
    if(TOKEN_PROGRAMS.has(ix.programId)){
     // An opaque token instruction can hide additional payments or transfer fees.
     if(!ix.parsed){unsupported=true;continue;}
     if(!['transfer','transferChecked'].includes(type))continue;
     const from=accounts.get(info?.source),to=accounts.get(info?.destination);
     if(info?.authority===wallet&&!from){unsupported=true;continue;}
     if(from?.owner!==wallet&&to?.owner!==wallet)continue;
     const amount=integer(info?.tokenAmount?.amount??info?.amount),asset=from??to;
     if(amount===null||!asset||(from&&to&&from.mint!==to.mint)){unsupported=true;continue;}
     if(from?.owner===wallet)add(asset.mint,-amount);
     if(to?.owner===wallet)add(asset.mint,amount);
    }else if(ix.programId==='11111111111111111111111111111111'&&type==='transfer'){
     const amount=integer(info?.lamports);if(amount===null){unsupported=true;continue;}
     if(info.source===wallet&&accounts.get(info.destination)?.owner!==wallet)add(SOL,-amount);
     if(info.destination===wallet&&accounts.get(info.source)?.owner!==wallet)add(SOL,amount);
    }
   }
  }
  const paid=[...changes].filter(([,n])=>n<0n),received=[...changes].filter(([mint,n])=>n>0n&&!quotes.has(mint));
  if(unsupported||paid.length!==1||received.length!==1||!quotes.has(paid[0][0]))continue;
  const [mint,amount]=received[0],meta=[...accounts.values()].find(a=>a.owner===wallet&&a.mint===mint);
  if(!meta||deltas.get(`${wallet}:${mint}`)!==amount)continue;
  const [quote,negative]=paid[0];
  tokenOutputs.push({userAccount:wallet,mint,rawTokenAmount:{tokenAmount:String(amount),decimals:meta.decimals}});
  if(quote===SOL){if(nativeInput)return null;nativeInput={account:wallet,amount:String(-negative)};}
  else tokenInputs.push({userAccount:wallet,mint:quote,rawTokenAmount:{tokenAmount:String(-negative),decimals:quotes.get(quote)}});
 }
 if(!tokenOutputs.length)return null;
 return {signature,timestamp:raw.blockTime,slot:raw.slot,feePayer:keys.find((k:any)=>k.signer)?.pubkey,
  parser:'hunter-rpc-transfers-v1',events:{swap:{nativeInput,tokenInputs,tokenOutputs}}};
}
