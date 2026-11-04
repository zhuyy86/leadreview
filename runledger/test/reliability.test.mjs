import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '../store.mjs';
import { sign } from '../worker.mjs';

async function fixture(t) {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'runledger-test-'));
  const databasePath = join(directory, 'ledger.sqlite');
  const disposers = [];

  t.after(async () => {
    try {
      for (const dispose of disposers.reverse()) await dispose();
    } finally {
      assert.equal(dirname(await realpath(directory)), temporaryRoot);
      await rm(directory, { recursive: true, force: true });
    }
  });

  return {
    databasePath,
    defer: dispose => disposers.push(dispose),
    open(options) {
      const store = openStore(databasePath, options);
      disposers.push(() => store.close());
      return store;
    }
  };
}

const event = {
  key: 'model-run-42',
  type: 'run.completed',
  payload: { run: { id: 42, version: 2 }, tokens: [3, 5] }
};

test('SQLite canonical payloads deduplicate across connections and changed payloads conflict', async t => {
  const db = await fixture(t);
  const producer = db.open();
  const independentProducer = db.open();
  const original = producer.ingest(event, 1000);
  const reordered = independentProducer.ingest({
    ...event,
    payload: { tokens: [3, 5], run: { version: 2, id: 42 } }
  }, 1100);

  assert.equal(original.duplicate, false);
  assert.deepEqual(reordered, { ...original, duplicate: true });
  assert.throws(
    () => independentProducer.ingest({ ...event, payload: { ...event.payload, tokens: [5, 3] } }, 1200),
    { status: 409 }
  );
  assert.throws(
    () => producer.ingest({ ...event, type: 'run.failed' }, 1250),
    { status: 409 }
  );
  assert.equal(producer.overview().stats.queued, 1);
});

test('SQLite lease fencing rejects an old worker before and after reassignment', async t => {
  const db = await fixture(t);
  const worker = db.open({ leaseMs: 100 });
  const otherWorker = db.open({ leaseMs: 100 });
  const { delivery_id: id } = worker.ingest(event, 1000);
  const first = worker.claim(1000);

  assert.equal(first.id, id);
  assert.equal(otherWorker.claim(1099), null);
  assert.equal(worker.finish(first, { outcome: 'delivered' }, 1100), false);

  const second = otherWorker.claim(1100);
  assert.equal(second.id, id);
  assert.equal(second.number, 2);
  assert.notEqual(second.token, first.token);
  assert.equal(worker.finish(first, { outcome: 'delivered' }, 1101), false);
  assert.equal(otherWorker.finish(second, { outcome: 'delivered', httpStatus: 200 }, 1102), true);
  assert.deepEqual(worker.detail(id).attempts.map(attempt => attempt.outcome), [
    'delivered', 'lease_expired'
  ]);
});

test('SQLite retry exhaustion and replay preserve identity, generation and attempt history', async t => {
  const db = await fixture(t);
  const store = db.open({ maxAttempts: 2, leaseMs: 100 });
  const { delivery_id: id, event_id: eventId } = store.ingest(event, 1000);
  assert.throws(() => store.replay(id, 1000), { status: 409 });

  const first = store.claim(1000);
  assert.equal(store.finish(first, {
    outcome: 'retry', httpStatus: 503, nextAt: 1020, error: 'Unavailable'
  }, 1001), true);
  assert.equal(store.claim(1019), null);
  const second = store.claim(1020);
  assert.equal(second.number, 2);

  // Exhaust a generation by losing the last worker without a completion.
  assert.equal(store.claim(1120), null);
  assert.equal(store.detail(id).delivery.status, 'dead');
  store.replay(id, 1200);
  const replayed = store.claim(1200);
  assert.equal(replayed.id, id);
  assert.equal(replayed.event_id, eventId);
  assert.equal(replayed.generation, 2);
  assert.equal(replayed.number, 1);
  assert.equal(store.finish(replayed, { outcome: 'delivered', httpStatus: 200 }, 1201), true);

  const detail = store.detail(id);
  assert.equal(detail.delivery.status, 'delivered');
  assert.deepEqual(
    detail.attempts.map(({ generation, number, outcome }) => [generation, number, outcome]),
    [[2, 1, 'delivered'], [1, 2, 'lease_expired'], [1, 1, 'retry']]
  );
  assert.deepEqual(store.ingest(event, 1250), { delivery_id: id, event_id: eventId, duplicate: true });
});

test('SQLite inbox accepts a repeated delivery once after reopening the database', async t => {
  const { databasePath, open } = await fixture(t);
  const { delivery_id: id } = open().ingest(event, 1000);
  const firstReceiver = openStore(databasePath);
  try {
    assert.deepEqual(firstReceiver.receive(id, 1001), { status: 200, duplicate: false });
  } finally {
    firstReceiver.close();
  }

  const restartedReceiver = open();
  assert.deepEqual(restartedReceiver.receive(id, 2000), { status: 200, duplicate: true });
  const { processed, duplicates } = restartedReceiver.overview().receiver;
  assert.deepEqual({ processed, duplicates }, { processed: 1, duplicates: 1 });
});

test('Worker processes race for one claim, then recover after killing the owner', { timeout: 10_000 }, async t => {
  const db = await fixture(t);
  const store = db.open({ leaseMs: 100 });
  const { delivery_id: id } = store.ingest(event, 1000);
  const childSource = `
    const [moduleUrl, databasePath] = process.argv.slice(1);
    const { openStore } = await import(moduleUrl);
    const store = openStore(databasePath, { leaseMs: 100 });
    process.once('message', () => {
      process.send({ claim: store.claim(1000) });
      setInterval(() => {}, 1000);
    });
    process.send('ready');
  `;

  const workers = Array.from({ length: 2 }, () => {
    const child = spawn(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '-e', childSource,
      new URL('../store.mjs', import.meta.url).href,
      db.databasePath
    ], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
    const exited = once(child, 'exit');
    const ready = once(child, 'message');
    db.defer(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    });
    return { child, ready, exited };
  });

  for (const worker of workers) assert.equal((await worker.ready)[0], 'ready');
  const results = await Promise.all(workers.map(async worker => {
    const result = once(worker.child, 'message');
    worker.child.send('claim');
    const [{ claim }] = await result;
    return { ...worker, claim };
  }));
  const owners = results.filter(result => result.claim !== null);
  assert.equal(owners.length, 1);
  assert.equal(owners[0].claim.id, id);
  assert.equal(store.detail(id).delivery.status, 'in_flight');
  assert.equal(owners[0].child.kill(), true);
  await owners[0].exited;

  const restarted = db.open({ leaseMs: 100 });
  assert.equal(restarted.claim(1099), null);
  const recovered = restarted.claim(1100);
  assert.equal(recovered.id, id);
  assert.equal(recovered.number, 2);
  assert.equal(restarted.finish(recovered, { outcome: 'delivered', httpStatus: 200 }, 1101), true);
  assert.deepEqual(
    restarted.detail(id).attempts.map(({ number, outcome }) => [number, outcome]),
    [[2, 'delivered'], [1, 'lease_expired']]
  );
});

async function waitForStatus(url, deliveryId, status) {
  const deadline = Date.now() + 5000;
  let detail;
  do {
    const response = await fetch(`${url}/api/deliveries/${deliveryId}`, {
      signal: AbortSignal.timeout(1000)
    });
    assert.equal(response.status, 200);
    detail = await response.json();
    if (detail.delivery.status === status) return detail;
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail(`Expected delivery ${deliveryId} to reach ${status}, got ${detail.delivery.status}`);
}

test('HTTP workers retry a real 503, exhaust the budget, and recover via audited replay', { timeout: 15_000 }, async t => {
  const { startApp } = await import('../server.mjs');
  const db = await fixture(t);
  const app = await startApp({
    databasePath: db.databasePath,
    port: 0,
    workerCount: 2,
    baseDelayMs: 20,
    timeoutMs: 250,
    leaseMs: 600,
    maxAttempts: 3
  });
  db.defer(() => app.close());
  const url = String(app.url).replace(/\/$/, '');
  function post(path, body, headers = {}) {
    return fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000)
    });
  }

  assert.ok((await post('/api/demo/receiver', { mode: 'down' })).ok);
  const headers = { 'Idempotency-Key': event.key };
  const request = { type: event.type, payload: event.payload };
  const intake = await post('/api/events', request, headers);
  assert.equal(intake.status, 202);
  const { delivery_id: id, event_id: eventId, duplicate } = await intake.json();
  assert.ok(id);
  assert.ok(eventId);
  assert.equal(duplicate, false);
  const duplicateIntake = await post('/api/events', request, headers);
  assert.equal(duplicateIntake.status, 200);
  assert.deepEqual(await duplicateIntake.json(), { delivery_id: id, event_id: eventId, duplicate: true });
  assert.equal((await post('/api/events', { ...request, payload: { changed: true } }, headers)).status, 409);

  const dead = await waitForStatus(url, id, 'dead');
  assert.equal(dead.delivery.generation, 1);
  assert.deepEqual(
    dead.attempts.map(({ number, outcome, http_status }) => [number, outcome, http_status]),
    [[3, 'dead', 503], [2, 'retry', 503], [1, 'retry', 503]]
  );
  assert.equal((await fetch(url + '/api/overview').then(response => response.json())).receiver.processed, 0);

  assert.ok((await post('/api/demo/receiver', { mode: 'healthy' })).ok);
  assert.ok((await post(`/api/deliveries/${id}/replay`, {})).ok);
  const delivered = await waitForStatus(url, id, 'delivered');
  assert.equal(delivered.delivery.id, id);
  assert.equal(delivered.delivery.event_id, eventId);
  assert.equal(delivered.delivery.generation, 2);
  assert.equal(delivered.attempts.length, 4);
  assert.equal(delivered.attempts[0].http_status, 200);
  assert.equal(delivered.attempts[0].number, 1);
  assert.equal((await post(`/api/deliveries/${id}/replay`, {})).status, 409);
  const overview = await fetch(url + '/api/overview').then(response => response.json());
  assert.deepEqual(overview.stats, { queued: 0, in_flight: 0, delivered: 1, dead: 0 });
  assert.equal(overview.receiver.processed, 1);
});

function sendWebhook(url, body, headers) {
  return fetch(url + '/demo/receiver', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(2000)
  });
}

test('HTTP receiver rejects tampered raw bytes, changed identity, and expired signatures', { timeout: 10_000 }, async t => {
  const { startApp } = await import('../server.mjs');
  const db = await fixture(t);
  const secret = Buffer.from('integration-signature-secret');
  const app = await startApp({ databasePath: db.databasePath, port: 0, workerCount: 0, secret });
  db.defer(() => app.close());
  const { delivery_id: id } = app.store.ingest(event, 1000);
  const raw = JSON.stringify(event.payload);
  const now = Date.now();
  const valid = sign(secret, id, raw, now);

  // Adding whitespace leaves the parsed object unchanged but alters the signed bytes.
  assert.equal((await sendWebhook(app.url, raw + '\n', valid)).status, 401);
  assert.equal((await sendWebhook(app.url, raw, {
    ...valid, 'webhook-id': '00000000-0000-0000-0000-000000000000'
  })).status, 401);
  assert.equal((await sendWebhook(app.url, raw, sign(secret, id, raw, now - 301_000))).status, 401);
  assert.equal(app.store.overview().receiver.processed, 0);
  const accepted = await sendWebhook(app.url, raw, valid);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { status: 200, duplicate: false });
  assert.equal(app.store.overview().receiver.processed, 1);
});

test('HTTP receiver commits once when a lost acknowledgement leads to redelivery after restart', { timeout: 10_000 }, async t => {
  const { startApp } = await import('../server.mjs');
  const db = await fixture(t);
  const secret = Buffer.from('integration-redelivery-secret');
  const options = {
    databasePath: db.databasePath, port: 0, workerCount: 0, leaseMs: 100, timeoutMs: 50, secret
  };
  const app = await startApp(options);
  const raw = JSON.stringify(event.payload);
  let firstClaim;
  try {
    const { delivery_id: id } = app.store.ingest(event, 1000);
    firstClaim = app.store.claim(1000);
    assert.equal(firstClaim.id, id);
    const firstResponse = await sendWebhook(app.url, raw, sign(secret, id, raw));
    assert.equal(firstResponse.status, 200);
    assert.deepEqual(await firstResponse.json(), { status: 200, duplicate: false });
    // Model a sender stopping after the receiver commits but before recording the acknowledgement.
    assert.equal(app.store.detail(id).delivery.status, 'in_flight');
    assert.equal(app.store.overview().receiver.processed, 1);
  } finally {
    await app.close();
  }

  const restarted = await startApp(options);
  db.defer(() => restarted.close());
  assert.equal(restarted.store.claim(1099), null);
  const recovered = restarted.store.claim(1100);
  assert.equal(recovered.id, firstClaim.id);
  assert.equal(recovered.event_id, firstClaim.event_id);
  assert.notEqual(recovered.token, firstClaim.token);
  const secondResponse = await sendWebhook(restarted.url, raw, sign(secret, recovered.id, raw));
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(await secondResponse.json(), { status: 200, duplicate: true });
  assert.equal(restarted.store.finish(recovered, { outcome: 'delivered', httpStatus: 200 }, 1101), true);
  const { processed, duplicates } = restarted.store.overview().receiver;
  assert.deepEqual({ processed, duplicates }, { processed: 1, duplicates: 1 });
  assert.deepEqual(restarted.store.detail(recovered.id).attempts.map(attempt => attempt.outcome), [
    'delivered', 'lease_expired'
  ]);
});
