export const SOL='So11111111111111111111111111111111111111112';
const quotes:Record<string,{symbol:string;decimals:number}>={
 [SOL]:{symbol:'SOL',decimals:9},
 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:{symbol:'USDC',decimals:6},
 Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB:{symbol:'USDT',decimals:6}
};
const raw=(value:unknown)=>typeof value==='string'&&value.length<=78&&/^\d+$/.test(value)&&BigInt(value)>0n?value:typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):null;
/** Only a single paid quote and a single purchased output can establish an unallocated per-token entry. */
export function purchaseEntry(swap:any,wallet:string,output:any){
 const inputs=Array.isArray(swap?.tokenInputs)?swap.tokenInputs.filter((x:any)=>x.userAccount===wallet):[];
 const outputs=Array.isArray(swap?.tokenOutputs)?swap.tokenOutputs.filter((x:any)=>x.userAccount===wallet):[];
 const tokenRaw=raw(output?.rawTokenAmount?.tokenAmount),tokenDecimals=output?.rawTokenAmount?.decimals;
 if(outputs.length!==1||!tokenRaw||!Number.isInteger(tokenDecimals)||tokenDecimals<0||tokenDecimals>30)return null;
 let quoteMint:string,quoteRaw:string|null;
 if(swap.nativeInput?.account===wallet&&inputs.length===0){quoteMint=SOL;quoteRaw=raw(swap.nativeInput.amount);}
 else if(inputs.length===1&&swap.nativeInput?.account!==wallet){quoteMint=inputs[0].mint;quoteRaw=raw(inputs[0].rawTokenAmount?.tokenAmount);if(inputs[0].rawTokenAmount?.decimals!==quotes[quoteMint]?.decimals)return null;}
 else return null;
 if(!quotes[quoteMint]||!quoteRaw||quoteMint===output.mint)return null;
 return {quoteMint,quoteSymbol:quotes[quoteMint].symbol,quoteRaw,quoteDecimals:quotes[quoteMint].decimals,tokenRaw,tokenDecimals,amountSource:'provider_decoded_swap',feeScope:'Swap input only; network fees are not included'};
}
