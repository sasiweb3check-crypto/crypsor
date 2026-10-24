import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTransactions } from "./ingest.ts";
import { evaluateGate } from "./research.ts";

// Synthetic parser fixtures only; never seeded into the live application.
const wallet = "A".repeat(32), mint = "B".repeat(32), other = "C".repeat(32);
const tx = () => ({signature:"s".repeat(88),timestamp:1700000000,slot:123,feePayer:wallet,events:{swap:{nativeInput:{account:wallet,amount:"1000000"},tokenOutputs:[{mint,userAccount:wallet,rawTokenAmount:{tokenAmount:"10",decimals:6}}]}}});
test("explicit swap is a provider-reported observation, not independent confirmation",()=>{
  const parsed=normalizeTransactions([tx()],[wallet]);
  assert.equal(parsed.filter(x=>x.kind==="SWAP_BUY").length,1);
  assert.equal(parsed.find(x=>x.mint)?.commitment,"provider_reported");
  assert.equal(parsed.find(x=>x.mint)?.observations.purchaseEstablished,true);
});
test("every watched wallet remains a sensor without spend thresholds",()=>{
  const tiny=tx();tiny.events.swap.nativeInput.amount="1";
  assert.equal(normalizeTransactions([tiny],[wallet]).filter(x=>x.mint).length,1);
});
test("inbound transfers and mere SWAP labels never establish buys",()=>{
  const transfers={signature:"s".repeat(88),type:"SWAP",tokenTransfers:[{fromUserAccount:other,toUserAccount:wallet,mint,tokenAmount:10}]};
  const parsed=normalizeTransactions([transfers],[wallet]);
  assert.equal(parsed.length,1);assert.equal(parsed[0].kind,"WALLET_ACTIVITY");assert.equal(parsed[0].mint,null);
});
test("failed transactions, another wallet's payments, and sold-mint change are excluded",()=>{
  assert.equal(normalizeTransactions([{...tx(),transactionError:{error:"failed"}}],[wallet]).filter(x=>x.mint).length,0);
  const unpaid=tx();unpaid.events.swap.nativeInput.account=other;
  assert.equal(normalizeTransactions([unpaid],[wallet]).filter(x=>x.mint).length,0);
  const change:any=tx();change.events.swap.tokenInputs=[{mint,userAccount:wallet,rawTokenAmount:{tokenAmount:"50"}}];
  assert.equal(normalizeTransactions([change],[wallet]).filter(x=>x.mint).length,0);
});
test("all explicit outputs retained with deterministic distinct payload paths",()=>{
  const multiple=tx();multiple.events.swap.tokenOutputs.push({...multiple.events.swap.tokenOutputs[0],mint:other});
  const buys=normalizeTransactions([multiple],[wallet]).filter(x=>x.mint);
  assert.equal(buys.length,2);assert.notEqual(buys[0].instructionPath,buys[1].instructionPath);
});
const base={walletCount:3,eventCount:5,confirmedCount:0,hasIdentity:false,marketTimestamp:null,independentMarketSources:0,mintAuthority:undefined,freezeAuthority:undefined,authoritySourceVerified:false,sourceCount:1,holderSnapshots:0};
test("priority, risk and confidence remain independent; missing evidence never becomes false",()=>{
  const decision=evaluateGate(base,new Date("2026-01-01T00:00:00Z"));
  assert.equal(decision.priority,"HIGH");assert.equal(decision.risk,"UNKNOWN");assert.equal(decision.confidence,"LOW");assert.equal(decision.action,"INSUFFICIENT_EVIDENCE");
  assert.ok(decision.unknowns.some(x=>x.includes("UNKNOWN")));
});
test("freshness and provenance are deterministic gates, not trade authorization",()=>{
  const at=new Date("2026-01-01T00:00:00Z");
  const facts={...base,confirmedCount:2,hasIdentity:true,marketTimestamp:at.toISOString(),independentMarketSources:2,mintAuthority:"authority",freezeAuthority:null,authoritySourceVerified:true,holderSnapshots:1};
  const decision=evaluateGate(facts,at);
  assert.equal(decision.action,"WATCH");assert.equal(decision.confidence,"MEDIUM");assert.equal(decision.risk,"ELEVATED");assert.equal(decision.gate.paidWorkEligible,false);
  assert.equal(evaluateGate({...facts,marketTimestamp:"2025-01-01"},at).action,"INSUFFICIENT_EVIDENCE");
});
