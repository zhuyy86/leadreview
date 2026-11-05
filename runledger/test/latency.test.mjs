import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStore } from '../store.mjs';

function summary(count, min, mean, max, p50, p95 = max, invalid = 0) {
  return { sample_count: count, invalid_sample_count: invalid, min_ms: min, mean_ms: mean,
    max_ms: max, p50_ms: p50, p95_ms: p95, p99_ms: max };
}

test('Latency separates original event age, successful generation time and individual attempts', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  store.ingest({ key: 'direct', type: 'run.completed', payload: {} }, 1000);
  store.finish(store.claim(1100), { outcome: 'delivered', httpStatus: 200 }, 1130);
  const replay = store.ingest({ key: 'replay', type: 'run.completed', payload: {} }, 1000);
  store.finish(store.claim(1200), { outcome: 'dead', httpStatus: 400 }, 1210);
  assert.equal(store.metrics().latency.event_to_delivery.sample_count, 1);
  store.replay(replay.delivery_id, 2000);
  store.finish(store.claim(2050), { outcome: 'retry', httpStatus: 503, nextAt: 2200 }, 2060);
  store.finish(store.claim(2200), { outcome: 'delivered', httpStatus: 200 }, 2240);
  const latency = store.metrics(2250).latency;
  assert.deepEqual(latency.attempt, summary(4, 10, 22.5, 40, 10));
  assert.deepEqual(latency.event_to_delivery, summary(2, 130, 685, 1240, 130));
  assert.deepEqual(latency.generation_to_delivery, summary(2, 30, 110, 190, 30));
});

test('Latency excludes unfinished work and reports empty or negative-clock samples explicitly', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const empty = summary(0, null, null, null, null, null);
  assert.deepEqual(store.metrics().latency.attempt, empty);
  store.ingest({ key: 'clock', type: 'run.completed', payload: {} }, 5000);
  const job = store.claim(5100);
  assert.deepEqual(store.metrics().latency.attempt, empty);
  store.finish(job, { outcome: 'delivered', httpStatus: 200 }, 5090);
  const latency = store.metrics().latency;
  assert.deepEqual(latency.attempt, { ...empty, invalid_sample_count: 1 });
  assert.deepEqual(latency.generation_to_delivery, { ...empty, invalid_sample_count: 1 });
  assert.deepEqual(latency.event_to_delivery, summary(1, 90, 90, 90, 90));
});

test('Nearest-rank percentiles distinguish the 99th sample from the maximum', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  for (let elapsed = 1; elapsed <= 100; elapsed++) {
    store.ingest({ key: 'quantile-' + elapsed, type: 'run.completed', payload: {} }, 1000);
    store.finish(store.claim(1000), { outcome: 'delivered', httpStatus: 200 }, 1000 + elapsed);
  }
  for (const population of Object.values(store.metrics().latency)) {
    assert.deepEqual(population, {
      sample_count: 100, invalid_sample_count: 0, min_ms: 1, mean_ms: 50.5,
      max_ms: 100, p50_ms: 50, p95_ms: 95, p99_ms: 99
    });
  }
});
