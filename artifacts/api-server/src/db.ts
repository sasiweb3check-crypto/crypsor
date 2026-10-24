import pg from 'pg';
import { schemaSql } from './schema.ts';
export type Queryable = Pick<pg.Pool, 'query'>;
export function databaseConfig(url = process.env.AIVEN_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim()): pg.PoolConfig {
  const max = Number(process.env.PG_POOL_MAX ?? 2);
  if (!Number.isInteger(max) || max < 1 || max > 4) throw new Error('PG_POOL_MAX must be between 1 and 4; reserve the 20-connection account budget across deployments');
  const remote = url && !['localhost','127.0.0.1','::1','[::1]'].includes(new URL(url).hostname);
  if (remote) {
    const parsed = new URL(url!);
    for (const name of ['sslmode','sslrootcert','sslcert','sslkey']) parsed.searchParams.delete(name);
    url = parsed.toString();
  }
  return { connectionString: url, max, connectionTimeoutMillis: 10000, statement_timeout: 15000,
    ssl: remote ? {rejectUnauthorized:true,...(process.env.AIVEN_CA_CERT ? {ca:process.env.AIVEN_CA_CERT.replace(/\\n/g,'\n')} : {})} : undefined };
}
export const pool = new pg.Pool(databaseConfig());
pool.on('error', () => console.error('Hunter database connection error'));
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>, database: pg.Pool = pool): Promise<T> {
  const client = await database.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function initialize(database: pg.Pool = pool) {
  await withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('hunter:migration:v0.2'))");
    await client.query(schemaSql);
  }, database);
}
