import {test} from 'node:test';
import assert from 'node:assert/strict';
import {purchaseEntry,SOL} from './purchase-entry.ts';
import {parsedSwapTransaction} from './parsed-swap.ts';
import {dexObservation,geckoObservation} from './market-sources.ts';
const wallet='1'.repeat(32),mint='B'.repeat(32),usdc='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const output={mint,userAccount:wallet,rawTokenAmount:{tokenAmount:'12345678901234567890',decimals:6}};
test('entries require exact integer paid amounts and a single unambiguous output',()=>{
 const swap={nativeInput:{account:wallet,amount:'1000000000'},tokenOutputs:[output]};
 assert.equal(purchaseEntry(swap,wallet,output)?.tokenRaw,'12345678901234567890');
 assert.equal(purchaseEntry({...swap,nativeInput:{account:wallet,amount:1.1}},wallet,output),null);
 assert.equal(purchaseEntry({...swap,tokenOutputs:[output,{...output,mint:'C'.repeat(32)}]},wallet,output),null);
 const stable={tokenInputs:[{mint:usdc,userAccount:wallet,rawTokenAmount:{tokenAmount:'2500000',decimals:6}}],tokenOutputs:[output]};
 assert.equal(purchaseEntry(stable,wallet,output)?.quoteSymbol,'USDC');
 assert.equal(purchaseEntry({...stable,tokenInputs:[...stable.tokenInputs,...stable.tokenInputs]},wallet,output),null);
 assert.equal(purchaseEntry({...swap,tokenOutputs:[output]},wallet,{...output,rawTokenAmount:{tokenAmount:1,decimals:undefined}}),null);
});
export function rawFixture(signature='r'.repeat(88)){
 return {slot:100,blockTime:1700000000,transaction:{signatures:[signature],message:{accountKeys:[{pubkey:wallet,signer:true},{pubkey:'wallet-ata',signer:false},{pubkey:'pool-ata',signer:false}],instructions:[{programId:'6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'},{programId:'11111111111111111111111111111111',parsed:{type:'transfer',info:{source:wallet,destination:'tip',lamports:5000}}}]}},meta:{err:null,preBalances:[9000000000],postBalances:[1000000000],preTokenBalances:[{accountIndex:1,owner:wallet,mint,uiTokenAmount:{amount:'0',decimals:6}}],postTokenBalances:[{accountIndex:1,owner:wallet,mint,uiTokenAmount:{amount:'1000000',decimals:6}},{accountIndex:2,owner:'pool-owner',mint,uiTokenAmount:{amount:'9000000',decimals:6}}],innerInstructions:[{index:0,instructions:[{programId:'11111111111111111111111111111111',parsed:{type:'createAccount',info:{source:wallet,lamports:99999}}},{programId:'11111111111111111111111111111111',parsed:{type:'transfer',info:{source:wallet,destination:'pool-owner',lamports:1000000000}}},{programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',parsed:{type:'transferChecked',info:{source:'pool-ata',destination:'wallet-ata',tokenAmount:{amount:'1000000',decimals:6}}}}]}]}};
}
test('RPC fallback uses swap transfers, excludes rent instructions and outside tips, and checks token delta',()=>{
 const raw=rawFixture(),tx=parsedSwapTransaction(raw,'r'.repeat(88),[wallet]);
 assert.ok(tx);assert.equal(tx.events.swap.nativeInput.amount,'1000000000');assert.equal(tx.events.swap.tokenOutputs[0].rawTokenAmount.tokenAmount,'1000000');
 const failed=structuredClone(raw);failed.meta.err={InstructionError:[0,'error']} as any;assert.equal(parsedSwapTransaction(failed,'r'.repeat(88),[wallet]),null);
 const transfer=structuredClone(raw);transfer.transaction.message.instructions[0].programId='unrecognized';assert.equal(parsedSwapTransaction(transfer,'r'.repeat(88),[wallet]),null);
 const different=structuredClone(raw);different.meta.postTokenBalances[0].uiTokenAmount.amount='2000000';assert.equal(parsedSwapTransaction(different,'r'.repeat(88),[wallet]),null);
 const opaque=structuredClone(raw);opaque.meta.innerInstructions[0].instructions.push({programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',data:'opaque'} as any);assert.equal(parsedSwapTransaction(opaque,'r'.repeat(88),[wallet]),null);
 assert.equal(parsedSwapTransaction(raw,'s'.repeat(88),[wallet]),null);
});
test('market adapters require exact Solana mint and matching quote; missing prices never become zero',()=>{
 const pair={chainId:'solana',baseToken:{address:mint},quoteToken:{address:SOL},priceNative:'0.002',priceUsd:'0.3',liquidity:{usd:10000}};
 assert.equal(dexObservation([pair],mint,SOL)?.quotePrice,0.002);
 assert.equal(dexObservation([pair],mint,usdc),null);assert.equal(dexObservation([{...pair,chainId:'ethereum'}],mint),null);
 assert.equal(dexObservation([{...pair,priceNative:undefined}],mint)?.quotePrice,null);
 const gecko={data:[{attributes:{base_token_price_usd:'0.3',base_token_price_quote_token:'0.002'},relationships:{base_token:{data:{id:`solana_${mint}`}},quote_token:{data:{id:`solana_${SOL}`}}}}]};
 assert.equal(geckoObservation(gecko,mint,SOL)?.quotePrice,0.002);assert.equal(geckoObservation(gecko,mint,usdc),null);
});
