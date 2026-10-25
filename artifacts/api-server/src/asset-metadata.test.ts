import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assetMetadata,approvedMetadataUrl,publicMediaUrl,readPublicMetadata} from './asset-metadata.ts';
test('DAS metadata uses CDN images, fungible symbol fallback and public IPFS/Arweave URLs',()=>{
 const asset={token_info:{symbol:'TOKEN'},content:{metadata:{name:'Example',description:'Publisher text'},json_uri:'ipfs://abc123/metadata.json',files:[{mime:'image/png',uri:'ipfs://abc123/image.png',cdn_uri:'https://cdn.example.org/image.png'}]}};
 assert.deepEqual(assetMetadata(asset),{name:'Example',symbol:'TOKEN',description:'Publisher text',image:'https://cdn.example.org/image.png',imageCandidates:['https://cdn.example.org/image.png','https://ipfs.io/ipfs/abc123/image.png'],metadataUri:'https://ipfs.io/ipfs/abc123/metadata.json'});
 assert.equal(publicMediaUrl('ar://record/image.png'),'https://arweave.net/record/image.png');
 assert.equal(assetMetadata({content:{metadata:{image:'ipfs://CID/picture.png'}}}).image,'https://ipfs.io/ipfs/CID/picture.png');
});
test('off-chain fetch accepts only known public content gateways and rejects credentials, private hosts and insecure schemes',()=>{
 for(const uri of ['http://ipfs.io/ipfs/a','https://localhost/x','https://127.0.0.1/x','https://169.254.169.254/x','https://user:password@ipfs.io/x','https://ipfs.io:123/x','https://ipfs.io.evil.invalid/x','javascript:alert(1)'])assert.equal(approvedMetadataUrl(uri),null);
 assert.equal(approvedMetadataUrl('ipfs://CID/metadata.json'),'https://ipfs.io/ipfs/CID/metadata.json');
});
test('public metadata enforces byte bounds and disables redirects without forwarding provider credentials',async()=>{
 const original=globalThis.fetch;
 try{
  globalThis.fetch=async(_url:any,options:any)=>{assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,undefined);return Response.json({description:'Public description'});};
  assert.deepEqual(await readPublicMetadata('https://arweave.net/test'),{description:'Public description'});
  globalThis.fetch=async()=>new Response('x'.repeat(64001));
  await assert.rejects(readPublicMetadata('https://arweave.net/test'),/TOO_LARGE/);
 }finally{globalThis.fetch=original;}
});
