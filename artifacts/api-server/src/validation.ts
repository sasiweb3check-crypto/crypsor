const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Decode length only; no wallet keys or signing code is involved. */
export function isSolanaAddress(value:unknown):value is string {
 if(typeof value!=='string'||value.length<32||value.length>44)return false;
 let decoded=0n;
 for(const char of value){const digit=alphabet.indexOf(char);if(digit<0)return false;decoded=decoded*58n+BigInt(digit);}
 let bytes=0;
 while(decoded>0n){bytes++;decoded>>=8n;}
 let leadingZeros=0;
 while(value[leadingZeros]==='1')leadingZeros++;
 return bytes+leadingZeros===32;
}
