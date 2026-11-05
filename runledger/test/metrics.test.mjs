import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from '../server.mjs';
import { openStore } from '../store.mjs';

test('Queue metrics distinguish due work, delayed retries and expired worker leases', t => {
  const store = openStore(':memory:', { leaseMs: 100 });
  t.after(() => store.close());
  const first = store.ingest({ key: 'first', type: 'run.completed', payload: {} }, 1000);
  store.claim(1000);
  store.ingest({ key: 'second', type: 'run.completed', payload: {} }, 1100);
  assert.deepEqual(store.metrics(1050).queue, {
    due_now: 0, scheduled: 1, oldest_due_age_ms: 0, expired_leases: 0
  });
  assert.deepEqual(store.metrics(1200).queue, {
    due_now: 1, scheduled: 0, oldest_due_age_ms: 100, expired_leases: 1
  });
  // Observing an expired lease must not claim work or change the delivery.
  assert.equal(store.detail(first.delivery_id).delivery.status, 'in_flight');
  const secondJob = store.claim(1200);
  store.finish(secondJob, { outcome: 'retry', httpStatus: 503, nextAt: 1500 }, 1201);
  const recovered = store.claim(1201);
  assert.equal(recovered.id, first.delivery_id);
  store.finish(recovered, { outcome: 'delivered', httpStatus: 200 }, 1202);
  const snapshot = store.metrics(1202);
  assert.deepEqual(snapshot.queue, { due_now: 0, scheduled: 1, oldest_due_age_ms: 0, expired_leases: 0 });
  assert.deepEqual(snapshot.deliveries, { queued: 1, in_flight: 0, delivered: 1, dead: 0 });
  assert.deepEqual(snapshot.attempts, { in_flight: 0, delivered: 1, retry: 1, dead: 0, lease_expired: 1 });
});

test('Metrics retain dead-letter attempts after replay completes', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const { delivery_id: id } = store.ingest({ key: 'replay', type: 'run.completed', payload: {} }, 1000);
  store.finish(store.claim(1000), { outcome: 'dead', httpStatus: 400 }, 1001);
  store.replay(id, 1002);
  store.finish(store.claim(1002), { outcome: 'delivered', httpStatus: 200 }, 1003);
  assert.equal(store.metrics(1004).attempts.dead, 1);
  assert.equal(store.metrics(1004).attempts.delivered, 1);
  assert.equal(store.metrics(1004).deliveries.dead, 0);
  assert.equal(store.metrics(1004).deliveries.delivered, 1);
});

test('HTTP metrics are JSON, uncached and complete for an empty ledger', async t => {
  const app = await startApp({ databasePath: ':memory:', port: 0, workerCount: 0 });
  t.after(() => app.close());
  const response = await fetch(app.url + '/api/metrics');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const snapshot = await response.json();
  assert.ok(Number.isSafeInteger(snapshot.observed_at));
  assert.deepEqual(snapshot.queue, { due_now: 0, scheduled: 0, oldest_due_age_ms: 0, expired_leases: 0 });
  assert.ok(Object.values(snapshot.deliveries).every(value => value === 0));
  assert.ok(Object.values(snapshot.attempts).every(value => value === 0));
});
