import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { archiveDelivered } from './maintenance.mjs';
import { openStore } from './store.mjs';

const { values } = parseArgs({ options: { deliveries: { type: 'string', default: '500' } } });
if (!/^\d{1,5}$/.test(values.deliveries)) throw new Error('--deliveries must be an integer from 2 to 10000.');
const deliveries = Number(values.deliveries);
if (deliveries < 2 || deliveries > 10_000) throw new Error('--deliveries must be an integer from 2 to 10000.');

const directory = await mkdtemp(join(tmpdir(), 'runledger-archive-workload-'));
const sourcePath = join(directory, 'source.sqlite');
const archivePath = join(directory, 'delivered.sqlite');
const store = openStore(sourcePath);
const baseTime = 1_800_000_000_000;
const eligible = Math.floor(deliveries / 2);
const cutoff = baseTime + eligible * 10;
let replayed = 0;
let expectedAttempts = 0;
let expectedInbox = 0;
let expectedActions = 0;
let firstEvent;
try {
  const seededAt = performance.now();
  for (let index = 0; index < deliveries; index++) {
    const time = baseTime + index * 10;
    const event = { key: 'archive-' + index, type: 'ai.run.completed',
      payload: { run: index, artifact: 'x'.repeat(64) } };
    const accepted = store.ingest(event, time);
    if (index === 0) firstEvent = { event, accepted };
    const first = store.claim(time);
    let completedAt;
    if (index % 10 === 0) {
      store.finish(first, { outcome: 'dead', httpStatus: 503 }, time + 1);
      store.replayMany({ operation_key: 'archive-replay-' + index,
        deliveries: [{ id: accepted.delivery_id, generation: 1 }] }, time + 2);
      store.finish(store.claim(time + 2), { outcome: 'delivered', httpStatus: 200 }, time + 3);
      completedAt = time + 3;
      replayed++;
    } else {
      store.finish(first, { outcome: 'delivered', httpStatus: 200 }, time + 1);
      completedAt = time + 1;
    }
    if (index % 4 === 0) store.receive(accepted.delivery_id, completedAt + 1);
    if (index < eligible) {
      expectedAttempts += index % 10 === 0 ? 2 : 1;
      expectedInbox += index % 4 === 0 ? 1 : 0;
      expectedActions += index % 10 === 0 ? 1 : 0;
    }
  }
  const seedMs = performance.now() - seededAt;
  const metricsBefore = store.metrics(baseTime + deliveries * 10 + 100);
  const archivedAt = performance.now();
  const result = await archiveDelivered({ source: sourcePath, output: archivePath, before: cutoff });
  const archiveMs = performance.now() - archivedAt;
  assert.deepEqual(result.counts, { events: eligible, deliveries: eligible, attempts: expectedAttempts,
    inbox: expectedInbox, operator_actions: expectedActions });
  assert.equal(result.sha256, createHash('sha256').update(await readFile(archivePath)).digest('hex'));
  assert.deepEqual(store.metrics(baseTime + deliveries * 10 + 100), metricsBefore);
  assert.deepEqual(store.ingest(firstEvent.event, baseTime + deliveries * 10 + 200),
    { ...firstEvent.accepted, duplicate: true });

  const archive = new DatabaseSync(archivePath, { readOnly: true });
  let contract;
  try {
    assert.equal(archive.prepare('SELECT count(*) AS count FROM deliveries').get().count, eligible);
    assert.equal(archive.prepare('SELECT count(*) AS count FROM attempts').get().count, expectedAttempts);
    assert.equal(Object.values(archive.prepare('PRAGMA quick_check(1)').get())[0], 'ok');
    assert.equal(archive.prepare('PRAGMA foreign_key_check').get(), undefined);
    contract = JSON.parse(archive.prepare("SELECT value FROM metadata WHERE key = 'metric_contract'").get().value);
  } finally { archive.close(); }
  assert.match(contract.percentile, /nearest-rank/);

  console.log(JSON.stringify({ observed_at: new Date().toISOString(), node: process.version,
    platform: process.platform, source_deliveries: deliveries, eligible_deliveries: eligible,
    replayed_deliveries: replayed, archived_attempts: expectedAttempts, archived_inbox: expectedInbox,
    archived_operator_actions: expectedActions, archive_bytes: result.bytes, archive_sha256: result.sha256,
    seed_ms: Math.round(seedMs * 100) / 100, archive_and_verify_ms: Math.round(archiveMs * 100) / 100,
    scope: 'Local temporary SQLite databases; correctness, preservation and artifact verification. Timings describe this run.'
  }, null, 2));
} finally {
  store.close();
  await rm(directory, { recursive: true, force: true });
}
