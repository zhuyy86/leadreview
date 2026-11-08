import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { archiveDelivered, createArtifactManifest } from '../maintenance.mjs';
import { historyOptionsFromEnv, startApp } from '../server.mjs';
import { openStore } from '../store.mjs';

async function historyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'runledger-history-service-'));
  const source = join(root, 'source.sqlite');
  const archive = join(root, 'archive.sqlite');
  const manifest = join(root, 'archive.manifest.json');
  const secretFile = join(root, 'archive.key');
  const store = openStore(source);
  const identity = store.ingest({ key: 'retained-identity', type: 'ai.run.completed', payload: { ready: true } }, 100);
  const job = store.claim(100);
  store.finish(job, { outcome: 'delivered', httpStatus: 204 }, 110);
  store.close();
  await writeFile(secretFile, 'history-service-secret-material-32-bytes');
  await archiveDelivered({ source, output: archive, before: 200 });
  await createArtifactManifest({ artifact: archive, output: manifest, secretFile });
  return { root, source, archive, manifest, secretFile, identity };
}

test('History API reuses authenticated archives and publishes cache health', async t => {
  const f = await historyFixture();
  const app = await startApp({ databasePath: f.source, port: 0, workerCount: 0,
    historyArchives: [{ artifact: f.archive, manifest: f.manifest }],
    historySecretFile: f.secretFile, historyCacheMaxEntries: 1, historyCacheTtlMs: 60_000 });
  t.after(async () => { await app.close(); await rm(f.root, { recursive: true, force: true }); });

  for (let index = 0; index < 2; index++) {
    const response = await fetch(app.url + '/api/history?id=' + f.identity.delivery_id);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].delivery_id, f.identity.delivery_id);
    assert.deepEqual(result.matches[0].locations.map(location => location.kind),
      ['active_ledger', 'delivered_archive']);
    assert.deepEqual(result.verification_cache, index === 0
      ? { hits: 0, misses: 1, coalesced: 0, bypassed: 0 }
      : { hits: 1, misses: 0, coalesced: 0, bypassed: 0 });
  }

  const metrics = await fetch(app.url + '/api/metrics').then(response => response.json());
  assert.deepEqual(metrics.history_lookup.totals, {
    requests: 2, successes: 2, failures: 0, matches: 2,
    hits: 1, misses: 1, coalesced: 0, bypassed: 0
  });
  assert.equal(metrics.history_lookup.archives_configured, 1);
  assert.equal(metrics.history_lookup.cache.entries, 1);
  assert.equal(metrics.history_lookup.cache.hits, 1);
  assert.equal(metrics.history_lookup.cache.misses, 1);
  assert.ok(Number.isSafeInteger(metrics.history_lookup.last_succeeded_at));
});

test('History API validates exact queries and records failed reauthentication', async t => {
  const f = await historyFixture();
  const app = await startApp({ databasePath: f.source, port: 0, workerCount: 0,
    historyArchives: [{ artifact: f.archive, manifest: f.manifest }], historySecretFile: f.secretFile,
    logger: { error() {} } });
  t.after(async () => { await app.close(); await rm(f.root, { recursive: true, force: true }); });

  assert.equal((await fetch(app.url + '/api/history')).status, 400);
  assert.equal((await fetch(app.url + '/api/history?id=a&id=b')).status, 400);
  assert.equal((await fetch(app.url + '/api/history?id=' + f.identity.event_id)).status, 200);
  const edited = JSON.parse(await readFile(f.manifest, 'utf8'));
  edited.created_at = '2026-11-08T00:00:00.000Z';
  await writeFile(f.manifest, JSON.stringify(edited));
  assert.equal((await fetch(app.url + '/api/history?id=' + f.identity.event_id)).status, 500);

  const metrics = await fetch(app.url + '/api/metrics').then(response => response.json());
  assert.equal(metrics.history_lookup.totals.requests, 2);
  assert.equal(metrics.history_lookup.totals.successes, 1);
  assert.equal(metrics.history_lookup.totals.failures, 1);
  assert.equal(metrics.history_lookup.cache.invalidations, 1);
  assert.ok(Number.isSafeInteger(metrics.history_lookup.last_failed_at));
  assert.match(metrics.history_lookup.last_error, /manifest/i);
});

test('History API advertises its disabled state and environment options are strict', async t => {
  const app = await startApp({ databasePath: ':memory:', port: 0, workerCount: 0 });
  t.after(() => app.close());
  const response = await fetch(app.url + '/api/history?id=missing');
  assert.equal(response.status, 503);
  const metrics = await fetch(app.url + '/api/metrics').then(result => result.json());
  assert.equal(metrics.history_lookup.enabled, false);
  assert.equal(metrics.history_lookup.archives_configured, 0);
  assert.deepEqual(historyOptionsFromEnv({}), {});
  assert.deepEqual(historyOptionsFromEnv({
    RUNLEDGER_ARCHIVES_JSON: '[{"artifact":"a.sqlite","manifest":"a.json"}]',
    RUNLEDGER_ARCHIVE_SECRET: 'key', RUNLEDGER_HISTORY_CACHE_ENTRIES: '7',
    RUNLEDGER_HISTORY_CACHE_TTL_MS: '9000'
  }), {
    historyArchives: [{ artifact: 'a.sqlite', manifest: 'a.json' }],
    historySecretFile: 'key', historyCacheMaxEntries: 7, historyCacheTtlMs: 9000
  });
  assert.throws(() => historyOptionsFromEnv({ RUNLEDGER_ARCHIVES_JSON: '[]' }), /together/);
  assert.throws(() => historyOptionsFromEnv({
    RUNLEDGER_ARCHIVES_JSON: 'not-json', RUNLEDGER_ARCHIVE_SECRET: 'key'
  }), /valid JSON/);
});
