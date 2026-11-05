import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { retryDecision } from '../retry.mjs';
import { openStore } from '../store.mjs';
import { runWorker } from '../worker.mjs';

const job = { number: 1, max_attempts: 4 };
const now = Date.UTC(2026, 10, 5, 12);
const options = { now, baseDelayMs: 500, random: () => 0 };

test('Retry-After seconds and HTTP dates remain a minimum beyond the backoff cap', () => {
  for (const retryAfter of [
    '120', new Date(now + 120_000).toUTCString(),
    'Thursday, 05-Nov-26 12:02:00 GMT', 'Thu Nov  5 12:02:00 2026'
  ]) {
    const result = retryDecision(job, { httpStatus: 429, retryAfter, error: 'Rate limited' }, options);
    assert.equal(result.outcome, 'retry');
    assert.equal(result.nextAt, now + 120_000);
  }
  assert.equal(retryDecision(job, { httpStatus: 503, retryAfter: '86400' }, options).nextAt, now + 86_400_000);
});

test('Malformed and past Retry-After values fall back to jittered backoff', () => {
  for (const retryAfter of [null, '', '-10', '1.5', 'Infinity', '1e3', 'tomorrow', new Date(now - 1000).toUTCString()]) {
    assert.equal(retryDecision(job, { httpStatus: 503, retryAfter }, options).nextAt, now + 250);
  }
  const low = retryDecision({ ...job, number: 3 }, { httpStatus: 503 }, options);
  const high = retryDecision({ ...job, number: 3 }, { httpStatus: 503 }, { ...options, random: () => 1 });
  assert.equal(low.nextAt, now + 1000);
  assert.equal(high.nextAt, now + 2000);
});

test('Retry policy bounds automatic retries without shortening a long server wait', () => {
  for (const retryAfter of ['86401', '9'.repeat(400), new Date(now + 172_800_000).toUTCString()]) {
    const result = retryDecision(job, { httpStatus: 503, retryAfter }, options);
    assert.equal(result.outcome, 'dead');
    assert.match(result.error, /operator review/);
    assert.equal(result.nextAt, undefined);
  }
  for (const httpStatus of [undefined, 408, 429, 500, 503]) {
    assert.equal(retryDecision(job, { httpStatus }, options).outcome, 'retry');
    assert.equal(retryDecision({ ...job, number: 4 }, { httpStatus }, options).outcome, 'dead');
  }
  for (const httpStatus of [301, 400, 401, 403, 404, 409, 422]) {
    assert.equal(retryDecision(job, { httpStatus }, options).outcome, 'dead');
  }
  for (const httpStatus of [200, 202, 204]) {
    assert.deepEqual(retryDecision(job, { httpStatus }, options), { outcome: 'delivered', httpStatus });
  }
});

test('A real HTTP 429 persists its full cooldown and releases the worker for another delivery', { timeout: 5000 }, async () => {
  const store = openStore(':memory:');
  const received = [];
  const server = createServer((req, res) => {
    req.resume();
    received.push(req.headers['webhook-id']);
    if (received.length === 1) res.writeHead(429, { 'Retry-After': '120' });
    else res.writeHead(200);
    res.end();
  });
  let stop;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const first = store.ingest({ key: 'limited', type: 'run.completed', payload: {} }, 1000);
    const second = store.ingest({ key: 'ready', type: 'run.completed', payload: {} }, 1001);
    const started = Date.now();
    stop = runWorker(store, {
      receiverUrl: 'http://127.0.0.1:' + server.address().port,
      secret: Buffer.from('retry-test'), timeoutMs: 500, baseDelayMs: 10
    });
    const deadline = Date.now() + 2000;
    while (store.detail(second.delivery_id).delivery.status !== 'delivered' && Date.now() < deadline) await delay(10);
    const limited = store.detail(first.delivery_id);
    assert.equal(limited.delivery.status, 'queued');
    assert.ok(limited.delivery.next_at >= started + 120_000);
    assert.equal(limited.attempts[0].http_status, 429);
    assert.equal(store.detail(second.delivery_id).delivery.status, 'delivered');
    assert.deepEqual(received, [first.delivery_id, second.delivery_id]);
  } finally {
    if (stop) await stop();
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
});
