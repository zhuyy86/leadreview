import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp } from './server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'runledger-'));
let app;
try {
  app = await startApp({ databasePath: join(directory, 'verify.sqlite'), port: 0, workerCount: 2 });
  const uniqueEvents = 100;
  const requests = Array.from({ length: uniqueEvents * 2 }, (_, index) => index % uniqueEvents);
  const accepted = new Map();
  let duplicates = 0;
  const started = performance.now();
  for (let offset = 0; offset < requests.length; offset += 20) {
    const batch = await Promise.all(requests.slice(offset, offset + 20).map(async run => {
      const response = await fetch(app.url + '/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'verify-' + run },
        body: JSON.stringify({ type: 'ai.run.completed', payload: { run, pipeline: 'verification' } })
      });
      assert.ok([200, 202].includes(response.status), 'Expected accepted or deduplicated submission');
      return { run, ...await response.json() };
    }));
    for (const { run, delivery_id, duplicate } of batch) {
      if (accepted.has(run)) assert.equal(delivery_id, accepted.get(run));
      accepted.set(run, delivery_id);
      if (duplicate) duplicates += 1;
    }
  }
  const deadline = performance.now() + 10_000;
  let overview;
  do {
    overview = await fetch(app.url + '/api/overview').then(response => response.json());
    if (overview.stats.delivered === uniqueEvents) break;
    await delay(50);
  } while (performance.now() < deadline);

  assert.equal(accepted.size, uniqueEvents);
  assert.equal(duplicates, uniqueEvents);
  assert.deepEqual(overview.stats, { queued: 0, in_flight: 0, delivered: uniqueEvents, dead: 0 });
  assert.equal(overview.receiver.processed, uniqueEvents);
  assert.equal(overview.receiver.duplicates, 0);
  console.log(JSON.stringify({
    node: process.version,
    platform: process.platform,
    requests: requests.length,
    concurrency: 20,
    workers: 2,
    deduplicatedSubmissions: duplicates,
    delivered: overview.stats.delivered,
    processedByReceiver: overview.receiver.processed,
    duplicateReceiverEffects: 0,
    elapsedMs: Math.round(performance.now() - started)
  }, null, 2));
} finally {
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
