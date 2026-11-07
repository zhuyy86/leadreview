import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, link, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { archiveDelivered, checkpointArchive, compactArchivedPayloads, createArtifactManifest, historyLookupSql,
  listArchiveCheckpoints,
  planRetention, snapshotLedger,
  locateHistory, verifyArtifactManifest } from '../maintenance.mjs';
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
    async noStaging() {
      assert.ok((await readdir(root)).every(name =>
        !name.startsWith('.runledger-snapshot-') && !name.startsWith('.runledger-archive-') &&
        !name.startsWith('.runledger-manifest-')));
    },
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

test('Retention preview protects active/dead work, idempotency and inbox without modifying the ledger', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const first = source.ingest(event, 1000);
  source.finish(source.claim(1000), { outcome: 'delivered', httpStatus: 200 }, 1010);
  source.receive(first.delivery_id, 1011);
  source.ingest({ ...event, key: 'dead' }, 1100);
  source.finish(source.claim(1100), { outcome: 'dead' }, 1110);
  source.ingest({ ...event, key: 'flight' }, 1200);
  source.claim(1200);
  source.ingest({ ...event, key: 'queued' }, 1300);
  const before = source.metrics(1400);
  const wal = await readFile(f.path('source.sqlite-wal'));
  const plan = await planRetention({ source: f.path('source.sqlite'), before: 1400 });
  assert.deepEqual(plan.candidates, { deliveries: 1, payload_bytes: Buffer.byteLength(JSON.stringify(event.payload)), attempts: 1 });
  assert.deepEqual(plan.retained, { idempotency_keys: 4, inbox_receipts: 1, deliveries_not_eligible: 3,
    non_delivered: { queued: 1, in_flight: 1, dead: 1 } });
  assert.equal(plan.deletion_enabled, false);
  assert.deepEqual(source.metrics(1400), before);
  assert.deepEqual(await readFile(f.path('source.sqlite-wal')), wal);
  assert.equal(source.ingest(event, 1500).duplicate, true);
  assert.equal(source.receive(first.delivery_id, 1501).duplicate, true);
});

test('Retention cutoff uses successful current-generation completion, with a strict boundary', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const first = source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'dead' }, 110);
  source.replay(first.delivery_id, 1000);
  source.finish(source.claim(1000), { outcome: 'delivered' }, 1010);
  assert.equal((await planRetention({ source: f.path('source.sqlite'), before: 500 })).candidates.deliveries, 0);
  assert.equal((await planRetention({ source: f.path('source.sqlite'), before: 1010 })).candidates.deliveries, 0);
  assert.deepEqual((await planRetention({ source: f.path('source.sqlite'), before: 1011 })).candidates,
    { deliveries: 1, payload_bytes: Buffer.byteLength(JSON.stringify(event.payload)), attempts: 2 });
});

test('Retention excludes unfinished or missing completion history despite a delivered status', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  const raw = new DatabaseSync(f.path('source.sqlite'));
  try {
    raw.exec('UPDATE attempts SET finished_at = NULL');
    assert.equal((await planRetention({ source: f.path('source.sqlite'), before: 1000 })).candidates.deliveries, 0);
    raw.exec('DELETE FROM attempts');
    assert.equal((await planRetention({ source: f.path('source.sqlite'), before: 1000 })).candidates.deliveries, 0);
  } finally { raw.close(); }
});

test('Retention empty populations are zero and payload size counts UTF-8 bytes', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  assert.deepEqual((await planRetention({ source: f.path('source.sqlite'), before: 1000 })).candidates,
    { deliveries: 0, payload_bytes: 0, attempts: 0 });
  const payload = { message: '完成 🚀' };
  source.ingest({ ...event, payload }, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  assert.equal((await planRetention({ source: f.path('source.sqlite'), before: 1000 })).candidates.payload_bytes,
    Buffer.byteLength(JSON.stringify(payload)));
});

test('Retention CLI returns a read-only plan and rejects ambiguous or invalid flags', async t => {
  const f = await fixture(t);
  f.open('source.sqlite').ingest(event, 100);
  const args = [cli, 'retention-plan', '--source', f.path('source.sqlite'), '--before', '1000'];
  const result = JSON.parse((await execute(process.execPath, args)).stdout);
  assert.equal(result.operation, 'retention-plan');
  assert.equal(result.mode, 'preview_only');
  assert.equal(result.retained.non_delivered.queued, 1);
  for (const value of ['NaN', '-1', '1.5', '8640000000000001', '']) {
    await assert.rejects(execute(process.execPath, [...args.slice(0, -1), value]), e => e.code === 2);
  }
  await assert.rejects(execute(process.execPath, [...args, '--output', f.path('unexpected.sqlite')]), e => e.code === 2);
  await assert.rejects(execute(process.execPath, [cli, 'backup', '--source', f.path('source.sqlite'),
    '--output', f.path('backup.sqlite'), '--before', '1000']), e => e.code === 2);
  await assert.rejects(planRetention({ source: f.path('source.sqlite'), before: 1.5 }), /cutoff/);
  await assert.rejects(stat(f.path('unexpected.sqlite')), { code: 'ENOENT' });
});

test('Delivered archive preserves eligible history, receipts and metric definitions from one snapshot', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const first = source.ingest(event, 100);
  const second = source.ingest({ ...event, key: 'later' }, 120);
  source.finish(source.claim(100), { outcome: 'dead', httpStatus: 503 }, 110);
  source.finish(source.claim(120), { outcome: 'dead', httpStatus: 503 }, 130);
  const action = source.replayMany({ operation_key: 'archive-batch', deliveries: [
    { id: first.delivery_id, generation: 1 }, { id: second.delivery_id, generation: 1 }
  ] }, 200);
  source.finish(source.claim(200), { outcome: 'delivered', httpStatus: 200 }, 210);
  source.finish(source.claim(220), { outcome: 'delivered', httpStatus: 200 }, 1200);
  source.receive(first.delivery_id, 211);
  const beforeMetrics = source.metrics(1300);

  const result = await archiveDelivered({ source: f.path('source.sqlite'),
    output: f.path('archive.sqlite'), before: 1000 });
  assert.deepEqual(result.counts, { events: 1, deliveries: 1, attempts: 2, inbox: 1, operator_actions: 1 });
  assert.equal(result.source_modified, false);
  assert.equal(result.sha256, createHash('sha256').update(await readFile(f.path('archive.sqlite'))).digest('hex'));
  const archive = new DatabaseSync(f.path('archive.sqlite'), { readOnly: true });
  try {
    assert.equal(archive.prepare('SELECT id FROM deliveries').get().id, first.delivery_id);
    assert.deepEqual(archive.prepare('SELECT generation, outcome FROM attempts ORDER BY generation').all().map(row => ({ ...row })), [
      { generation: 1, outcome: 'dead' }, { generation: 2, outcome: 'delivered' }
    ]);
    assert.equal(archive.prepare('SELECT delivery_id FROM inbox').get().delivery_id, first.delivery_id);
    const receipt = archive.prepare('SELECT id, result FROM operator_actions').get();
    assert.equal(receipt.id, action.action_id);
    assert.equal(JSON.parse(receipt.result).deliveries.length, 2, 'The immutable batch receipt stays complete');
    const contract = JSON.parse(archive.prepare("SELECT value FROM metadata WHERE key = 'metric_contract'").get().value);
    assert.match(contract.attempt, /every generation/);
    assert.match(contract.percentile, /nearest-rank/);
    assert.equal(Object.values(archive.prepare('PRAGMA quick_check(1)').get())[0], 'ok');
  } finally { archive.close(); }
  assert.deepEqual(source.metrics(1300), beforeMetrics);
  assert.equal(source.ingest(event, 1400).duplicate, true);
  await f.noStaging();
});

test('Archive uses strict completion cutoff and protects current-generation replay history', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const item = source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'dead' }, 110);
  source.replay(item.delivery_id, 900);
  source.finish(source.claim(900), { outcome: 'delivered' }, 1000);
  const empty = await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('empty.sqlite'), before: 1000 });
  assert.equal(empty.counts.deliveries, 0);
  const included = await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('included.sqlite'), before: 1001 });
  assert.deepEqual(included.counts, { events: 1, deliveries: 1, attempts: 2, inbox: 0, operator_actions: 0 });
});

test('Competing archive publishers produce one validated winner', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  const request = { source: f.path('source.sqlite'), output: f.path('shared.sqlite'), before: 1000 };
  const results = await Promise.allSettled([archiveDelivered(request), archiveDelivered(request)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const archive = new DatabaseSync(f.path('shared.sqlite'), { readOnly: true });
  try { assert.equal(archive.prepare('SELECT count(*) AS count FROM deliveries').get().count, 1); }
  finally { archive.close(); }
  await f.noStaging();
});

test('Archive rejects unsafe outputs and incompatible sources before publication', async t => {
  const f = await fixture(t);
  f.open('source.sqlite').ingest(event);
  await assert.rejects(archiveDelivered({ source: f.path('source.sqlite'),
    output: f.path('source.sqlite-wal'), before: 1000 }), /separate/);
  await writeFile(f.path('existing.sqlite'), 'preserve');
  await assert.rejects(archiveDelivered({ source: f.path('source.sqlite'),
    output: f.path('existing.sqlite'), before: 1000 }), /already exists/);
  assert.equal(await readFile(f.path('existing.sqlite'), 'utf8'), 'preserve');
  await writeFile(f.path('broken.sqlite'), 'broken');
  await assert.rejects(archiveDelivered({ source: f.path('broken.sqlite'),
    output: f.path('absent.sqlite'), before: 1000 }));
  await assert.rejects(stat(f.path('absent.sqlite')), { code: 'ENOENT' });
  await f.noStaging();
});

test('Archive reads a compatible ledger created before operator receipts existed', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  const legacy = new DatabaseSync(f.path('source.sqlite'));
  try { legacy.exec('DROP TABLE operator_actions'); } finally { legacy.close(); }
  const result = await archiveDelivered({ source: f.path('source.sqlite'),
    output: f.path('archive.sqlite'), before: 1000 });
  assert.equal(result.counts.deliveries, 1);
  assert.equal(result.counts.operator_actions, 0);
});

test('Archive CLI returns verifiable JSON and validates its cutoff contract', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  const args = [cli, 'archive', '--source', f.path('source.sqlite'), '--output', f.path('archive.sqlite'),
    '--before', '1000'];
  const result = JSON.parse((await execute(process.execPath, args)).stdout);
  assert.equal(result.operation, 'archive');
  assert.equal(result.counts.deliveries, 1);
  for (const value of ['-1', '1.5', 'NaN', '8640000000000001']) {
    await assert.rejects(execute(process.execPath, [...args.slice(0, -1), value]), error => error.code === 2);
  }
});

test('Signed manifest binds a backup checksum, size, type and row counts', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  source.ingest(event, 100);
  const backup = f.path('backup.sqlite');
  await snapshotLedger({ source: f.path('source.sqlite'), output: backup });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 7), { mode: 0o600 });
  const created = await createArtifactManifest({ artifact: backup, output: f.path('backup.manifest.json'),
    secretFile: f.path('secret.key') });
  assert.equal(created.artifact_kind, 'ledger_backup');
  assert.equal(created.artifact_sha256, createHash('sha256').update(await readFile(backup)).digest('hex'));
  const manifest = JSON.parse(await readFile(f.path('backup.manifest.json'), 'utf8'));
  assert.deepEqual(manifest.details.counts, { events: 1, deliveries: 1, attempts: 0, inbox: 0 });
  assert.equal(manifest.signature.algorithm, 'hmac-sha256');
  const verified = await verifyArtifactManifest({ artifact: backup, manifest: f.path('backup.manifest.json'),
    secretFile: f.path('secret.key') });
  assert.equal(verified.verified, true);
  assert.equal(verified.artifact_sha256, created.artifact_sha256);
  await f.noStaging();
});

test('Signed manifest captures archive cutoff, receipts and metric contract', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const accepted = source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  source.receive(accepted.delivery_id, 111);
  const archive = f.path('archive.sqlite');
  await archiveDelivered({ source: f.path('source.sqlite'), output: archive, before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(48, 3));
  await createArtifactManifest({ artifact: archive, output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  const manifest = JSON.parse(await readFile(f.path('archive.manifest.json'), 'utf8'));
  assert.equal(manifest.artifact_kind, 'delivered_archive');
  assert.equal(manifest.details.before_ms, 1000);
  assert.equal(manifest.details.counts.inbox, 1);
  assert.match(manifest.details.metric_contract.percentile, /nearest-rank/);
  assert.equal((await verifyArtifactManifest({ artifact: archive, manifest: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') })).verified, true);
});

test('Manifest verification rejects artifact tampering and renamed artifact substitution', async t => {
  const f = await fixture(t);
  f.open('source.sqlite').ingest(event);
  const backup = f.path('backup.sqlite');
  await snapshotLedger({ source: f.path('source.sqlite'), output: backup });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 4));
  await createArtifactManifest({ artifact: backup, output: f.path('manifest.json'), secretFile: f.path('secret.key') });
  await copyFile(backup, f.path('renamed.sqlite'));
  await assert.rejects(verifyArtifactManifest({ artifact: f.path('renamed.sqlite'), manifest: f.path('manifest.json'),
    secretFile: f.path('secret.key') }), /name does not match/);
  await writeFile(backup, 'tamper', { flag: 'a' });
  await assert.rejects(verifyArtifactManifest({ artifact: backup, manifest: f.path('manifest.json'),
    secretFile: f.path('secret.key') }), /checksum or byte count/);
});

test('Manifest verification rejects edited metadata and a different secret', async t => {
  const f = await fixture(t);
  f.open('source.sqlite').ingest(event);
  const backup = f.path('backup.sqlite');
  await snapshotLedger({ source: f.path('source.sqlite'), output: backup });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 5));
  await writeFile(f.path('other.key'), Buffer.alloc(32, 6));
  const manifestPath = f.path('manifest.json');
  await createArtifactManifest({ artifact: backup, output: manifestPath, secretFile: f.path('secret.key') });
  await assert.rejects(verifyArtifactManifest({ artifact: backup, manifest: manifestPath,
    secretFile: f.path('other.key') }), /signature verification failed/);
  const edited = JSON.parse(await readFile(manifestPath, 'utf8'));
  edited.details.counts.events = 99;
  await writeFile(manifestPath, JSON.stringify(edited));
  await assert.rejects(verifyArtifactManifest({ artifact: backup, manifest: manifestPath,
    secretFile: f.path('secret.key') }), /signature verification failed/);
});

test('Manifest publication has one winner and preserves existing output', async t => {
  const f = await fixture(t);
  f.open('source.sqlite').ingest(event);
  const backup = f.path('backup.sqlite');
  await snapshotLedger({ source: f.path('source.sqlite'), output: backup });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 8));
  const request = { artifact: backup, output: f.path('shared.json'), secretFile: f.path('secret.key') };
  const results = await Promise.allSettled([createArtifactManifest(request), createArtifactManifest(request)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await verifyArtifactManifest({ artifact: backup, manifest: f.path('shared.json'),
    secretFile: f.path('secret.key') })).verified, true);
  await writeFile(f.path('existing.json'), 'preserve');
  await assert.rejects(createArtifactManifest({ ...request, output: f.path('existing.json') }), /already exists/);
  assert.equal(await readFile(f.path('existing.json'), 'utf8'), 'preserve');
  await f.noStaging();
});

test('Manifest path and key validation reject aliases and weak key material', async t => {
  const f = await fixture(t);
  f.open('source.sqlite').ingest(event);
  const backup = f.path('backup.sqlite');
  await snapshotLedger({ source: f.path('source.sqlite'), output: backup });
  await writeFile(f.path('short.key'), 'short');
  await assert.rejects(createArtifactManifest({ artifact: backup, output: f.path('manifest.json'),
    secretFile: f.path('short.key') }), /32 to 4096/);
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 9));
  await assert.rejects(createArtifactManifest({ artifact: backup, output: backup,
    secretFile: f.path('secret.key') }), /distinct/);
  await assert.rejects(createArtifactManifest({ artifact: backup, output: f.path('secret.key'),
    secretFile: f.path('secret.key') }), /distinct/);
  await link(backup, f.path('artifact-key-alias'));
  await assert.rejects(createArtifactManifest({ artifact: backup, output: f.path('alias-manifest.json'),
    secretFile: f.path('artifact-key-alias') }), /32 to 4096|distinct files/);
  await createArtifactManifest({ artifact: backup, output: f.path('valid-manifest.json'),
    secretFile: f.path('secret.key') });
  await link(f.path('secret.key'), f.path('key-alias.json'));
  await assert.rejects(verifyArtifactManifest({ artifact: backup, manifest: f.path('key-alias.json'),
    secretFile: f.path('secret.key') }), /distinct files/);
});

test('Manifest CLI signs and verifies offline artifacts with strict argument shapes', async t => {
  const f = await fixture(t);
  f.open('source.sqlite').ingest(event);
  await snapshotLedger({ source: f.path('source.sqlite'), output: f.path('backup.sqlite') });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 10));
  const sign = [cli, 'sign-manifest', '--artifact', f.path('backup.sqlite'), '--output', f.path('manifest.json'),
    '--secret-file', f.path('secret.key')];
  assert.equal(JSON.parse((await execute(process.execPath, sign)).stdout).operation, 'sign-manifest');
  const verify = [cli, 'verify-manifest', '--artifact', f.path('backup.sqlite'), '--manifest', f.path('manifest.json'),
    '--secret-file', f.path('secret.key')];
  assert.equal(JSON.parse((await execute(process.execPath, verify)).stdout).verified, true);
  await assert.rejects(execute(process.execPath, [...verify, '--output', f.path('extra')]), error => error.code === 2);
  await assert.rejects(execute(process.execPath, [cli, 'sign-manifest', '--artifact', f.path('backup.sqlite')]),
    error => error.code === 2);
});

test('History lookup verifies an archive and deduplicates its active-ledger copy', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const accepted = source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered', httpStatus: 200 }, 110);
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 11));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });

  const result = await locateHistory({ source: f.path('source.sqlite'), query: accepted.delivery_id,
    secretFile: f.path('secret.key'), archives: [
      { artifact: f.path('archive.sqlite'), manifest: f.path('archive.manifest.json') }
    ] });
  assert.equal(result.archives_verified, 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].delivery_id, accepted.delivery_id);
  assert.deepEqual(result.matches[0].locations.map(location => location.kind),
    ['active_ledger', 'delivered_archive']);
  assert.match(result.matches[0].locations[1].artifact_sha256, /^[0-9a-f]{64}$/);
});

test('History lookup finds exact delivery, event and idempotency identities without prefix matches', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const accepted = source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 12));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  const options = { source: f.path('source.sqlite'), secretFile: f.path('secret.key'), archives: [
    { artifact: f.path('archive.sqlite'), manifest: f.path('archive.manifest.json') }
  ] };
  for (const query of [accepted.delivery_id, accepted.event_id, event.key]) {
    assert.equal((await locateHistory({ ...options, query })).matches[0].delivery_id, accepted.delivery_id);
  }
  assert.deepEqual((await locateHistory({ ...options, query: event.key.slice(0, -1) })).matches, []);
});

test('History lookup rejects unsigned substitutions and conflicting signed copies', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const accepted = source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 13));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  await copyFile(f.path('archive.sqlite'), f.path('conflict.sqlite'));
  const conflict = new DatabaseSync(f.path('conflict.sqlite'));
  try { conflict.prepare('UPDATE events SET type = ? WHERE id = ?').run('run.conflicted', accepted.event_id); }
  finally { conflict.close(); }
  await createArtifactManifest({ artifact: f.path('conflict.sqlite'), output: f.path('conflict.manifest.json'),
    secretFile: f.path('secret.key') });
  const base = { source: f.path('source.sqlite'), query: accepted.delivery_id, secretFile: f.path('secret.key') };
  await assert.rejects(locateHistory({ ...base, archives: [
    { artifact: f.path('conflict.sqlite'), manifest: f.path('archive.manifest.json') }
  ] }), /artifact name/);
  await assert.rejects(locateHistory({ ...base, archives: [
    { artifact: f.path('archive.sqlite'), manifest: f.path('archive.manifest.json') },
    { artifact: f.path('conflict.sqlite'), manifest: f.path('conflict.manifest.json') }
  ] }), /Conflicting history/);
});

test('History lookup validates archive pair count, limits and unique paths', async t => {
  const f = await fixture(t);
  f.open('source.sqlite').ingest(event);
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 14));
  const base = { source: f.path('source.sqlite'), query: event.key, secretFile: f.path('secret.key') };
  await assert.rejects(locateHistory({ ...base, archives: [] }), /1 to 20/);
  await assert.rejects(locateHistory({ ...base, query: 'x'.repeat(257), archives: [{}] }), /1 to 20/);
  const repeated = Array.from({ length: 21 }, (_, index) =>
    ({ artifact: f.path('archive-' + index), manifest: f.path('manifest-' + index) }));
  await assert.rejects(locateHistory({ ...base, archives: repeated }), /1 to 20/);
  await assert.rejects(locateHistory({ ...base, archives: [
    { artifact: f.path('same'), manifest: f.path('one') },
    { artifact: f.path('same'), manifest: f.path('two') }
  ] }), /paths must be unique/);
});

test('History lookup CLI returns verified locations and enforces paired arguments', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const accepted = source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 15));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  const args = [cli, 'locate-history', '--source', f.path('source.sqlite'), '--archive', f.path('archive.sqlite'),
    '--archive-manifest', f.path('archive.manifest.json'), '--secret-file', f.path('secret.key'),
    '--id', accepted.event_id];
  const result = JSON.parse((await execute(process.execPath, args)).stdout);
  assert.equal(result.operation, 'locate-history');
  assert.equal(result.matches[0].locations.length, 2);
  await assert.rejects(execute(process.execPath, args.filter((_, index) => ![6, 7].includes(index))),
    error => error.code === 2);
  await assert.rejects(execute(process.execPath, [...args, '--output', f.path('extra')]), error => error.code === 2);
});

test('Exact history lookup uses identity indexes and merges cross-field matches once', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const accepted = source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  const editor = new DatabaseSync(f.path('source.sqlite'));
  try { editor.prepare('UPDATE events SET idem_key = ? WHERE id = ?').run(accepted.delivery_id, accepted.event_id); }
  finally { editor.close(); }
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 28));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  for (const path of [f.path('source.sqlite'), f.path('archive.sqlite')]) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const details = db.prepare('EXPLAIN QUERY PLAN ' + historyLookupSql)
        .all(accepted.delivery_id, accepted.delivery_id, accepted.delivery_id).map(row => row.detail);
      assert.equal(details.some(detail => /^SCAN [de](?:\s|$)/.test(detail)), false);
      assert.ok(details.filter(detail => detail.startsWith('SEARCH d USING INDEX')).length >= 3);
      assert.ok(details.filter(detail => detail.startsWith('SEARCH e USING INDEX')).length >= 3);
    } finally { db.close(); }
  }
  const result = await locateHistory({ source: f.path('source.sqlite'), query: accepted.delivery_id,
    secretFile: f.path('secret.key'), archives: [
      { artifact: f.path('archive.sqlite'), manifest: f.path('archive.manifest.json') }
    ] });
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.matches[0].locations.map(location => location.kind),
    ['active_ledger', 'delivered_archive']);
});

test('Archive checkpoint records a fully matched signed preservation boundary idempotently', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const accepted = source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'dead', httpStatus: 503 }, 110);
  source.replayMany({ operation_key: 'checkpoint-replay',
    deliveries: [{ id: accepted.delivery_id, generation: 1 }] }, 120);
  source.finish(source.claim(120), { outcome: 'delivered', httpStatus: 200 }, 130);
  source.receive(accepted.delivery_id, 131);
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 16));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  const request = { source: f.path('source.sqlite'), archive: f.path('archive.sqlite'),
    manifest: f.path('archive.manifest.json'), secretFile: f.path('secret.key') };
  const first = await checkpointArchive({ ...request, now: 2000 });
  const second = await checkpointArchive({ ...request, now: 3000 });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.registered_at, 2000);
  assert.equal(first.manifest_sha256,
    createHash('sha256').update(await readFile(f.path('archive.manifest.json'))).digest('hex'));
  assert.deepEqual(first.counts, { events: 1, deliveries: 1, attempts: 2, inbox: 1, operator_actions: 1 });
  assert.deepEqual(listArchiveCheckpoints({ source: f.path('source.sqlite') }).checkpoints.map(row => ({
    artifact_sha256: row.artifact_sha256, registered_at: row.registered_at, counts: row.counts
  })), [{ artifact_sha256: first.artifact_sha256, registered_at: 2000, counts: first.counts }]);
  const db = new DatabaseSync(f.path('source.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM archive_checkpoints').get();
    assert.equal(row.artifact_sha256, first.artifact_sha256);
    assert.equal(row.manifest_sha256, first.manifest_sha256);
    assert.equal(row.before_ms, 1000);
    assert.deepEqual(JSON.parse(row.counts), first.counts);
  } finally { db.close(); }
});

test('Archive checkpoint rolls back when source history drifted after archive creation', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const accepted = source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 17));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  const request = { source: f.path('source.sqlite'), archive: f.path('archive.sqlite'),
    manifest: f.path('archive.manifest.json'), secretFile: f.path('secret.key') };
  await checkpointArchive({ ...request, now: 2000 });
  const db = new DatabaseSync(f.path('source.sqlite'));
  try { db.prepare('UPDATE deliveries SET attempt_count = 7 WHERE id = ?').run(accepted.delivery_id); }
  finally { db.close(); }
  await assert.rejects(checkpointArchive({ ...request, now: 3000 }), /deliveries/);
  const checked = new DatabaseSync(f.path('source.sqlite'), { readOnly: true });
  try { assert.equal(checked.prepare('SELECT count(*) AS count FROM archive_checkpoints').get().count, 1); }
  finally { checked.close(); }
});

test('Archive checkpoint rejects a validly signed archive whose rows differ from source', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered', httpStatus: 200 }, 110);
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  const archive = new DatabaseSync(f.path('archive.sqlite'));
  try { archive.exec('UPDATE attempts SET http_status = 201'); } finally { archive.close(); }
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 18));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  await assert.rejects(checkpointArchive({ source: f.path('source.sqlite'), archive: f.path('archive.sqlite'),
    manifest: f.path('archive.manifest.json'), secretFile: f.path('secret.key') }), /attempts/);
});

test('Archive checkpoint supports a legacy source with no operator receipt table', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  const legacy = new DatabaseSync(f.path('source.sqlite'));
  try { legacy.exec('DROP TABLE operator_actions'); } finally { legacy.close(); }
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 19));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  const result = await checkpointArchive({ source: f.path('source.sqlite'), archive: f.path('archive.sqlite'),
    manifest: f.path('archive.manifest.json'), secretFile: f.path('secret.key'), now: 2000 });
  assert.equal(result.counts.operator_actions, 0);
  assert.equal(result.duplicate, false);
});

test('Online backup preserves registered archive checkpoints', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 20));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  const checkpoint = await checkpointArchive({ source: f.path('source.sqlite'), archive: f.path('archive.sqlite'),
    manifest: f.path('archive.manifest.json'), secretFile: f.path('secret.key'), now: 2000 });
  await snapshotLedger({ source: f.path('source.sqlite'), output: f.path('backup.sqlite') });
  const backup = new DatabaseSync(f.path('backup.sqlite'), { readOnly: true });
  try {
    assert.equal(backup.prepare('SELECT artifact_sha256 FROM archive_checkpoints').get().artifact_sha256,
      checkpoint.artifact_sha256);
  } finally { backup.close(); }
});

test('Archive checkpoint CLI serializes concurrent registration and validates one pair', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  source.ingest(event, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 21));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  const args = [cli, 'checkpoint-archive', '--source', f.path('source.sqlite'), '--archive', f.path('archive.sqlite'),
    '--archive-manifest', f.path('archive.manifest.json'), '--secret-file', f.path('secret.key')];
  const results = await Promise.all([execute(process.execPath, args), execute(process.execPath, args)]);
  assert.deepEqual(results.map(result => JSON.parse(result.stdout).duplicate).sort(), [false, true]);
  const listed = JSON.parse((await execute(process.execPath,
    [cli, 'list-checkpoints', '--source', f.path('source.sqlite')])).stdout);
  assert.equal(listed.checkpoints.length, 1);
  assert.equal(listed.checkpoints[0].counts.deliveries, 1);
  await assert.rejects(execute(process.execPath, [...args, '--archive', f.path('extra')]),
    error => error.code === 2);
  await assert.rejects(execute(process.execPath, [...args, '--output', f.path('extra')]),
    error => error.code === 2);
});

test('Payload compaction preserves identities, receipts, replay history and exact metrics', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const largeEvent = { key: 'large-completed', type: 'run.completed', payload: { data: '长'.repeat(200) } };
  const large = source.ingest(largeEvent, 100);
  source.finish(source.claim(100), { outcome: 'dead', httpStatus: 503 }, 110);
  source.replayMany({ operation_key: 'compact-replay',
    deliveries: [{ id: large.delivery_id, generation: 1 }] }, 120);
  source.finish(source.claim(120), { outcome: 'delivered', httpStatus: 200 }, 130);
  source.receive(large.delivery_id, 131);
  const smallEvent = { key: 'small-completed', type: 'run.completed', payload: {} };
  const small = source.ingest(smallEvent, 140);
  source.finish(source.claim(140), { outcome: 'delivered', httpStatus: 200 }, 150);
  const metrics = source.metrics(5000);
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 22));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  const request = { source: f.path('source.sqlite'), archive: f.path('archive.sqlite'),
    manifest: f.path('archive.manifest.json'), secretFile: f.path('secret.key') };
  const checkpoint = await checkpointArchive({ ...request, now: 2000 });
  const compacted = await compactArchivedPayloads({ ...request, now: 3000 });
  assert.equal(compacted.duplicate, false);
  assert.equal(compacted.events_scanned, 2);
  assert.equal(compacted.events_compacted, 1);
  assert.ok(compacted.logical_payload_bytes_reclaimed > 500);
  assert.deepEqual(source.detail(large.delivery_id).delivery.payload, { _runledger_archived: true });
  assert.deepEqual(source.detail(small.delivery_id).delivery.payload, {});
  assert.deepEqual(source.metrics(5000), metrics);
  assert.deepEqual(source.ingest(largeEvent, 4000), { ...large, duplicate: true });
  assert.deepEqual(source.receive(large.delivery_id, 4001), { status: 200, duplicate: true });
  assert.equal(source.operatorActions().length, 1);
  const listed = listArchiveCheckpoints({ source: f.path('source.sqlite') }).checkpoints[0];
  assert.equal(listed.compaction.artifact_sha256, checkpoint.artifact_sha256);
  assert.equal(listed.compaction.logical_payload_bytes_reclaimed, compacted.logical_payload_bytes_reclaimed);
  const repeated = await checkpointArchive({ ...request, now: 5000 });
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.compacted, true);
});

test('Payload compaction requires the registered signed checkpoint boundary', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const original = { key: 'checkpoint-required', type: 'run.completed', payload: { data: 'x'.repeat(200) } };
  const accepted = source.ingest(original, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 23));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  await assert.rejects(compactArchivedPayloads({ source: f.path('source.sqlite'), archive: f.path('archive.sqlite'),
    manifest: f.path('archive.manifest.json'), secretFile: f.path('secret.key') }), /Register.*checkpoint/);
  assert.deepEqual(source.detail(accepted.delivery_id).delivery.payload, original.payload);
  assert.equal(listArchiveCheckpoints({ source: f.path('source.sqlite') }).checkpoints.length, 0);
});

test('Payload compaction rejects source drift after checkpoint and records no receipt', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const original = { key: 'drifted-source', type: 'run.completed', payload: { data: 'x'.repeat(200) } };
  const accepted = source.ingest(original, 100);
  source.finish(source.claim(100), { outcome: 'delivered', httpStatus: 200 }, 110);
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 24));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  const request = { source: f.path('source.sqlite'), archive: f.path('archive.sqlite'),
    manifest: f.path('archive.manifest.json'), secretFile: f.path('secret.key') };
  await checkpointArchive({ ...request, now: 2000 });
  const db = new DatabaseSync(f.path('source.sqlite'));
  try { db.prepare('UPDATE deliveries SET attempt_count = 7 WHERE id = ?').run(accepted.delivery_id); }
  finally { db.close(); }
  await assert.rejects(compactArchivedPayloads({ ...request, now: 3000 }), /deliveries/);
  assert.deepEqual(source.detail(accepted.delivery_id).delivery.payload, original.payload);
  assert.equal(listArchiveCheckpoints({ source: f.path('source.sqlite') }).checkpoints[0].compaction, null);
});

test('Payload compaction rolls back every payload and mapping after a mid-update failure', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const inputs = [1, 2].map(index => ({ key: 'rollback-' + index, type: 'run.completed',
    payload: { data: String(index).repeat(200) } }));
  const accepted = inputs.map((input, index) => source.ingest(input, 100 + index * 20));
  for (let index = 0; index < accepted.length; index++) {
    source.finish(source.claim(100 + index * 20), { outcome: 'delivered' }, 110 + index * 20);
  }
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 25));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  const request = { source: f.path('source.sqlite'), archive: f.path('archive.sqlite'),
    manifest: f.path('archive.manifest.json'), secretFile: f.path('secret.key') };
  await checkpointArchive({ ...request, now: 2000 });
  const db = new DatabaseSync(f.path('source.sqlite'));
  try {
    db.exec(`CREATE TRIGGER fail_second_compaction BEFORE UPDATE OF payload ON events
      WHEN NEW.id = '${accepted[1].event_id}' BEGIN SELECT RAISE(ABORT, 'forced compaction failure'); END`);
  } finally { db.close(); }
  await assert.rejects(compactArchivedPayloads({ ...request, now: 3000 }), /forced compaction failure/);
  for (let index = 0; index < accepted.length; index++) {
    assert.deepEqual(source.detail(accepted[index].delivery_id).delivery.payload, inputs[index].payload);
  }
  const checked = new DatabaseSync(f.path('source.sqlite'), { readOnly: true });
  try {
    assert.equal(checked.prepare('SELECT count(*) AS count FROM archive_compactions').get().count, 0);
    assert.equal(checked.prepare('SELECT count(*) AS count FROM archive_compacted_events').get().count, 0);
  } finally { checked.close(); }
});

test('Payload compaction CLI serializes concurrent requests and returns one durable receipt', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  source.ingest({ key: 'concurrent-compact', type: 'run.completed', payload: { data: 'x'.repeat(200) } }, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 26));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  const request = { source: f.path('source.sqlite'), archive: f.path('archive.sqlite'),
    manifest: f.path('archive.manifest.json'), secretFile: f.path('secret.key') };
  await checkpointArchive({ ...request, now: 2000 });
  const args = [cli, 'compact-payloads', '--source', request.source, '--archive', request.archive,
    '--archive-manifest', request.manifest, '--secret-file', request.secretFile];
  const results = await Promise.all([execute(process.execPath, args), execute(process.execPath, args)]);
  assert.deepEqual(results.map(result => JSON.parse(result.stdout).duplicate).sort(), [false, true]);
  const listed = JSON.parse((await execute(process.execPath,
    [cli, 'list-checkpoints', '--source', request.source])).stdout);
  assert.equal(listed.checkpoints[0].compaction.events_compacted, 1);
  await assert.rejects(execute(process.execPath, [...args, '--archive', f.path('extra')]),
    error => error.code === 2);
});

test('Backups retain compaction receipts and later archives select only fresh payloads', async t => {
  const f = await fixture(t);
  const source = f.open('source.sqlite');
  const firstEvent = { key: 'already-compacted', type: 'run.completed', payload: { data: 'x'.repeat(200) } };
  const first = source.ingest(firstEvent, 100);
  source.finish(source.claim(100), { outcome: 'delivered' }, 110);
  await archiveDelivered({ source: f.path('source.sqlite'), output: f.path('archive.sqlite'), before: 1000 });
  await writeFile(f.path('secret.key'), Buffer.alloc(32, 27));
  await createArtifactManifest({ artifact: f.path('archive.sqlite'), output: f.path('archive.manifest.json'),
    secretFile: f.path('secret.key') });
  const request = { source: f.path('source.sqlite'), archive: f.path('archive.sqlite'),
    manifest: f.path('archive.manifest.json'), secretFile: f.path('secret.key') };
  const checkpoint = await checkpointArchive({ ...request, now: 2000 });
  await compactArchivedPayloads({ ...request, now: 3000 });
  const second = source.ingest({ key: 'fresh-archive', type: 'run.completed', payload: { data: 'fresh' } }, 400);
  source.finish(source.claim(400), { outcome: 'delivered' }, 410);
  assert.deepEqual((await planRetention({ source: request.source, before: 1000 })).candidates,
    { deliveries: 1, payload_bytes: Buffer.byteLength(JSON.stringify({ data: 'fresh' })), attempts: 1 });
  const next = await archiveDelivered({ source: request.source, output: f.path('next.sqlite'), before: 1000 });
  assert.equal(next.counts.deliveries, 1);
  const nextDb = new DatabaseSync(f.path('next.sqlite'), { readOnly: true });
  try {
    assert.equal(nextDb.prepare('SELECT id FROM deliveries').get().id, second.delivery_id);
    assert.equal(nextDb.prepare('SELECT count(*) AS count FROM events WHERE id = ?').get(first.event_id).count, 0);
  } finally { nextDb.close(); }
  await snapshotLedger({ source: request.source, output: f.path('backup.sqlite') });
  const backup = new DatabaseSync(f.path('backup.sqlite'), { readOnly: true });
  try {
    assert.equal(backup.prepare('SELECT artifact_sha256 FROM archive_compactions').get().artifact_sha256,
      checkpoint.artifact_sha256);
    assert.equal(backup.prepare('SELECT count(*) AS count FROM archive_compacted_events').get().count, 1);
  } finally { backup.close(); }
});
