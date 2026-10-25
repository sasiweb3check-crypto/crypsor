/** Supported DAS shapes are documented by helius-labs/helius-sdk src/types/{types,das}.ts. */
const text=(value:unknown,max:number)=>typeof value==='string'&&value.trim()?value.trim().slice(0,max):null;
export function publicMediaUrl(value:unknown):string|null{
 if(typeof value!=='string'||value.length>2048)return null;
 let uri=value.trim();
 if(uri.startsWith('ipfs://'))uri='https://ipfs.io/ipfs/'+uri.slice(7).replace(/^ipfs\//,'');
 if(uri.startsWith('ar://'))uri='https://arweave.net/'+uri.slice(5);
 try{const url=new URL(uri);return url.protocol==='https:'&&!url.username&&!url.password?url.toString():null;}catch{return null;}
}
export function assetMetadata(asset:any){
 const content=asset?.content??{},metadata=content.metadata??{};
 const files=Array.isArray(content.files)?content.files:[];
 const image=files.find((file:any)=>file?.mime?.startsWith('image/'))??files.find((file:any)=>/\.(png|jpe?g|webp|gif)(\?|$)/i.test(file?.uri??''))??files.find((file:any)=>!file?.mime&&(file?.cdn_uri||file?.uri));
 const candidates=[image?.cdn_uri,content.links?.image,metadata.image,image?.uri];
 const imageCandidates=[...new Set(candidates.map(publicMediaUrl).filter((uri):uri is string=>Boolean(uri)))];
 return {name:text(metadata.name,200),symbol:text(metadata.symbol??asset?.token_info?.symbol,40),description:text(metadata.description,5000),
  image:imageCandidates[0]??null,imageCandidates,metadataUri:publicMediaUrl(content.json_uri)};
}
// Only these public content gateways are fetched server-side. No arbitrary token URL or redirects.
const metadataHosts=new Set(['ipfs.io','dweb.link','arweave.net','gateway.pinata.cloud','nftstorage.link','raw.githubusercontent.com']);
export function approvedMetadataUrl(value:unknown):string|null{
 const uri=publicMediaUrl(value);if(!uri)return null;const url=new URL(uri);
 return metadataHosts.has(url.hostname)&&(!url.port||url.port==='443')?uri:null;
}
export async function readPublicMetadata(uri:string):Promise<any>{
 const approved=approvedMetadataUrl(uri);if(!approved)throw new Error('METADATA_HOST_NOT_APPROVED');
 const response=await fetch(approved,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Accept:'application/json'}});
 if(!response.ok)throw new Error('METADATA_HTTP_ERROR');
 const reader=response.body?.getReader();if(!reader)throw new Error('METADATA_EMPTY');
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>64000){await reader.cancel();throw new Error('METADATA_TOO_LARGE');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 const data=JSON.parse(new TextDecoder().decode(bytes));if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('METADATA_INVALID');return data;
}
