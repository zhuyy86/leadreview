import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { snapshotLedger } from '../maintenance.mjs';
import { startApp } from '../server.mjs';
import { openStore } from '../store.mjs';

const execute = promisify(execFile);
function dead(store, key, time = 100) {
  const first = store.ingest({ key, type: 'job.completed', payload: { key } }, time);
  store.finish(store.claim(time), { outcome: 'dead', httpStatus: 503 }, time + 1);
  return { id: first.delivery_id, generation: 1 };
}
async function disk(t) {
  const root = await mkdtemp(join(tmpdir(), 'runledger-actions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return name => join(root, name);
}

test('Batch replay queues each expected generation in one transaction and records a stable receipt', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const targets = [dead(store, 'a'), dead(store, 'b')];
  const result = store.replayMany({ operation_key: 'operator-1', deliveries: targets }, 200);
  assert.equal(result.replayed_count, 2);
  assert.equal(result.duplicate, false);
  for (const target of targets) {
    const detail = store.detail(target.id);
    assert.equal(detail.delivery.status, 'queued');
    assert.equal(detail.delivery.generation, 2);
    assert.equal(detail.delivery.attempt_count, 0);
    assert.equal(detail.attempts[0].outcome, 'dead');
  }
  const repeated = store.replayMany({ operation_key: 'operator-1', deliveries: [...targets].reverse() }, 300);
  assert.deepEqual(repeated, { ...result, duplicate: true });
  assert.equal(store.operatorActions().length, 1);
  assert.equal(store.operatorActions()[0].action_id, result.action_id);
  assert.equal(store.operatorActions()[0].created_at, 200);
});

test('A stale target aborts the complete selection while valid dead letters retain their generation', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const valid = dead(store, 'valid');
  const stale = dead(store, 'stale');
  store.replay(stale.id, 200);
  assert.throws(() => store.replayMany({ operation_key: 'conflict', deliveries: [valid, stale] }, 201), e => e.status === 409);
  assert.equal(store.detail(valid.id).delivery.status, 'dead');
  assert.equal(store.detail(valid.id).delivery.generation, 1);
  assert.equal(store.operatorActions().length, 0);
});

test('A database failure after the first replay update rolls back every target and the receipt', async t => {
  const path = await disk(t);
  const store = openStore(path('ledger.sqlite'));
  const raw = new DatabaseSync(path('ledger.sqlite'));
  try {
    const targets = [dead(store, 'a'), dead(store, 'b')].sort((a, b) => a.id.localeCompare(b.id));
    raw.exec(`CREATE TRIGGER abort_second BEFORE UPDATE ON deliveries WHEN OLD.id = '${targets[1].id}'
      BEGIN SELECT RAISE(ABORT, 'injected replay failure'); END;`);
    assert.throws(() => store.replayMany({ operation_key: 'rollback', deliveries: targets }), /injected/);
    for (const target of targets) assert.equal(store.detail(target.id).delivery.generation, 1);
    assert.equal(store.operatorActions().length, 0);
    raw.exec('DROP TRIGGER abort_second');
    assert.equal(store.replayMany({ operation_key: 'rollback', deliveries: targets }).replayed_count, 2);
  } finally { raw.close(); store.close(); }
});

test('Two real operator processes sharing a key record one action and one generation transition', async t => {
  const path = await disk(t);
  const store = openStore(path('ledger.sqlite'));
  try {
    const target = dead(store, 'race');
    const body = { operation_key: 'shared-process-key', deliveries: [target] };
    const script = `const { openStore } = await import(${JSON.stringify(new URL('../store.mjs', import.meta.url).href)});
      const store = openStore(process.argv[1]);
      try { console.log(JSON.stringify(store.replayMany(JSON.parse(process.argv[2])))); } finally { store.close(); }`;
    const runs = await Promise.all([1, 2].map(() => execute(process.execPath,
      ['--input-type=module', '-e', script, path('ledger.sqlite'), JSON.stringify(body)])));
    const results = runs.map(run => JSON.parse(run.stdout));
    assert.equal(new Set(results.map(result => result.action_id)).size, 1);
    assert.deepEqual(results.map(result => result.duplicate).sort(), [false, true]);
    assert.equal(store.operatorActions().length, 1);
    assert.equal(store.detail(target.id).delivery.generation, 2);
  } finally { store.close(); }
});

test('A lost operator acknowledgment can be retried after delivery completes', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const target = dead(store, 'delivered-after-operation');
  const body = { operation_key: 'lost-ack', deliveries: [target] };
  const first = store.replayMany(body, 200);
  store.finish(store.claim(200), { outcome: 'delivered' }, 201);
  const retry = store.replayMany(body, 300);
  assert.equal(retry.action_id, first.action_id);
  assert.equal(retry.duplicate, true);
  assert.equal(store.detail(target.id).delivery.generation, 2);
  assert.equal(store.detail(target.id).delivery.status, 'delivered');
});

test('Operation key conflicts, invalid target shapes and oversized selections preserve state', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const target = dead(store, 'validation');
  for (const body of [null, {}, { operation_key: 'x', deliveries: [] },
    { operation_key: 'x', deliveries: [target, target] },
    { operation_key: 'x', deliveries: [{ ...target, generation: 0 }] },
    { operation_key: 'x', deliveries: [{ ...target, extra: 1 }] },
    { operation_key: 'x', deliveries: Array(51).fill(target) }]) {
    assert.throws(() => store.replayMany(body), e => e.status === 400);
  }
  store.replayMany({ operation_key: 'used', deliveries: [target] }, 200);
  assert.throws(() => store.replayMany({ operation_key: 'used', deliveries: [{ ...target, generation: 2 }] }), e => e.status === 409);
  assert.equal(store.operatorActions().length, 1);
});

test('Operator receipts and their idempotency survive restart and snapshot recovery', async t => {
  const path = await disk(t);
  let store = openStore(path('source.sqlite'));
  const target = dead(store, 'restore');
  const body = { operation_key: 'restore-key', deliveries: [target] };
  const first = store.replayMany(body, 200);
  store.close();
  store = openStore(path('source.sqlite'));
  try {
    assert.equal(store.replayMany(body).duplicate, true);
    await snapshotLedger({ source: path('source.sqlite'), output: path('restored.sqlite') });
    const restored = openStore(path('restored.sqlite'));
    try {
      assert.equal(restored.replayMany(body).action_id, first.action_id);
      assert.equal(restored.replayMany(body).duplicate, true);
      assert.equal(restored.operatorActions().length, 1);
    } finally { restored.close(); }
  } finally { store.close(); }
});

test('Batch HTTP returns 202 then 200 for retries and exposes bounded operation history', async t => {
  const app = await startApp({ databasePath: ':memory:', port: 0, workerCount: 0 });
  t.after(() => app.close());
  const target = dead(app.store, 'http');
  const body = { operation_key: 'http-key', deliveries: [target] };
  async function post(value, origin) {
    return fetch(app.url + '/api/replays', { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(value) });
  }
  assert.equal((await post(body, 'https://example.test')).status, 403);
  assert.equal((await post(body)).status, 202);
  assert.equal((await post(body)).status, 200);
  assert.equal((await post({ ...body, deliveries: [] })).status, 400);
  const history = await fetch(app.url + '/api/actions?limit=1');
  assert.equal(history.status, 200);
  assert.equal(history.headers.get('cache-control'), 'no-store');
  assert.equal((await history.json()).actions[0].operation_key, 'http-key');
  for (const query of ['limit=0', 'limit=101', 'limit=1&limit=2', 'other=1']) {
    assert.equal((await fetch(app.url + '/api/actions?' + query)).status, 400);
  }
});
