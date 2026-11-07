import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { archiveDelivered, createArchiveVerificationCache, createArtifactManifest,
  historyLookupSql, locateHistory } from './maintenance.mjs';
import { openStore } from './store.mjs';

const { values } = parseArgs({ options: {
  deliveries: { type: 'string', default: '20000' },
  probes: { type: 'string', default: '1000' },
  archives: { type: 'string', default: '4' },
  output: { type: 'string' }
} });
if (!/^\d{1,6}$/.test(values.deliveries) || !/^\d{1,6}$/.test(values.probes) || !/^\d{1,2}$/.test(values.archives)) {
  throw new Error('--deliveries, --probes and --archives must be positive integers.');
}
const deliveries = Number(values.deliveries);
const probes = Number(values.probes);
const archiveCopies = Number(values.archives);
if (deliveries < 10 || deliveries > 100_000 || probes < 10 || probes > 100_000 ||
    archiveCopies < 1 || archiveCopies > 20) {
  throw new Error('--deliveries and --probes must be 10 to 100000; --archives must be 1 to 20.');
}

const directory = await mkdtemp(join(tmpdir(), 'runledger-lookup-workload-'));
const sourcePath = join(directory, 'source.sqlite');
const archivePath = join(directory, 'delivered.sqlite');
const manifestPath = join(directory, 'delivered.manifest.json');
const secretPath = join(directory, 'archive.key');
const baseTime = 1_800_000_000_000;
const eligible = Math.floor(deliveries / 2);
const cutoff = baseTime + eligible * 10;
const legacyHistoryLookupSql = `
  SELECT d.id AS delivery_id, e.id AS event_id, e.idem_key, e.digest, e.type,
    e.created_at AS event_created_at, d.status, d.generation, d.attempt_count,
    d.max_attempts, d.created_at AS delivery_created_at
  FROM events e JOIN deliveries d ON d.event_id = e.id
  WHERE d.id = ? OR e.id = ? OR e.idem_key = ?
  ORDER BY d.created_at, d.id
`;

function identity(prefix, index) {
  return prefix + '-' + String(index).padStart(8, '0');
}

function planFor(db, query) {
  const steps = db.prepare('EXPLAIN QUERY PLAN ' + historyLookupSql).all(query, query, query)
    .map(row => row.detail);
  assert.equal(steps.some(detail => /^SCAN [de](?:\s|$)/.test(detail)), false);
  assert.ok(steps.filter(detail => detail.startsWith('SEARCH d USING INDEX')).length >= 3);
  assert.ok(steps.filter(detail => detail.startsWith('SEARCH e USING INDEX')).length >= 3);
  return steps;
}

function percentile(sorted, percent) {
  return sorted[Math.ceil(sorted.length * percent / 100) - 1];
}

function measureKernel(db, sql, queries, count) {
  const statement = db.prepare(sql);
  const samples = [];
  for (let index = 0; index < count; index++) {
    const query = queries[index % queries.length];
    const started = performance.now();
    statement.all(query, query, query);
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    probes: samples.length,
    min_ms: Math.round(samples[0] * 1000) / 1000,
    p50_ms: Math.round(percentile(samples, 50) * 1000) / 1000,
    p95_ms: Math.round(percentile(samples, 95) * 1000) / 1000,
    max_ms: Math.round(samples.at(-1) * 1000) / 1000
  };
}

async function measureVerified(request) {
  const started = performance.now();
  const result = await locateHistory(request);
  return { elapsed_ms: Math.round((performance.now() - started) * 100) / 100, result };
}

try {
  openStore(sourcePath).close();
  const source = new DatabaseSync(sourcePath);
  try {
    source.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    const addEvent = source.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)');
    const addDelivery = source.prepare('INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const addAttempt = source.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let index = 0; index < deliveries; index++) {
      const eventId = identity('event', index);
      const deliveryId = identity('delivery', index);
      const time = baseTime + index * 10;
      addEvent.run(eventId, identity('key', index), index.toString(16).padStart(64, '0'),
        'ai.run.completed', JSON.stringify({ run: index, artifact: 'x'.repeat(32) }), time);
      addDelivery.run(deliveryId, eventId, 'delivered', 1, 1, 4, null, time, null, null, null);
      addAttempt.run(identity('attempt', index), deliveryId, 1, 1, time, time + 1,
        'delivered', 200, null);
    }
    source.exec('COMMIT');
  } catch (error) {
    source.exec('ROLLBACK');
    throw error;
  } finally { source.close(); }

  const archived = await archiveDelivered({ source: sourcePath, output: archivePath, before: cutoff });
  assert.equal(archived.counts.deliveries, eligible);
  await writeFile(secretPath, Buffer.alloc(32, 29));
  await createArtifactManifest({ artifact: archivePath, output: manifestPath, secretFile: secretPath });
  const archivePairs = [{ artifact: archivePath, manifest: manifestPath }];
  for (let index = 1; index < archiveCopies; index++) {
    const artifact = join(directory, `delivered-${index}.sqlite`);
    const manifest = join(directory, `delivered-${index}.manifest.json`);
    await copyFile(archivePath, artifact);
    await createArtifactManifest({ artifact, output: manifest, secretFile: secretPath });
    archivePairs.push({ artifact, manifest });
  }

  const archivedQuery = identity('delivery', Math.floor(eligible / 2));
  const activeQuery = identity('event', deliveries - 1);
  const idemQuery = identity('key', deliveries - 2);
  const missingQuery = 'missing-identity';
  const sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
  const archiveDb = new DatabaseSync(archivePath, { readOnly: true });
  let sourcePlan;
  let archivePlan;
  let sourceKernel;
  let archiveKernel;
  let sourceLegacyPlan;
  let archiveLegacyPlan;
  let sourceLegacyKernel;
  let archiveLegacyKernel;
  try {
    sourcePlan = planFor(sourceDb, archivedQuery);
    archivePlan = planFor(archiveDb, archivedQuery);
    sourceLegacyPlan = sourceDb.prepare('EXPLAIN QUERY PLAN ' + legacyHistoryLookupSql)
      .all(archivedQuery, archivedQuery, archivedQuery).map(row => row.detail);
    archiveLegacyPlan = archiveDb.prepare('EXPLAIN QUERY PLAN ' + legacyHistoryLookupSql)
      .all(archivedQuery, archivedQuery, archivedQuery).map(row => row.detail);
    assert.ok(sourceLegacyPlan.some(detail => /^SCAN [de](?:\s|$)/.test(detail)));
    assert.ok(archiveLegacyPlan.some(detail => /^SCAN [de](?:\s|$)/.test(detail)));
    const queries = [archivedQuery, activeQuery, idemQuery, missingQuery];
    sourceKernel = measureKernel(sourceDb, historyLookupSql, queries, probes);
    archiveKernel = measureKernel(archiveDb, historyLookupSql, queries, probes);
    sourceLegacyKernel = measureKernel(sourceDb, legacyHistoryLookupSql, queries, probes);
    archiveLegacyKernel = measureKernel(archiveDb, legacyHistoryLookupSql, queries, probes);
  } finally {
    sourceDb.close();
    archiveDb.close();
  }

  const common = { source: sourcePath, secretFile: secretPath, archives: archivePairs };
  const archivedLookup = await measureVerified({ ...common, query: archivedQuery });
  const activeLookup = await measureVerified({ ...common, query: activeQuery });
  const missingLookup = await measureVerified({ ...common, query: missingQuery });
  const verificationCache = createArchiveVerificationCache({ maxEntries: archiveCopies, ttlMs: 60_000 });
  const cachedColdLookup = await measureVerified({ ...common, query: archivedQuery, verificationCache });
  const cachedWarmLookup = await measureVerified({ ...common, query: archivedQuery, verificationCache });
  assert.deepEqual(archivedLookup.result.matches[0].locations.map(location => location.kind),
    ['active_ledger', ...Array(archiveCopies).fill('delivered_archive')]);
  assert.deepEqual(activeLookup.result.matches[0].locations.map(location => location.kind), ['active_ledger']);
  assert.deepEqual(missingLookup.result.matches, []);
  assert.equal(cachedColdLookup.result.verification_cache.misses, archiveCopies);
  assert.equal(cachedWarmLookup.result.verification_cache.hits, archiveCopies);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).artifact_sha256, archived.sha256);

  const report = { observed_at: new Date().toISOString(), node: process.version,
    platform: process.platform, source_deliveries: deliveries, archived_deliveries: eligible,
    signed_archive_copies: archiveCopies,
    probes_per_database: probes, source_query_plan: sourcePlan, archive_query_plan: archivePlan,
    prior_source_query_plan: sourceLegacyPlan, prior_archive_query_plan: archiveLegacyPlan,
    source_kernel: sourceKernel, archive_kernel: archiveKernel,
    prior_source_kernel: sourceLegacyKernel, prior_archive_kernel: archiveLegacyKernel,
    p50_improvement: {
      source_times: Math.round(sourceLegacyKernel.p50_ms / sourceKernel.p50_ms * 10) / 10,
      archive_times: Math.round(archiveLegacyKernel.p50_ms / archiveKernel.p50_ms * 10) / 10
    },
    verified_lookup_ms: { archived_match: archivedLookup.elapsed_ms,
      active_only_match: activeLookup.elapsed_ms, missing: missingLookup.elapsed_ms },
    cached_verified_lookup_ms: { cold: cachedColdLookup.elapsed_ms, warm: cachedWarmLookup.elapsed_ms,
      cold_to_warm_times: Math.round(cachedColdLookup.elapsed_ms / cachedWarmLookup.elapsed_ms * 10) / 10,
      cache: verificationCache.snapshot() },
    scope: 'Local temporary SQLite files. Kernel timings cover prepared exact-identity SQL only. Verified timings include source integrity checks plus archive HMAC, SHA-256, metadata, integrity and foreign-key verification. Warm-cache timing still re-stats the archive, manifest and secret before and after each archive query.'
  };
  const rendered = JSON.stringify(report, null, 2) + '\n';
  if (values.output) await writeFile(resolve(values.output), rendered, 'utf8');
  process.stdout.write(rendered);
} finally {
  await rm(directory, { recursive: true, force: true });
}
