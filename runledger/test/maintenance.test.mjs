import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { snapshotLedger } from '../maintenance.mjs';
import { openStore } from '../store.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../maintenance.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'runledger-maintenance-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores.reverse()) store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    path: name => join(root, name),
    async noStaging() { assert.ok((await readdir(root)).every(name => !name.startsWith('.runledger-snapshot-'))); },
    open(name, options) {
      const store = openStore(join(root, name), options);
      stores.push(store);
      return store;
    }
  };
}

const event = { key: 'recoverable', type: 'run.completed', payload: { artifact: 'ready' } };

test('Online backup includes uncheckpointed WAL, replay history, idempotency and inbox receipts', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const original = source.ingest(event, 1000);
  source.finish(source.claim(1000), { outcome: 'dead', httpStatus: 503 }, 1010);
  source.replay(original.delivery_id, 1100);
  source.finish(source.claim(1100), { outcome: 'delivered', httpStatus: 200 }, 1110);
  source.receive(original.delivery_id, 1111);
  assert.ok((await stat(f.path('source.sqlite-wal'))).size > 0);

  const snapshot = await snapshotLedger({ source: f.path('source.sqlite'), output: f.path('backup.sqlite') });
  assert.deepEqual(snapshot.counts, { events: 1, deliveries: 1, attempts: 2, inbox: 1 });
  assert.equal(snapshot.sha256, createHash('sha256').update(await readFile(f.path('backup.sqlite'))).digest('hex'));
  await assert.rejects(stat(f.path('backup.sqlite-wal')), { code: 'ENOENT' });
  await snapshotLedger({ source: f.path('backup.sqlite'), output: f.path('restored.sqlite') });
  const restored = f.open('restored.sqlite');
  assert.deepEqual(restored.ingest(event, 1200), { ...original, duplicate: true });
  assert.deepEqual(restored.detail(original.delivery_id), source.detail(original.delivery_id));
  assert.deepEqual(restored.receive(original.delivery_id, 1201), { status: 200, duplicate: true });
  assert.equal(restored.overview().receiver.processed, 1);
  assert.deepEqual(restored.metrics(1202).latency, source.metrics(1202).latency);
  await f.noStaging();
});

test('Restored in-flight work waits for lease expiry and fences the pre-backup worker', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite', { leaseMs: 100 });
  const { delivery_id: id } = source.ingest(event, 1000);
  const stale = source.claim(1000);
  await snapshotLedger({ source: f.path('source.sqlite'), output: f.path('restored.sqlite') });
  const restored = f.open('restored.sqlite', { leaseMs: 100 });
  assert.equal(restored.claim(1099), null);
  const recovered = restored.claim(1100);
  assert.equal(recovered.id, id);
  assert.equal(recovered.number, 2);
  assert.notEqual(recovered.token, stale.token);
  assert.equal(restored.finish(stale, { outcome: 'delivered', httpStatus: 200 }, 1101), false);
  assert.equal(restored.finish(recovered, { outcome: 'delivered', httpStatus: 200 }, 1102), true);
  assert.deepEqual(restored.detail(id).attempts.map(row => row.outcome), ['delivered', 'lease_expired']);
});

test('A concurrent WAL writer succeeds while the backup retains its pinned read snapshot', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  for (let index = 0; index < 250; index++) {
    source.ingest({ key: 'bulk-' + index, type: 'run.completed', payload: { data: 'x'.repeat(4096) } });
  }
  let wrote = false;
  const result = await snapshotLedger({ source: f.path('source.sqlite'), output: f.path('backup.sqlite'),
    onProgress() {
      if (!wrote) {
        source.ingest({ ...event, key: 'after-snapshot' });
        wrote = true;
      }
    }
  });
  assert.equal(wrote, true, 'The fixture must span multiple backup steps');
  assert.equal(source.overview().stats.queued, 251);
  assert.equal(result.counts.events, 250);
  assert.equal(f.open('backup.sqlite').overview().stats.queued, 250);
});

test('Competing snapshot publishers produce one complete target and never overwrite the winner', async t => {
  const f = await fixture(t);
  f.open('source.sqlite').ingest(event);
  const options = { source: f.path('source.sqlite'), output: f.path('shared.sqlite') };
  const results = await Promise.allSettled([snapshotLedger(options), snapshotLedger(options)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const winner = results.find(result => result.status === 'fulfilled').value;
  assert.equal(winner.sha256, createHash('sha256').update(await readFile(options.output)).digest('hex'));
  assert.equal(f.open('shared.sqlite').overview().stats.queued, 1);
  await f.noStaging();
});

test('Existing outputs, orphan sidecars and source-sidecar aliases remain untouched', async t => {
  const f = await fixture(t);
  f.open('source.sqlite').ingest(event);
  const output = f.path('existing.sqlite');
  await writeFile(output, 'keep this file');
  await assert.rejects(snapshotLedger({ source: f.path('source.sqlite'), output }), /already exists/);
  assert.equal(await readFile(output, 'utf8'), 'keep this file');
  await writeFile(f.path('fresh.sqlite-wal'), 'orphan WAL');
  await assert.rejects(snapshotLedger({ source: f.path('source.sqlite'), output: f.path('fresh.sqlite') }), /sidecar already exists/);
  assert.equal(await readFile(f.path('fresh.sqlite-wal'), 'utf8'), 'orphan WAL');
  await assert.rejects(snapshotLedger({ source: f.path('source.sqlite'), output: f.path('source.sqlite-wal') }), /sidecar path/);
  await assert.rejects(snapshotLedger({ source: f.path('source.sqlite'), output: f.path('source.sqlite') }), /already exists/);
});

test('Missing, malformed and unrelated databases fail without publishing or staging leftovers', async t => {
  const f = await fixture(t);
  await writeFile(f.path('broken.sqlite'), 'not a SQLite database');
  const unrelated = new DatabaseSync(f.path('unrelated.sqlite'));
  unrelated.exec('CREATE TABLE unrelated (id INTEGER)');
  unrelated.close();
  for (const name of ['missing.sqlite', 'broken.sqlite', 'unrelated.sqlite']) {
    const output = f.path(name + '.output');
    await assert.rejects(snapshotLedger({ source: f.path(name), output }));
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
  await f.noStaging();
});

test('Foreign-key corruption is rejected before a snapshot is published', async t => {
  const f = await fixture(t);
  f.open('source.sqlite').ingest(event);
  const corruptor = new DatabaseSync(f.path('source.sqlite'), { enableForeignKeyConstraints: false });
  corruptor.exec('DELETE FROM events');
  corruptor.close();
  await assert.rejects(snapshotLedger({ source: f.path('source.sqlite'), output: f.path('backup.sqlite') }), /foreign-key check failed/);
  await assert.rejects(stat(f.path('backup.sqlite')), { code: 'ENOENT' });
  await f.noStaging();
});

test('CLI backup and restore return verifiable JSON while invalid arguments return exit code 2', async t => {
  const f = await fixture(t);
  f.open('source.sqlite').ingest(event);
  const first = await execute(process.execPath, [cli, 'backup', '--source', f.path('source.sqlite'), '--output', f.path('backup.sqlite')]);
  assert.equal(JSON.parse(first.stdout).operation, 'backup');
  const second = await execute(process.execPath, [cli, 'restore', '--source', f.path('backup.sqlite'), '--output', f.path('recovered.sqlite')]);
  assert.equal(JSON.parse(second.stdout).counts.events, 1);
  assert.equal(f.open('recovered.sqlite').overview().stats.queued, 1);
  await assert.rejects(execute(process.execPath, [cli, 'restore']), error => error.code === 2 && error.stderr.includes('Usage:'));
});
