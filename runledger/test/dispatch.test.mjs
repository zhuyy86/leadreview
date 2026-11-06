import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { snapshotLedger } from '../maintenance.mjs';
import { startApp } from '../server.mjs';
import { openStore } from '../store.mjs';

const event = { key: 'dispatch', type: 'ai.completed', payload: { result: 'ready' } };

async function disk(t) {
  const root = await mkdtemp(join(tmpdir(), 'runledger-dispatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return name => join(root, name);
}

async function waitFor(predicate, message) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(message);
}

test('Paused dispatch admits and deduplicates events while preserving queue and attempt counts', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  assert.deepEqual(store.dispatchStatus(), { paused: false, revision: 0, updated_at: 0 });
  const paused = store.setDispatch({ paused: true, expected_revision: 0 }, 100);
  assert.deepEqual(paused, { paused: true, revision: 1, updated_at: 100 });
  const first = store.ingest(event, 200);
  assert.equal(store.ingest(event, 201).delivery_id, first.delivery_id);
  assert.equal(store.claim(202), null);
  assert.equal(store.metrics(202).deliveries.queued, 1);
  assert.equal(store.metrics(202).attempts.in_flight, 0);
  assert.equal(store.detail(first.delivery_id).attempts.length, 0);
  assert.deepEqual(store.overview().dispatch, paused);
  assert.deepEqual(store.metrics(202).dispatch, paused);
  store.setDispatch({ paused: false, expected_revision: 1 }, 300);
  assert.equal(store.claim(300).id, first.delivery_id);
});

test('Dispatch pause lets an in-flight request finish and holds later tasks', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  store.ingest(event, 100);
  const flight = store.claim(100);
  store.setDispatch({ paused: true, expected_revision: 0 }, 101);
  store.ingest({ ...event, key: 'later' }, 102);
  assert.equal(store.finish(flight, { outcome: 'delivered' }, 103), true);
  assert.equal(store.claim(104), null);
  assert.equal(store.metrics(104).deliveries.delivered, 1);
  assert.equal(store.metrics(104).deliveries.queued, 1);
});

test('Expired leases stay observable during pause and are reclaimed with fencing after resume', t => {
  const store = openStore(':memory:', { leaseMs: 100 });
  t.after(() => store.close());
  const first = store.ingest(event, 100);
  const stale = store.claim(100);
  store.setDispatch({ paused: true, expected_revision: 0 }, 101);
  assert.equal(store.claim(300), null);
  assert.equal(store.metrics(300).queue.expired_leases, 1);
  assert.equal(store.detail(first.delivery_id).attempts[0].outcome, 'in_flight');
  store.setDispatch({ paused: false, expected_revision: 1 }, 301);
  const fresh = store.claim(301);
  assert.equal(fresh.id, first.delivery_id);
  assert.notEqual(fresh.token, stale.token);
  assert.equal(store.finish(stale, { outcome: 'delivered' }, 302), false);
  assert.equal(store.finish(fresh, { outcome: 'delivered' }, 302), true);
});

test('A dead-letter replay waits under pause while preserving both generations', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const first = store.ingest(event, 100);
  store.finish(store.claim(100), { outcome: 'dead' }, 101);
  store.setDispatch({ paused: true, expected_revision: 0 }, 102);
  store.replay(first.delivery_id, 103);
  assert.equal(store.claim(104), null);
  assert.equal(store.detail(first.delivery_id).delivery.generation, 2);
  store.setDispatch({ paused: false, expected_revision: 1 }, 105);
  store.finish(store.claim(105), { outcome: 'delivered' }, 106);
  assert.deepEqual(store.detail(first.delivery_id).attempts.map(a => a.outcome), ['delivered', 'dead']);
});

test('Two connections enforce optimistic revisions and same-state requests preserve revisions', async t => {
  const path = await disk(t);
  const first = openStore(path('ledger.sqlite'));
  const second = openStore(path('ledger.sqlite'));
  try {
    const read = second.dispatchStatus();
    first.setDispatch({ paused: true, expected_revision: read.revision }, 100);
    assert.throws(() => second.setDispatch({ paused: false, expected_revision: read.revision }, 101), e => e.status === 409);
    assert.deepEqual(second.dispatchStatus(), { paused: true, revision: 1, updated_at: 100 });
    assert.deepEqual(second.setDispatch({ paused: true, expected_revision: 1 }, 102), second.dispatchStatus());
    assert.equal(first.dispatchStatus().revision, 1);
    second.setDispatch({ paused: false, expected_revision: 1 }, 103);
    assert.equal(first.dispatchStatus().revision, 2);
  } finally { first.close(); second.close(); }
});

test('Paused control survives restart and a WAL snapshot restore', async t => {
  const path = await disk(t);
  let store = openStore(path('source.sqlite'));
  store.ingest(event, 100);
  store.setDispatch({ paused: true, expected_revision: 0 }, 101);
  store.close();
  store = openStore(path('source.sqlite'));
  try {
    assert.equal(store.claim(200), null);
    await snapshotLedger({ source: path('source.sqlite'), output: path('restored.sqlite') });
    const restored = openStore(path('restored.sqlite'));
    try {
      assert.deepEqual(restored.dispatchStatus(), store.dispatchStatus());
      assert.equal(restored.claim(200), null);
      restored.setDispatch({ paused: false, expected_revision: 1 }, 201);
      assert.equal(restored.claim(201).number, 1);
    } finally { restored.close(); }
  } finally { store.close(); }
});

test('A legacy database initializes running dispatch while preserving queued events', async t => {
  const path = await disk(t);
  const store = openStore(path('legacy.sqlite'));
  const first = store.ingest(event, 100);
  store.close();
  const raw = new DatabaseSync(path('legacy.sqlite'));
  raw.exec('DROP TABLE dispatch_control');
  raw.close();
  // Backups created before this feature also remain valid inputs.
  await snapshotLedger({ source: path('legacy.sqlite'), output: path('restored.sqlite') });
  const migrated = openStore(path('restored.sqlite'));
  try {
    assert.equal(migrated.dispatchStatus().paused, false);
    assert.equal(migrated.claim(200).id, first.delivery_id);
  } finally { migrated.close(); }
});

test('Dispatch HTTP validates body, origin and revisions and returns uncached state', async t => {
  const app = await startApp({ databasePath: ':memory:', port: 0, workerCount: 0 });
  t.after(() => app.close());
  const get = await fetch(app.url + '/api/dispatch');
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.equal((await get.json()).paused, false);
  async function post(body, extra = {}) {
    return fetch(app.url + '/api/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  }
  assert.equal((await post({ paused: true, expected_revision: 0 })).status, 200);
  assert.equal((await post({ paused: false, expected_revision: 0 })).status, 409);
  for (const body of [{ paused: 'true', expected_revision: 1 }, { paused: true },
    { paused: true, expected_revision: -1 }, { paused: true, expected_revision: 1, extra: 1 }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post({ paused: false, expected_revision: 1 }, { Origin: 'https://example.test' })).status, 403);
  assert.equal((await post({ paused: false, expected_revision: 1 })).status, 200);
  assert.equal(app.store.dispatchStatus().revision, 2);
});

test('Live workers hold paused HTTP submissions and drain them once after resume', async t => {
  const app = await startApp({ databasePath: ':memory:', port: 0, workerCount: 2, timeoutMs: 500, baseDelayMs: 20 });
  t.after(() => app.close());
  const headers = { 'Content-Type': 'application/json' };
  async function control(paused, revision) {
    const response = await fetch(app.url + '/api/dispatch', { method: 'POST', headers,
      body: JSON.stringify({ paused, expected_revision: revision }) });
    assert.equal(response.status, 200);
  }
  await control(true, 0);
  const send = key => fetch(app.url + '/api/events', { method: 'POST', headers: { ...headers, 'Idempotency-Key': key },
    body: JSON.stringify({ type: 'ai.completed', payload: {} }) });
  await Promise.all(Array.from({ length: 20 }, (_, i) => send('held-' + i % 10)));
  // Allow worker polling to observe pause; tasks retain zero attempts.
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(app.store.metrics().deliveries.queued, 10);
  assert.equal(app.store.metrics().attempts.in_flight, 0);
  assert.equal(app.store.metrics().receiver.processed, 0);
  await control(false, 1);
  await waitFor(() => app.store.metrics().deliveries.delivered === 10, 'Workers must drain after resume');
  assert.equal(app.store.metrics().receiver.processed, 10);
  assert.equal(app.store.metrics().attempts.delivered, 10);
});
