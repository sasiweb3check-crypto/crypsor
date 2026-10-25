// Synthetic provider responses for isolated tests only. No vendor requests.
export const fixtureMint='B'.repeat(32);
export async function fixtureFetch(input,init){
 const url=String(input);
 if(url.startsWith('https://api.dexscreener.com/'))return Response.json([{chainId:'solana',baseToken:{address:fixtureMint,name:'Synthetic Flow Token',symbol:'TEST'},quoteToken:{address:'So11111111111111111111111111111111111111112'},priceNative:'0.0025',priceUsd:'0.25',liquidity:{usd:12000},info:{imageUrl:'https://fixtures.invalid/synthetic-token.png'},volume:{h24:500},marketCap:25000}]);
 if(url.startsWith('https://mainnet.helius-rpc.com/')){
  const rpc=JSON.parse(init.body);
  if(rpc.method==='getSignaturesForAddress')return Response.json({result:[]});
  if(rpc.method==='getAsset')return Response.json({result:{id:fixtureMint,content:{metadata:{name:'Synthetic Flow Token',symbol:'TEST',description:'Synthetic isolated test description'},links:{image:'https://fixtures.invalid/synthetic-token.png'}}}});
  if(rpc.method==='getAccountInfo')return Response.json({result:{context:{slot:123},value:{owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',data:{parsed:{type:'mint',info:{decimals:6,supply:'100000000',mintAuthority:null,freezeAuthority:null}}}}}});
  if(rpc.method==='getTokenLargestAccounts')return Response.json({result:{value:[]}});
 }
 throw new Error('Unexpected fixture request; outbound calls disabled');
}
