import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('Set TEST_DATABASE_URL to the isolated loopback hunter_pilot_test database');
const parsed = new URL(testUrl);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/hunter_pilot_test') {
  throw new Error('Integration tests require the isolated loopback database hunter_pilot_test');
}
process.env.DATABASE_URL = testUrl;
delete process.env.AIVEN_DATABASE_URL;
process.env.HUNTER_API_TOKEN = 'hunter-integration-only-token-00000000';
process.env.HELIUS_WEBHOOK_SECRET = 'hunter-fixture-webhook-secret';
process.env.TELEGRAM_ENABLED = 'false';
const { pool, initialize } = await import('../artifacts/api-server/src/db.ts');
const { createApp } = await import('../artifacts/api-server/src/app.ts');
const { enqueue, claimJob, finishJob, failJob, recoverJobs } = await import('../artifacts/api-server/src/queue.ts');
const { ingestTransactions } = await import('../artifacts/api-server/src/ingest.ts');
const { researchToken } = await import('../artifacts/api-server/src/research.ts');
let server: Server;
let base: string;
const wallet = '1'.repeat(32), mint = 'B'.repeat(32);
const signature = 's'.repeat(88);
// Synthetic provider-format fixture only. Never seeded into the application database.
const fixture = { signature, timestamp: 1700000000, slot: 123, feePayer: wallet,
  events: { swap: { nativeInput: { account: wallet, amount: '1000000000' },
    tokenOutputs: [{ mint, userAccount: wallet, rawTokenAmount: { tokenAmount: '1000000', decimals: 6 } }] } } };
async function api(path: string, method = 'GET', body?: unknown) {
  return fetch(base + path, { method, headers: { Authorization: `Bearer ${process.env.HUNTER_API_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
before(async () => {
  await pool.query('DROP SCHEMA IF EXISTS hunter CASCADE');
  await initialize();
  await initialize();
  server = createApp(pool).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP test server missing');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
});

test('private API, durable discovery, operator controls, append-only memory and fenced recovery', async t => {
  await t.test('API reads and mutations require authentication; first run has no invented data', async () => {
    assert.equal((await fetch(base + '/api/healthz')).status, 401);
    assert.equal((await fetch(base + '/api/wallets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: wallet }) })).status, 401);
    const overview = await (await api('/api/overview')).json() as any;
    assert.equal(overview.stats.tokens, 0);
    assert.equal(overview.stats.events, 0);
    assert.equal(overview.mode, 'WATCH_ONLY');
    assert.equal((await api('/api/wallets', 'POST', { address: 'invalid' })).status, 400);
    assert.equal((await api('/api/wallets', 'POST', { address: wallet, label: 'Synthetic integration sensor' })).status, 201);
  });
  await t.test('source authentication and duplicate webhook deliveries preserve exactly one buy and alert', async () => {
    assert.equal((await fetch(base + '/api/webhooks/helius', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([fixture]) })).status, 401);
    const headers = { Authorization: process.env.HELIUS_WEBHOOK_SECRET!, 'Content-Type': 'application/json' };
    const deliveries = await Promise.all(Array.from({ length: 3 }, () => fetch(base + '/api/webhooks/helius', { method: 'POST', headers, body: JSON.stringify([fixture]) })));
    assert.ok(deliveries.every(response => response.status === 200));
    assert.equal(Number((await pool.query("SELECT count(*) FROM hunter.onchain_event WHERE event_kind='SWAP_BUY'")).rows[0].count), 1);
    assert.equal(Number((await pool.query('SELECT count(*) FROM hunter.alert')).rows[0].count), 1);
    const room = await (await api('/api/tokens/' + mint)).json() as any;
    assert.equal(room.token.price_usd, null);
    assert.equal(room.token.confidence, 'LOW');
    assert.ok(room.evidence.length > 0);
    assert.equal(room.events.find((event: any) => event.event_kind === 'SWAP_BUY').commitment, 'provider_reported');
  });
  await t.test('incoming transfers and failed swaps are activity, never fabricated discoveries', async () => {
    await ingestTransactions(pool, [{ signature: 't'.repeat(88), timestamp: 1700000000, feePayer: wallet,
      tokenTransfers: [{ mint: 'C'.repeat(32), toUserAccount: wallet, tokenAmount: 1 }] },
    { ...fixture, signature: 'u'.repeat(88), transactionError: 'failed' }]);
    assert.equal(Number((await pool.query('SELECT count(*) FROM hunter.token')).rows[0].count), 1);
    assert.equal(Number((await pool.query("SELECT count(*) FROM hunter.onchain_event WHERE event_kind='SWAP_BUY'")).rows[0].count), 1);
  });
  await t.test('STOP_ALL blocks new ingestion and leasing; mode transitions have audit records', async () => {
    assert.equal((await api('/api/operator/mode', 'POST', { mode: 'STOP_ALL', reason: 'Integration stop gate' })).status, 200);
    assert.equal((await api('/api/ingest', 'POST', { transactions: [{ ...fixture, signature: 'v'.repeat(88) }] })).status, 503);
    assert.equal(await claimJob(pool), undefined);
    assert.equal((await api('/api/operator/mode', 'POST', { mode: 'FULL', reason: 'Resume bounded integration checks' })).status, 200);
    assert.equal(Number((await pool.query("SELECT count(*) FROM hunter.operator_audit WHERE action='mode.change'")).rows[0].count), 2);
  });
  await t.test('expired leases are recovered and stale worker completion is fenced', async () => {
    await pool.query("UPDATE hunter.investigation_job SET status='done',finished_at=now()");
    await enqueue('research', mint, {}, 'fixture:fence', pool);
    const original = await claimJob(pool);
    assert.ok(original);
    await pool.query("UPDATE hunter.investigation_job SET lease_until=now()-interval '1 minute' WHERE id=$1", [original.id]);
    await recoverJobs(pool);
    const replacement = await claimJob(pool);
    assert.ok(replacement);
    assert.equal(replacement.id, original.id);
    assert.notEqual(replacement.lease_token, original.lease_token);
    assert.equal(await finishJob(original, pool), false);
    assert.equal(await finishJob(replacement, pool), true);
    await enqueue('research', mint, {}, 'fixture:failure', pool);
    const failing = await claimJob(pool);
    assert.ok(failing);
    await pool.query('UPDATE hunter.investigation_job SET max_attempts=attempts WHERE id=$1', [failing.id]);
    await failJob(failing, new Error('https://example.invalid/?secret=DO_NOT_STORE'), pool);
    const dead = (await pool.query('SELECT status,last_error FROM hunter.investigation_job WHERE id=$1', [failing.id])).rows[0];
    assert.equal(dead.status, 'dead');
    assert.ok(!dead.last_error.includes('DO_NOT_STORE'));
    assert.equal((await api('/api/jobs/' + failing.id + '/retry', 'POST', {})).status, 200);
  });
  await t.test('research appends cited versions and rechecks; reconciliation adds evidence without duplicate events', async () => {
    const first = await researchToken(pool, mint) as any;
    assert.equal(first.version, 1);
    assert.equal(first.action, 'INSUFFICIENT_EVIDENCE');
    assert.equal(first.model_version, 'none');
    assert.ok(first.evidence_ids.length > 0);
    assert.ok(first.unknowns.some((gap: string) => gap.includes('UNKNOWN')));
    const before = Number((await pool.query('SELECT count(*) FROM hunter.evidence_claim')).rows[0].count);
    await ingestTransactions(pool, [fixture], { source: 'synthetic_finalized_reconciliation', trustedCommitment: 'finalized' });
    const second = await researchToken(pool, mint) as any;
    assert.equal(second.version, 2);
    assert.ok(Number((await pool.query('SELECT count(*) FROM hunter.evidence_claim')).rows[0].count) > before);
    assert.equal((await pool.query("SELECT commitment FROM hunter.onchain_event WHERE event_kind='SWAP_BUY'")).rows[0].commitment, 'finalized');
    assert.equal(Number((await pool.query('SELECT count(*) FROM hunter.onchain_event')).rows[0].count), 4);
    assert.ok((await pool.query("SELECT 1 FROM hunter.investigation_job WHERE dedupe_key LIKE 'revisit:%' AND run_after>now()")).rowCount! > 0);
    assert.equal((await pool.query('SELECT version FROM hunter.decision_version ORDER BY version')).rows.length, 2);
  });
  await t.test('historical claims and judgments reject silent changes; wallet removal preserves observations', async () => {
    await assert.rejects(pool.query("UPDATE hunter.evidence_claim SET claim='silently changed'"), /append-only/);
    await assert.rejects(pool.query('DELETE FROM hunter.decision_version'), /append-only/);
    assert.equal((await api('/api/wallets/' + wallet, 'DELETE')).status, 200);
    assert.equal(Number((await pool.query('SELECT count(*) FROM hunter.onchain_event')).rows[0].count), 4);
    const memory = await (await api('/api/memory?q=' + mint)).json() as any;
    assert.equal(memory.tokens.length, 1);
    assert.ok(memory.claims.length > 0);
    const operations = await (await api('/api/operations')).json() as any;
    assert.ok(operations.metrics.schema_bytes > 0);
    assert.ok(JSON.stringify(operations).indexOf(process.env.HUNTER_API_TOKEN!) === -1);
  });
});
