import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseConfig } from './db.ts';
import { isSolanaAddress } from './validation.ts';
test('remote PostgreSQL always verifies certificates and strips TLS override query strings',()=>{
 const config=databaseConfig('postgresql://user:password@example.test/hunter?sslmode=no-verify');
 assert.equal((config.ssl as {rejectUnauthorized:boolean}).rejectUnauthorized,true);
 assert.equal(new URL(config.connectionString!).searchParams.has('sslmode'),false);
});
test('loopback database remains local and pool budgets are bounded',()=>{
 assert.equal(databaseConfig('postgresql://postgres@127.0.0.1/hunter').ssl,undefined);
 const previous=process.env.PG_POOL_MAX;
 try{process.env.PG_POOL_MAX='21';assert.throws(()=>databaseConfig('postgresql://localhost/hunter'),/between 1 and 4/);}
 finally{if(previous===undefined)delete process.env.PG_POOL_MAX;else process.env.PG_POOL_MAX=previous;}
});
test('wallet validation checks decoded public-key byte length, not only alphabet',()=>{
 assert.equal(isSolanaAddress('11111111111111111111111111111111'),true);
 assert.equal(isSolanaAddress('So11111111111111111111111111111111111111112'),true);
 assert.equal(isSolanaAddress('1'.repeat(44)),false);
 assert.equal(isSolanaAddress('A'.repeat(32)),false);
 assert.equal(isSolanaAddress('0'.repeat(44)),false);
});
test('escaped PEM certificate newlines are normalized without weakening trust',()=>{
 const previous=process.env.AIVEN_CA_CERT;
 try{
  process.env.AIVEN_CA_CERT=String.raw`-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----`;
  const ssl=databaseConfig('postgresql://user:pass@database.example/hunter').ssl as {ca:string;rejectUnauthorized:boolean};
  assert.equal(ssl.ca,'-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----');
  assert.equal(ssl.rejectUnauthorized,true);
 } finally {if(previous===undefined)delete process.env.AIVEN_CA_CERT;else process.env.AIVEN_CA_CERT=previous;}
});
