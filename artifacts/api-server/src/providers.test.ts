import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chooseDexPair,holderFeatures,allowedTelegramChat,reconciliationSlice} from './providers.ts';
test('DEX identity requires exact Solana base mint and selects deepest observed venue',()=>{
  const pairs=[{chainId:'ethereum',baseToken:{address:'mint'},liquidity:{usd:100000}}, {chainId:'solana',baseToken:{address:'other'},liquidity:{usd:100000}}, {chainId:'solana',baseToken:{address:'mint'},liquidity:{usd:10}}, {chainId:'solana',baseToken:{address:'mint'},liquidity:{usd:20}}];
  assert.equal(chooseDexPair(pairs,'mint').liquidity.usd,20);
  assert.equal(chooseDexPair(pairs,'missing'),null);
});
test('holder concentration uses integer raw supply without identifying unknown account owners',()=>{
  assert.equal(holderFeatures([{amount_raw:'100000000000000000000'}],'200000000000000000000').top_accounts_supply_share,0.5);
  assert.equal(holderFeatures([{amount_raw:'1'}],'0').top_accounts_supply_share,null);
  assert.equal(holderFeatures([{amount_raw:'1'}],'10').owner_classification,'UNKNOWN');
});
test('Telegram requires explicit single-user allowlist',()=>{
  assert.equal(allowedTelegramChat({TELEGRAM_CHAT_ID:'12',TELEGRAM_ALLOWED_CHAT_IDS:'12'}),'12');
  assert.equal(allowedTelegramChat({TELEGRAM_CHAT_ID:'12',TELEGRAM_ALLOWED_CHAT_IDS:'12,13'}),null);
  assert.equal(allowedTelegramChat({TELEGRAM_CHAT_ID:'12'}),null);
});
test('reconciliation stops at stable cursor without consuming old signatures',()=>{
  const page=[{signature:'new'},{signature:'stable'},{signature:'old'}];
  assert.deepEqual(reconciliationSlice(page,'stable'),{selected:[{signature:'new'}],done:true});
  assert.equal(reconciliationSlice(Array.from({length:100},(_,i)=>({signature:String(i)})),'missing').done,false);
});
