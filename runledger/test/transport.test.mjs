import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '../store.mjs';
import { runWorker } from '../worker.mjs';

async function deliveryFixture(t, handler, { timeoutMs = 150, maxAttempts = 3 } = {}) {
  const receiver = createServer(handler);
  await new Promise((ready, reject) => {
    receiver.once('error', reject);
    receiver.listen(0, '127.0.0.1', ready);
  });
  const store = openStore(':memory:', { leaseMs: 1000, maxAttempts });
  const { delivery_id: id } = store.ingest({ key: 'transport', type: 'run.completed', payload: { ready: true } });
  const stop = runWorker(store, {
    receiverUrl: `http://127.0.0.1:${receiver.address().port}/webhook`,
    secret: Buffer.from('transport-test-secret'), timeoutMs, baseDelayMs: 10
  });
  t.after(async () => {
    await stop();
    await new Promise((done, reject) => {
      receiver.close(error => error ? reject(error) : done());
      receiver.closeAllConnections();
    });
    store.close();
  });
  return { store, id, stop };
}

async function waitFor(store, id, predicate) {
  const deadline = Date.now() + 5000;
  do {
    const detail = store.detail(id);
    if (predicate(detail)) return detail;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail('Delivery did not reach the expected transport state');
}

test('A rate-limited receiver is retried and then acknowledges the same delivery ID', async t => {
  const receivedIds = [];
  const { store, id } = await deliveryFixture(t, (req, res) => {
    req.resume();
    receivedIds.push(req.headers['webhook-id']);
    res.writeHead(receivedIds.length === 1 ? 429 : 204, { 'Retry-After': '0' });
    res.end();
  });
  const detail = await waitFor(store, id, ({ delivery }) => delivery.status === 'delivered');
  assert.deepEqual(receivedIds, [id, id]);
  assert.deepEqual(detail.attempts.map(row => row.http_status), [204, 429]);
});

test('A permanent HTTP 400 enters dead letter without consuming the whole retry budget', async t => {
  let requests = 0;
  const { store, id } = await deliveryFixture(t, (req, res) => {
    req.resume();
    requests++;
    res.writeHead(400);
    res.end();
  });
  const detail = await waitFor(store, id, ({ delivery }) => delivery.status === 'dead');
  assert.equal(requests, 1);
  assert.equal(detail.attempts.length, 1);
  assert.equal(detail.attempts[0].http_status, 400);
});

test('A redirect is recorded as terminal and is never followed to another path', async t => {
  const paths = [];
  const { store, id } = await deliveryFixture(t, (req, res) => {
    req.resume();
    paths.push(req.url);
    res.writeHead(302, { Location: '/unexpected-target' });
    res.end();
  });
  const detail = await waitFor(store, id, ({ delivery }) => delivery.status === 'dead');
  assert.deepEqual(paths, ['/webhook']);
  assert.equal(detail.attempts[0].http_status, 302);
});

test('A receiver that never sends headers times out and exhausts a bounded retry budget', async t => {
  let requests = 0;
  const { store, id } = await deliveryFixture(t, req => {
    req.resume();
    requests++;
  }, { timeoutMs: 80, maxAttempts: 2 });
  const detail = await waitFor(store, id, ({ delivery }) => delivery.status === 'dead');
  assert.equal(requests, 2);
  assert.equal(detail.attempts.length, 2);
  assert.ok(detail.attempts.every(row => row.error === 'Receiver timed out'));
});

test('HTTP Retry-After remains a minimum wait even above the backoff cap', async t => {
  const { store, id, stop } = await deliveryFixture(t, (req, res) => {
    req.resume();
    res.writeHead(429, { 'Retry-After': '120' });
    res.end();
  });
  const detail = await waitFor(store, id, ({ delivery }) => delivery.status === 'queued' && delivery.attempt_count === 1);
  await stop();
  const waitMs = detail.delivery.next_at - detail.attempts[0].finished_at;
  assert.ok(waitMs >= 119_500 && waitMs <= 120_000, `Unexpected receiver retry window: ${waitMs}`);
  assert.equal(detail.attempts[0].http_status, 429);
});
