import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const requiredColumns = {
  events: ['id', 'idem_key', 'digest', 'type', 'payload', 'created_at'],
  deliveries: ['id', 'event_id', 'status', 'generation', 'attempt_count', 'max_attempts',
    'next_at', 'created_at', 'lease_until', 'lease_token', 'last_error'],
  attempts: ['token', 'delivery_id', 'generation', 'number', 'started_at', 'finished_at', 'outcome', 'http_status', 'error'],
  inbox: ['delivery_id', 'accepted_at'],
  receiver: ['id', 'mode', 'duplicates'],
  transient_failures: ['delivery_id']
};
const optionalColumns = {
  dispatch_control: ['id', 'paused', 'revision', 'updated_at'],
  operator_actions: ['id', 'operation_key', 'digest', 'kind', 'created_at', 'result'],
  archive_checkpoints: ['artifact_sha256', 'artifact_name', 'manifest_sha256', 'manifest_created_at',
    'before_ms', 'counts', 'registered_at'],
  archive_compactions: ['artifact_sha256', 'manifest_sha256', 'compacted_at', 'events_scanned',
    'events_compacted', 'payload_bytes_before', 'payload_bytes_after'],
  archive_compacted_events: ['event_id', 'artifact_sha256', 'original_payload_bytes', 'compacted_at']
};

function inspect(db) {
  const check = db.prepare('PRAGMA quick_check(1)').get();
  if (Object.values(check)[0] !== 'ok') throw new Error('SQLite integrity check failed.');
  for (const [table, columns] of Object.entries({ ...requiredColumns, ...optionalColumns })) {
    const definition = db.prepare("SELECT type FROM sqlite_schema WHERE name = ?").get(table);
    if (!definition && table in optionalColumns) continue;
    const found = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    if (definition?.type !== 'table' || columns.some(column => !found.has(column))) {
      throw new Error('Not a compatible RunLedger database: ' + table);
    }
  }
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('SQLite foreign-key check failed.');
  return Object.fromEntries(['events', 'deliveries', 'attempts', 'inbox'].map(table => [
    table, db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count
  ]));
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sameFileObservation(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size &&
    first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

async function secretKey(path) {
  path = resolve(path);
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Secret key must be a regular file, not a symbolic link.');
  const key = await readFile(path);
  if (key.length < 32 || key.length > 4096) throw new Error('Secret key must contain 32 to 4096 bytes.');
  return { path, key, info };
}

function inspectOfflineArtifact(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 4000 });
  try {
    if (Object.values(db.prepare('PRAGMA quick_check(1)').get())[0] !== 'ok') {
      throw new Error('SQLite integrity check failed.');
    }
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('SQLite foreign-key check failed.');
    const metadata = db.prepare("SELECT type FROM sqlite_schema WHERE name = 'metadata'").get();
    if (metadata?.type === 'table') {
      const rows = Object.fromEntries(db.prepare('SELECT key, value FROM metadata').all().map(row => {
        try { return [row.key, JSON.parse(row.value)]; }
        catch { throw new Error('Archive metadata contains invalid JSON.'); }
      }));
      if (rows.format !== 'runledger-delivered-archive-v1' || !Number.isSafeInteger(rows.before_ms) ||
          !rows.counts || typeof rows.metric_contract !== 'object') {
        throw new Error('Not a compatible RunLedger archive.');
      }
      const actual = Object.fromEntries(['events', 'deliveries', 'attempts', 'inbox', 'operator_actions'].map(table => [
        table, db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count
      ]));
      if (canonicalJson(actual) !== canonicalJson(rows.counts)) throw new Error('Archive metadata counts do not match its rows.');
      return { kind: 'delivered_archive', details: { format: rows.format, before_ms: rows.before_ms,
        counts: actual, metric_contract: rows.metric_contract, identity_contract: rows.identity_contract } };
    }
    return { kind: 'ledger_backup', details: { counts: inspect(db) } };
  } finally { db.close(); }
}

async function publishManifest(output, document) {
  output = resolve(output);
  try {
    await lstat(output);
    throw new Error('Manifest output already exists; choose a new file path.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(output), { recursive: true });
  let staging;
  try {
    staging = await mkdtemp(join(dirname(output), '.runledger-manifest-'));
    const temporary = join(staging, 'manifest.json');
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(document, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await link(temporary, output);
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
  return output;
}

export async function createArtifactManifest({ artifact, output, secretFile }) {
  if (![artifact, output, secretFile].every(value => typeof value === 'string' && value)) {
    throw new TypeError('Provide artifact, output and secret key file paths.');
  }
  artifact = resolve(artifact);
  output = resolve(output);
  const secret = await secretKey(secretFile);
  if (new Set([artifact.toLowerCase(), output.toLowerCase(), secret.path.toLowerCase()]).size !== 3) {
    throw new Error('Artifact, manifest and secret key paths must be distinct.');
  }
  const before = await lstat(artifact, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('Artifact must be a regular file, not a symbolic link.');
  if (sameFileIdentity(before, secret.info)) throw new Error('Artifact and secret key must be distinct files.');
  const inspected = inspectOfflineArtifact(artifact);
  const sha256 = await hashFile(artifact);
  const after = await lstat(artifact, { bigint: true });
  if (!sameFileObservation(before, after)) throw new Error('Artifact changed while its manifest was being created.');
  const body = { version: 1, artifact_name: basename(artifact), artifact_kind: inspected.kind,
    artifact_bytes: Number(after.size), artifact_sha256: sha256, created_at: new Date().toISOString(),
    details: inspected.details };
  const signature = createHmac('sha256', secret.key).update(canonicalJson(body)).digest('hex');
  const document = { ...body, signature: { algorithm: 'hmac-sha256', value: signature } };
  await publishManifest(output, document);
  return { artifact, manifest: output, artifact_kind: body.artifact_kind, artifact_bytes: body.artifact_bytes,
    artifact_sha256: sha256, signature_algorithm: 'hmac-sha256', created_at: body.created_at };
}

export async function verifyArtifactManifest({ artifact, manifest, secretFile }) {
  if (![artifact, manifest, secretFile].every(value => typeof value === 'string' && value)) {
    throw new TypeError('Provide artifact, manifest and secret key file paths.');
  }
  artifact = resolve(artifact);
  manifest = resolve(manifest);
  const secret = await secretKey(secretFile);
  const artifactInfo = await lstat(artifact, { bigint: true });
  const manifestInfo = await lstat(manifest, { bigint: true });
  if (artifactInfo.isSymbolicLink() || !artifactInfo.isFile() || manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
    throw new Error('Artifact and manifest must be regular files, not symbolic links.');
  }
  if (sameFileIdentity(artifactInfo, manifestInfo) || sameFileIdentity(artifactInfo, secret.info) ||
      sameFileIdentity(manifestInfo, secret.info)) throw new Error('Artifact, manifest and secret key must be distinct files.');
  let document;
  let manifestBytes;
  try {
    manifestBytes = await readFile(manifest);
    document = JSON.parse(manifestBytes.toString('utf8'));
  }
  catch (error) { throw new Error('Manifest is not valid JSON: ' + error.message); }
  const manifestAfterRead = await lstat(manifest, { bigint: true });
  if (!sameFileObservation(manifestInfo, manifestAfterRead)) throw new Error('Manifest changed while being verified.');
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  const expectedKeys = ['artifact_bytes', 'artifact_kind', 'artifact_name', 'artifact_sha256', 'created_at', 'details', 'signature', 'version'];
  if (!document || Array.isArray(document) || canonicalJson(Object.keys(document).sort()) !== canonicalJson(expectedKeys) ||
      document.version !== 1 || !document.signature || document.signature.algorithm !== 'hmac-sha256' ||
      !/^[0-9a-f]{64}$/.test(document.signature.value ?? '')) throw new Error('Manifest structure is invalid.');
  const { signature, ...body } = document;
  const expected = createHmac('sha256', secret.key).update(canonicalJson(body)).digest();
  const supplied = Buffer.from(signature.value, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Manifest signature verification failed.');
  if (body.artifact_name !== basename(artifact)) throw new Error('Manifest artifact name does not match the selected file.');
  const info = await lstat(artifact, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Artifact must be a regular file, not a symbolic link.');
  const sha256 = await hashFile(artifact);
  if (Number(info.size) !== body.artifact_bytes || sha256 !== body.artifact_sha256) {
    throw new Error('Artifact checksum or byte count does not match the manifest.');
  }
  const inspected = inspectOfflineArtifact(artifact);
  const after = await lstat(artifact, { bigint: true });
  if (!sameFileObservation(info, after)) throw new Error('Artifact changed while its manifest was being verified.');
  if (inspected.kind !== body.artifact_kind || canonicalJson(inspected.details) !== canonicalJson(body.details)) {
    throw new Error('Artifact contents do not match the manifest metadata.');
  }
  return { verified: true, artifact, manifest, artifact_kind: inspected.kind,
    artifact_bytes: Number(info.size), artifact_sha256: sha256, created_at: body.created_at,
    manifest_sha256: manifestSha256, details: inspected.details };
}

const archiveComparisonColumns = {
  events: ['id', 'idem_key', 'digest', 'type', 'created_at'],
  deliveries: ['id', 'event_id', 'status', 'generation', 'attempt_count', 'max_attempts', 'next_at',
    'created_at', 'lease_until', 'lease_token', 'last_error'],
  attempts: ['token', 'delivery_id', 'generation', 'number', 'started_at', 'finished_at', 'outcome',
    'http_status', 'error'],
  inbox: ['delivery_id', 'accepted_at'],
  operator_actions: ['id', 'operation_key', 'digest', 'kind', 'created_at', 'result']
};
const archivedPayload = canonicalJson({ _runledger_archived: true });

function ensureArchiveTrackingTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_checkpoints (
      artifact_sha256 TEXT PRIMARY KEY CHECK (length(artifact_sha256) = 64),
      artifact_name TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
      manifest_created_at TEXT NOT NULL,
      before_ms INTEGER NOT NULL,
      counts TEXT NOT NULL CHECK (json_valid(counts)),
      registered_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS archive_compactions (
      artifact_sha256 TEXT PRIMARY KEY REFERENCES archive_checkpoints(artifact_sha256),
      manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
      compacted_at INTEGER NOT NULL,
      events_scanned INTEGER NOT NULL CHECK (events_scanned >= 0),
      events_compacted INTEGER NOT NULL CHECK (events_compacted >= 0 AND events_compacted <= events_scanned),
      payload_bytes_before INTEGER NOT NULL CHECK (payload_bytes_before >= 0),
      payload_bytes_after INTEGER NOT NULL CHECK (payload_bytes_after >= 0 AND payload_bytes_after <= payload_bytes_before)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS archive_compacted_events (
      event_id TEXT PRIMARY KEY REFERENCES events(id),
      artifact_sha256 TEXT NOT NULL REFERENCES archive_checkpoints(artifact_sha256),
      original_payload_bytes INTEGER NOT NULL CHECK (original_payload_bytes >= 0),
      compacted_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS archive_compacted_events_artifact
      ON archive_compacted_events(artifact_sha256, event_id);
  `);
}

function compareArchiveRows(db, verified, compacted) {
  for (const [table, columns] of Object.entries(archiveComparisonColumns)) {
    const sourceTable = db.prepare("SELECT type FROM main.sqlite_schema WHERE name = ?").get(table);
    if (!sourceTable && table === 'operator_actions' && verified.details.counts.operator_actions === 0) continue;
    if (sourceTable?.type !== 'table') throw new Error('Source is missing archived table ' + table + '.');
    const projection = columns.join(', ');
    const mismatch = db.prepare(`
      SELECT 1 FROM (
        SELECT ${projection} FROM archived.${table}
        EXCEPT
        SELECT ${projection} FROM main.${table}
      ) LIMIT 1
    `).get();
    if (mismatch) throw new Error('Archive rows diverge from source table ' + table + '.');
  }
  const payloadMismatch = compacted
    ? db.prepare(`
        SELECT 1 FROM archived.events a JOIN main.events s ON s.id = a.id
        LEFT JOIN main.archive_compacted_events c ON c.event_id = a.id
        WHERE c.artifact_sha256 != ? OR c.artifact_sha256 IS NULL OR
          s.payload != CASE WHEN length(CAST(a.payload AS BLOB)) > length(CAST(? AS BLOB))
            THEN ? ELSE a.payload END
        LIMIT 1
      `).get(verified.artifact_sha256, archivedPayload, archivedPayload)
    : db.prepare(`
        SELECT 1 FROM archived.events a JOIN main.events s ON s.id = a.id
        WHERE s.payload != a.payload LIMIT 1
      `).get();
  if (payloadMismatch) throw new Error('Archive rows diverge from source table events.');
}

export async function checkpointArchive({ source, archive, manifest, secretFile, now = Date.now() }) {
  if (![source, archive, manifest, secretFile].every(value => typeof value === 'string' && value) ||
      !Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('Provide source, archive, manifest and secret key paths plus a valid registration time.');
  }
  source = resolve(source);
  archive = resolve(archive);
  manifest = resolve(manifest);
  secretFile = resolve(secretFile);
  const sourceInfo = await lstat(source, { bigint: true });
  const archiveBefore = await lstat(archive, { bigint: true });
  const manifestBefore = await lstat(manifest, { bigint: true });
  const secretInfo = await lstat(secretFile, { bigint: true });
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile() || sameFileIdentity(sourceInfo, archiveBefore) ||
      sameFileIdentity(sourceInfo, manifestBefore) || sameFileIdentity(sourceInfo, secretInfo)) {
    throw new Error('Source, archive, manifest and secret key must be distinct regular files.');
  }
  const verified = await verifyArtifactManifest({ artifact: archive, manifest, secretFile });
  if (verified.artifact_kind !== 'delivered_archive') throw new Error('Archive checkpoint requires a delivered archive.');

  const db = new DatabaseSync(source, { timeout: 4000 });
  let attached = false;
  let transaction = false;
  try {
    db.exec('PRAGMA busy_timeout = 4000; PRAGMA foreign_keys = ON;');
    db.prepare('ATTACH DATABASE ? AS archived').run(archive);
    attached = true;
    db.exec('BEGIN IMMEDIATE');
    transaction = true;
    inspect(db);
    ensureArchiveTrackingTables(db);
    const compaction = db.prepare('SELECT 1 FROM archive_compactions WHERE artifact_sha256 = ?')
      .get(verified.artifact_sha256);
    compareArchiveRows(db, verified, Boolean(compaction));
    const archiveAfter = await lstat(archive, { bigint: true });
    if (!sameFileObservation(archiveBefore, archiveAfter)) throw new Error('Archive changed during checkpoint registration.');
    const manifestAfter = await lstat(manifest, { bigint: true });
    if (!sameFileObservation(manifestBefore, manifestAfter)) throw new Error('Manifest changed during checkpoint registration.');
    const existing = db.prepare('SELECT * FROM archive_checkpoints WHERE artifact_sha256 = ?')
      .get(verified.artifact_sha256);
    if (existing) {
      db.exec('COMMIT');
      transaction = false;
      return { source, archive, manifest, artifact_sha256: existing.artifact_sha256,
        manifest_sha256: existing.manifest_sha256, before_ms: existing.before_ms,
        counts: JSON.parse(existing.counts), registered_at: existing.registered_at,
        compacted: Boolean(compaction), duplicate: true };
    }
    const counts = canonicalJson(verified.details.counts);
    db.prepare('INSERT INTO archive_checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      verified.artifact_sha256, basename(archive), verified.manifest_sha256, verified.created_at,
      verified.details.before_ms, counts, now
    );
    db.exec('COMMIT');
    transaction = false;
    return { source, archive, manifest, artifact_sha256: verified.artifact_sha256,
      manifest_sha256: verified.manifest_sha256, before_ms: verified.details.before_ms,
      counts: verified.details.counts, registered_at: now, compacted: false, duplicate: false };
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    if (attached) db.exec('DETACH DATABASE archived');
    db.close();
  }
}

function publicCompaction(row) {
  return { artifact_sha256: row.artifact_sha256, manifest_sha256: row.manifest_sha256,
    compacted_at: row.compacted_at, events_scanned: row.events_scanned,
    events_compacted: row.events_compacted, payload_bytes_before: row.payload_bytes_before,
    payload_bytes_after: row.payload_bytes_after,
    logical_payload_bytes_reclaimed: row.payload_bytes_before - row.payload_bytes_after };
}

export async function compactArchivedPayloads({ source, archive, manifest, secretFile, now = Date.now() }) {
  if (![source, archive, manifest, secretFile].every(value => typeof value === 'string' && value) ||
      !Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('Provide source, archive, manifest and secret key paths plus a valid compaction time.');
  }
  source = resolve(source);
  archive = resolve(archive);
  manifest = resolve(manifest);
  secretFile = resolve(secretFile);
  const sourceInfo = await lstat(source, { bigint: true });
  const archiveBefore = await lstat(archive, { bigint: true });
  const manifestBefore = await lstat(manifest, { bigint: true });
  const secretInfo = await lstat(secretFile, { bigint: true });
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile() || sameFileIdentity(sourceInfo, archiveBefore) ||
      sameFileIdentity(sourceInfo, manifestBefore) || sameFileIdentity(sourceInfo, secretInfo)) {
    throw new Error('Source, archive, manifest and secret key must be distinct regular files.');
  }
  const verified = await verifyArtifactManifest({ artifact: archive, manifest, secretFile });
  if (verified.artifact_kind !== 'delivered_archive') throw new Error('Payload compaction requires a delivered archive.');

  const db = new DatabaseSync(source, { timeout: 4000 });
  let attached = false;
  let transaction = false;
  try {
    db.exec('PRAGMA busy_timeout = 4000; PRAGMA foreign_keys = ON;');
    db.prepare('ATTACH DATABASE ? AS archived').run(archive);
    attached = true;
    db.exec('BEGIN IMMEDIATE');
    transaction = true;
    inspect(db);
    ensureArchiveTrackingTables(db);
    const checkpoint = db.prepare('SELECT manifest_sha256 FROM archive_checkpoints WHERE artifact_sha256 = ?')
      .get(verified.artifact_sha256);
    if (!checkpoint) throw new Error('Register this signed archive checkpoint before payload compaction.');
    if (checkpoint.manifest_sha256 !== verified.manifest_sha256) {
      throw new Error('Compaction manifest differs from the registered checkpoint manifest.');
    }
    const existing = db.prepare('SELECT * FROM archive_compactions WHERE artifact_sha256 = ?')
      .get(verified.artifact_sha256);
    if (existing) {
      compareArchiveRows(db, verified, true);
      const archiveAfter = await lstat(archive, { bigint: true });
      const manifestAfter = await lstat(manifest, { bigint: true });
      if (!sameFileObservation(archiveBefore, archiveAfter)) throw new Error('Archive changed during payload compaction.');
      if (!sameFileObservation(manifestBefore, manifestAfter)) throw new Error('Manifest changed during payload compaction.');
      db.exec('COMMIT');
      transaction = false;
      return { source, archive, manifest, ...publicCompaction(existing), duplicate: true };
    }
    compareArchiveRows(db, verified, false);
    const stats = db.prepare(`
      SELECT count(*) AS events_scanned,
        coalesce(sum(length(CAST(payload AS BLOB))), 0) AS payload_bytes_before,
        coalesce(sum(CASE WHEN length(CAST(payload AS BLOB)) > length(CAST(? AS BLOB))
          THEN length(CAST(? AS BLOB)) ELSE length(CAST(payload AS BLOB)) END), 0) AS payload_bytes_after,
        coalesce(sum(CASE WHEN length(CAST(payload AS BLOB)) > length(CAST(? AS BLOB)) THEN 1 ELSE 0 END), 0)
          AS events_compacted
      FROM archived.events
    `).get(archivedPayload, archivedPayload, archivedPayload);
    const changed = db.prepare(`
      UPDATE main.events SET payload = ?
      WHERE id IN (SELECT id FROM archived.events)
        AND length(CAST(payload AS BLOB)) > length(CAST(? AS BLOB))
    `).run(archivedPayload, archivedPayload);
    if (changed.changes !== stats.events_compacted) throw new Error('Compaction update count changed inside the transaction.');
    db.prepare(`
      INSERT INTO main.archive_compacted_events
        (event_id, artifact_sha256, original_payload_bytes, compacted_at)
      SELECT id, ?, length(CAST(payload AS BLOB)), ? FROM archived.events
    `).run(verified.artifact_sha256, now);
    compareArchiveRows(db, verified, true);
    db.prepare('INSERT INTO archive_compactions VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      verified.artifact_sha256, verified.manifest_sha256, now, stats.events_scanned,
      stats.events_compacted, stats.payload_bytes_before, stats.payload_bytes_after
    );
    const archiveAfter = await lstat(archive, { bigint: true });
    const manifestAfter = await lstat(manifest, { bigint: true });
    if (!sameFileObservation(archiveBefore, archiveAfter)) throw new Error('Archive changed during payload compaction.');
    if (!sameFileObservation(manifestBefore, manifestAfter)) throw new Error('Manifest changed during payload compaction.');
    db.exec('COMMIT');
    transaction = false;
    return { source, archive, manifest, artifact_sha256: verified.artifact_sha256,
      manifest_sha256: verified.manifest_sha256, compacted_at: now, ...stats,
      logical_payload_bytes_reclaimed: stats.payload_bytes_before - stats.payload_bytes_after,
      duplicate: false };
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    if (attached) db.exec('DETACH DATABASE archived');
    db.close();
  }
}

export function listArchiveCheckpoints({ source }) {
  if (typeof source !== 'string' || !source) throw new TypeError('Provide a source database path.');
  source = resolve(source);
  const db = new DatabaseSync(source, { readOnly: true, timeout: 4000 });
  try {
    inspect(db);
    const table = db.prepare("SELECT type FROM sqlite_schema WHERE name = 'archive_checkpoints'").get();
    if (!table) return { source, checkpoints: [] };
    const hasCompactions = db.prepare("SELECT type FROM sqlite_schema WHERE name = 'archive_compactions'").get();
    const rows = hasCompactions ? db.prepare(`
      SELECT c.artifact_sha256, c.artifact_name, c.manifest_sha256, c.manifest_created_at,
        c.before_ms, c.counts, c.registered_at,
        x.manifest_sha256 AS compaction_manifest_sha256,
        x.compacted_at, x.events_scanned, x.events_compacted,
        x.payload_bytes_before, x.payload_bytes_after
      FROM archive_checkpoints c LEFT JOIN archive_compactions x USING (artifact_sha256)
      ORDER BY c.registered_at DESC, c.artifact_sha256
    `).all() : db.prepare(`
      SELECT artifact_sha256, artifact_name, manifest_sha256, manifest_created_at,
        before_ms, counts, registered_at
      FROM archive_checkpoints ORDER BY registered_at DESC, artifact_sha256
    `).all();
    return { source, checkpoints: rows.map(row => {
      const { compaction_manifest_sha256, compacted_at, events_scanned, events_compacted,
        payload_bytes_before, payload_bytes_after, ...checkpoint } = row;
      return { ...checkpoint, counts: JSON.parse(row.counts), compaction: compacted_at === null || compacted_at === undefined
        ? null : publicCompaction({ artifact_sha256: row.artifact_sha256, manifest_sha256: compaction_manifest_sha256,
          compacted_at, events_scanned, events_compacted, payload_bytes_before, payload_bytes_after }) };
    }) };
  } finally { db.close(); }
}

const historyProjection = `
  d.id AS delivery_id, e.id AS event_id, e.idem_key, e.digest, e.type,
  e.created_at AS event_created_at, d.status, d.generation, d.attempt_count,
  d.max_attempts, d.created_at AS delivery_created_at
`;

export const historyLookupSql = `
  WITH matches AS (
    SELECT ${historyProjection}
    FROM deliveries d JOIN events e ON e.id = d.event_id
    WHERE d.id = ?
    UNION
    SELECT ${historyProjection}
    FROM events e JOIN deliveries d ON d.event_id = e.id
    WHERE e.id = ?
    UNION
    SELECT ${historyProjection}
    FROM events e JOIN deliveries d ON d.event_id = e.id
    WHERE e.idem_key = ?
  )
  SELECT * FROM matches ORDER BY delivery_created_at, delivery_id
`;

function exactHistoryRows(path, query, validate) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 4000 });
  try {
    if (validate) inspect(db);
    return db.prepare(historyLookupSql).all(query, query, query).map(row => ({ ...row }));
  } finally { db.close(); }
}

export async function locateHistory({ source, archives, secretFile, query }) {
  if (typeof source !== 'string' || !source || typeof secretFile !== 'string' || !secretFile ||
      typeof query !== 'string' || query.length < 1 || query.length > 256 ||
      !Array.isArray(archives) || archives.length < 1 || archives.length > 20 ||
      archives.some(item => !item || typeof item.artifact !== 'string' || !item.artifact ||
        typeof item.manifest !== 'string' || !item.manifest)) {
    throw new TypeError('Provide a source, secret key, 1 to 20 archive/manifest pairs and a 1 to 256 character query.');
  }
  source = resolve(source);
  const resolved = archives.map(item => ({ artifact: resolve(item.artifact), manifest: resolve(item.manifest) }));
  if (new Set(resolved.map(item => item.artifact.toLowerCase())).size !== resolved.length ||
      new Set(resolved.map(item => item.manifest.toLowerCase())).size !== resolved.length) {
    throw new Error('Archive and manifest paths must be unique.');
  }

  const candidates = exactHistoryRows(source, query, true).map(record => ({ record,
    location: { kind: 'active_ledger', path: source } }));
  for (const item of resolved) {
    const before = await lstat(item.artifact, { bigint: true });
    const verified = await verifyArtifactManifest({ artifact: item.artifact, manifest: item.manifest, secretFile });
    if (verified.artifact_kind !== 'delivered_archive') throw new Error('History lookup accepts delivered archives only.');
    const rows = exactHistoryRows(item.artifact, query, false);
    const after = await lstat(item.artifact, { bigint: true });
    if (!sameFileObservation(before, after)) throw new Error('Archive changed during history lookup.');
    for (const record of rows) {
      candidates.push({ record, location: { kind: 'delivered_archive', path: item.artifact,
        manifest: item.manifest, artifact_sha256: verified.artifact_sha256,
        manifest_created_at: verified.created_at } });
    }
  }

  const matches = new Map();
  for (const candidate of candidates) {
    const current = matches.get(candidate.record.delivery_id);
    if (!current) {
      matches.set(candidate.record.delivery_id, { ...candidate.record, locations: [candidate.location] });
      continue;
    }
    const { locations, ...record } = current;
    if (canonicalJson(record) !== canonicalJson(candidate.record)) {
      throw new Error('Conflicting history found for delivery ' + candidate.record.delivery_id + '.');
    }
    locations.push(candidate.location);
  }
  return { source, query, archives_verified: resolved.length,
    matches: [...matches.values()].sort((left, right) => left.delivery_id.localeCompare(right.delivery_id)) };
}

export async function planRetention({ source, before }) {
  if (typeof source !== 'string' || !source || !Number.isSafeInteger(before) ||
      before < 0 || before > 8640000000000000) {
    throw new TypeError('Provide a source path and a valid epoch-millisecond cutoff.');
  }
  source = resolve(source);
  if (!(await stat(source)).isFile()) throw new Error('Source must be an existing database file.');
  const db = new DatabaseSync(source, { readOnly: true, timeout: 4000 });
  try {
    db.exec('BEGIN');
    const counts = inspect(db);
    const compactedExclusion = db.prepare("SELECT type FROM sqlite_schema WHERE name = 'archive_compacted_events'").get()
      ? 'AND NOT EXISTS (SELECT 1 FROM archive_compacted_events c WHERE c.event_id = e.id)' : '';
    // Completion age, not event age: a recent replay must not look expired.
    // Unfinished history is excluded even if the current status says delivered.
    const candidate = db.prepare(`
      WITH eligible AS (
        SELECT d.id, e.payload FROM deliveries d JOIN events e ON e.id = d.event_id
        WHERE d.status = 'delivered'
          AND (SELECT max(a.finished_at) FROM attempts a WHERE a.delivery_id = d.id
            AND a.generation = d.generation AND a.outcome = 'delivered') < ?
          AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.delivery_id = d.id AND a.finished_at IS NULL)
          ${compactedExclusion}
      )
      SELECT count(*) AS deliveries,
        coalesce(sum(length(CAST(payload AS BLOB))), 0) AS payload_bytes,
        (SELECT count(*) FROM attempts a JOIN eligible e ON e.id = a.delivery_id) AS attempts
      FROM eligible
    `).get(before);
    const protectedDeliveries = Object.fromEntries(db.prepare(`
      SELECT status, count(*) AS count FROM deliveries WHERE status != 'delivered' GROUP BY status
    `).all().map(row => [row.status, row.count]));
    db.exec('COMMIT');
    return {
      source, before_ms: before, mode: 'preview_only',
      candidates: { ...candidate },
      retained: { idempotency_keys: counts.events, inbox_receipts: counts.inbox,
        deliveries_not_eligible: counts.deliveries - candidate.deliveries,
        non_delivered: { queued: 0, in_flight: 0, dead: 0, ...protectedDeliveries } },
      deletion_enabled: false,
      constraints: [
        'Keep event identities, digests and idempotency keys; keep receiver inbox receipts.',
        'Keep queued, in-flight and dead-letter payloads and all their replay history.',
        'Candidate attempts still feed exact latency and outcome metrics; archive or aggregate before deleting.',
        'Payload bytes are logical UTF-8 sizes, not SQLite disk-space savings.'
      ]
    };
  } finally {
    db.close();
  }
}

function eligibleDeliveries(db, before) {
  const compactedExclusion = db.prepare("SELECT type FROM sqlite_schema WHERE name = 'archive_compacted_events'").get()
    ? 'AND NOT EXISTS (SELECT 1 FROM archive_compacted_events c WHERE c.event_id = e.id)' : '';
  return db.prepare(`
    SELECT d.*, e.id AS source_event_id, e.idem_key, e.digest, e.type, e.payload,
      e.created_at AS event_created_at
    FROM deliveries d JOIN events e ON e.id = d.event_id
    WHERE d.status = 'delivered'
      AND (SELECT max(a.finished_at) FROM attempts a WHERE a.delivery_id = d.id
        AND a.generation = d.generation AND a.outcome = 'delivered') < ?
      AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.delivery_id = d.id AND a.finished_at IS NULL)
      ${compactedExclusion}
    ORDER BY d.created_at, d.id
  `).all(before);
}

export async function archiveDelivered({ source, output, before }) {
  if (typeof source !== 'string' || !source || typeof output !== 'string' || !output ||
      !Number.isSafeInteger(before) || before < 0 || before > 8640000000000000) {
    throw new TypeError('Provide source and output paths plus a valid epoch-millisecond cutoff.');
  }
  source = resolve(source);
  output = resolve(output);
  const suffixes = ['-wal', '-shm', '-journal'];
  if (output.toLowerCase() === source.toLowerCase() ||
      suffixes.some(suffix => output.toLowerCase() === (source + suffix).toLowerCase())) {
    throw new Error('Archive output must be separate from the source database and its sidecars.');
  }
  for (const path of [output, ...suffixes.map(suffix => output + suffix)]) {
    try {
      await lstat(path);
      throw new Error('Archive output or its SQLite sidecar already exists; choose a new file path.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!(await stat(source)).isFile()) throw new Error('Source must be an existing database file.');
  const db = new DatabaseSync(source, { readOnly: true, timeout: 4000 });
  let staging;
  try {
    db.exec('BEGIN');
    inspect(db);
    const selected = eligibleDeliveries(db, before);
    const ids = new Set(selected.map(row => row.id));
    await mkdir(dirname(output), { recursive: true });
    staging = await mkdtemp(join(dirname(output), '.runledger-archive-'));
    const temporary = join(staging, 'archive.sqlite');
    const archive = new DatabaseSync(temporary);
    try {
      archive.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE events (
          id TEXT PRIMARY KEY, idem_key TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
          type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE deliveries (
          id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
          status TEXT NOT NULL, generation INTEGER NOT NULL, attempt_count INTEGER NOT NULL,
          max_attempts INTEGER NOT NULL, next_at INTEGER, created_at INTEGER NOT NULL,
          lease_until INTEGER, lease_token TEXT, last_error TEXT
        ) STRICT;
        CREATE TABLE attempts (
          token TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES deliveries(id),
          generation INTEGER NOT NULL, number INTEGER NOT NULL, started_at INTEGER NOT NULL,
          finished_at INTEGER, outcome TEXT NOT NULL, http_status INTEGER, error TEXT,
          UNIQUE(delivery_id, generation, number)
        ) STRICT;
        CREATE TABLE inbox (delivery_id TEXT PRIMARY KEY, accepted_at INTEGER NOT NULL) STRICT;
        CREATE TABLE operator_actions (
          id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
          kind TEXT NOT NULL, created_at INTEGER NOT NULL, result TEXT NOT NULL
        ) STRICT;
      `);
      archive.exec('BEGIN IMMEDIATE');
      const insertEvent = archive.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)');
      const insertDelivery = archive.prepare('INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const row of selected) {
        insertEvent.run(row.source_event_id, row.idem_key, row.digest, row.type, row.payload, row.event_created_at);
        insertDelivery.run(row.id, row.event_id, row.status, row.generation, row.attempt_count,
          row.max_attempts, row.next_at, row.created_at, row.lease_until, row.lease_token, row.last_error);
      }
      const insertAttempt = archive.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const insertInbox = archive.prepare('INSERT INTO inbox VALUES (?, ?)');
      for (const id of ids) {
        for (const row of db.prepare('SELECT * FROM attempts WHERE delivery_id = ? ORDER BY generation, number').all(id)) {
          insertAttempt.run(row.token, row.delivery_id, row.generation, row.number, row.started_at,
            row.finished_at, row.outcome, row.http_status, row.error);
        }
        const receipt = db.prepare('SELECT * FROM inbox WHERE delivery_id = ?').get(id);
        if (receipt) insertInbox.run(receipt.delivery_id, receipt.accepted_at);
      }
      const insertAction = archive.prepare('INSERT INTO operator_actions VALUES (?, ?, ?, ?, ?, ?)');
      let actionCount = 0;
      const actionRows = db.prepare("SELECT type FROM sqlite_schema WHERE name = 'operator_actions'").get()
        ? db.prepare('SELECT * FROM operator_actions ORDER BY created_at, id').all() : [];
      for (const row of actionRows) {
        let targets = [];
        try { targets = JSON.parse(row.result).deliveries ?? []; } catch { throw new Error('Operator action receipt is invalid JSON.'); }
        if (targets.some(target => ids.has(target.id))) {
          insertAction.run(row.id, row.operation_key, row.digest, row.kind, row.created_at, row.result);
          actionCount++;
        }
      }
      const attemptCount = archive.prepare('SELECT count(*) AS count FROM attempts').get().count;
      const inboxCount = archive.prepare('SELECT count(*) AS count FROM inbox').get().count;
      const metadata = {
        format: 'runledger-delivered-archive-v1',
        before_ms: before,
        created_at: new Date().toISOString(),
        source: source,
        counts: { events: selected.length, deliveries: selected.length, attempts: attemptCount,
          inbox: inboxCount, operator_actions: actionCount },
        metric_contract: {
          attempt: 'all archived finished attempts across every generation',
          event_to_delivery: 'event created_at to successful completion of the archived current generation',
          generation_to_delivery: 'first claim in the successful current generation to its successful completion',
          percentile: 'exact nearest-rank; negative wall-clock differences excluded and counted'
        },
        identity_contract: 'Event IDs, idempotency keys/digests, delivery IDs, inbox receipts and related replay receipts are preserved.'
      };
      const insertMetadata = archive.prepare('INSERT INTO metadata VALUES (?, ?)');
      for (const [key, value] of Object.entries(metadata)) insertMetadata.run(key, JSON.stringify(value));
      archive.exec('COMMIT');
      if (Object.values(archive.prepare('PRAGMA quick_check(1)').get())[0] !== 'ok' ||
          archive.prepare('PRAGMA foreign_key_check').get()) throw new Error('Archive validation failed.');
      archive.exec('VACUUM');
    } finally {
      archive.close();
    }
    db.exec('COMMIT');
    await chmod(temporary, 0o600);
    const handle = await open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    const sha256 = await hashFile(temporary);
    const { size: bytes } = await stat(temporary);
    await link(temporary, output);
    const verified = new DatabaseSync(output, { readOnly: true });
    let counts;
    try {
      if (Object.values(verified.prepare('PRAGMA quick_check(1)').get())[0] !== 'ok' ||
          verified.prepare('PRAGMA foreign_key_check').get()) throw new Error('Published archive validation failed.');
      counts = JSON.parse(verified.prepare("SELECT value FROM metadata WHERE key = 'counts'").get().value);
    }
    finally { verified.close(); }
    return { source, output, before_ms: before, bytes, sha256, counts,
      completed_at: new Date().toISOString(), source_modified: false };
  } finally {
    try { db.close(); } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }
}

export async function snapshotLedger({ source, output, onProgress }) {
  if (typeof source !== 'string' || !source || typeof output !== 'string' || !output) {
    throw new TypeError('Provide source and output file paths.');
  }
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function.');
  source = resolve(source);
  output = resolve(output);
  const suffixes = ['-wal', '-shm', '-journal'];
  if (suffixes.some(suffix => output.toLowerCase() === (source + suffix).toLowerCase())) {
    throw new Error('Output must not use a source database sidecar path.');
  }
  // lstat also rejects an existing symlink, including a dangling one.
  for (const path of [output, ...suffixes.map(suffix => output + suffix)]) {
    try {
      await lstat(path);
      throw new Error('Output or its SQLite sidecar already exists; choose a new file path.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!(await stat(source)).isFile()) throw new Error('Source must be an existing database file.');
  const db = new DatabaseSync(source, { readOnly: true, timeout: 4000 });
  let staging;
  try {
    // Pin one committed read snapshot while WAL writers continue independently.
    db.exec('BEGIN');
    inspect(db);
    await mkdir(dirname(output), { recursive: true });
    staging = await mkdtemp(join(dirname(output), '.runledger-snapshot-'));
    const temporary = join(staging, 'snapshot.sqlite');
    const pages = await backup(db, temporary, { progress: onProgress });
    db.exec('COMMIT');
    const snapshot = new DatabaseSync(temporary);
    let counts;
    try {
      // Publish a standalone file, not a main DB that still depends on a WAL.
      snapshot.exec('PRAGMA journal_mode = DELETE');
      counts = inspect(snapshot);
    } finally {
      snapshot.close();
    }
    await chmod(temporary, 0o600);
    const handle = await open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    const sha256 = await hashFile(temporary);
    const { size: bytes } = await stat(temporary);
    // Same-directory staging keeps the hard link on the same filesystem.
    // link() publishes atomically and fails if any competing writer won.
    await link(temporary, output);
    return { source, output, pages, bytes, sha256, counts, completed_at: new Date().toISOString() };
  } finally {
    try { db.close(); } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true,
      options: { source: { type: 'string' }, output: { type: 'string' }, before: { type: 'string' },
        artifact: { type: 'string' }, manifest: { type: 'string' }, 'secret-file': { type: 'string' },
        archive: { type: 'string', multiple: true }, 'archive-manifest': { type: 'string', multiple: true },
        id: { type: 'string' } } });
    const operation = parsed.positionals[0];
    if (parsed.positionals.length !== 1) throw new Error();
    const archiveOptions = parsed.values.archive ?? [];
    const archiveManifestOptions = parsed.values['archive-manifest'] ?? [];
    if (operation === 'sign-manifest') {
      if (!parsed.values.artifact || !parsed.values.output || !parsed.values['secret-file'] || parsed.values.source ||
          parsed.values.manifest || parsed.values.before !== undefined || archiveOptions.length ||
          archiveManifestOptions.length || parsed.values.id) throw new Error();
    } else if (operation === 'verify-manifest') {
      if (!parsed.values.artifact || !parsed.values.manifest || !parsed.values['secret-file'] || parsed.values.source ||
          parsed.values.output || parsed.values.before !== undefined || archiveOptions.length ||
          archiveManifestOptions.length || parsed.values.id) throw new Error();
    } else if (operation === 'locate-history') {
      if (!parsed.values.source || !parsed.values['secret-file'] || !parsed.values.id || parsed.values.artifact ||
          parsed.values.manifest || parsed.values.output || parsed.values.before !== undefined ||
          archiveOptions.length < 1 || archiveOptions.length > 20 ||
          archiveOptions.length !== archiveManifestOptions.length) throw new Error();
    } else if (operation === 'checkpoint-archive') {
      if (!parsed.values.source || !parsed.values['secret-file'] || parsed.values.id || parsed.values.artifact ||
          parsed.values.manifest || parsed.values.output || parsed.values.before !== undefined ||
          archiveOptions.length !== 1 || archiveManifestOptions.length !== 1) throw new Error();
    } else if (operation === 'compact-payloads') {
      if (!parsed.values.source || !parsed.values['secret-file'] || parsed.values.id || parsed.values.artifact ||
          parsed.values.manifest || parsed.values.output || parsed.values.before !== undefined ||
          archiveOptions.length !== 1 || archiveManifestOptions.length !== 1) throw new Error();
    } else if (operation === 'list-checkpoints') {
      if (!parsed.values.source || parsed.values['secret-file'] || parsed.values.id || parsed.values.artifact ||
          parsed.values.manifest || parsed.values.output || parsed.values.before !== undefined ||
          archiveOptions.length || archiveManifestOptions.length) throw new Error();
    } else if (!parsed.values.source || parsed.values.artifact || parsed.values.manifest || parsed.values['secret-file']) {
      throw new Error();
    } else if (operation === 'retention-plan') {
      if (parsed.values.output || !/^\d{1,16}$/.test(parsed.values.before ?? '') ||
          Number(parsed.values.before) > 8640000000000000 || archiveOptions.length ||
          archiveManifestOptions.length || parsed.values.id) throw new Error();
    } else if (operation === 'archive') {
      if (!parsed.values.output || !/^\d{1,16}$/.test(parsed.values.before ?? '') ||
          Number(parsed.values.before) > 8640000000000000 || archiveOptions.length ||
          archiveManifestOptions.length || parsed.values.id) throw new Error();
    } else if (!['backup', 'restore'].includes(operation) || !parsed.values.output || parsed.values.before !== undefined ||
        archiveOptions.length || archiveManifestOptions.length || parsed.values.id) {
      throw new Error();
    }
  } catch {
    console.error('Usage: node maintenance.mjs backup|restore --source ledger.sqlite --output new.sqlite');
    console.error('       node maintenance.mjs archive --source ledger.sqlite --output archive.sqlite --before epoch_milliseconds');
    console.error('       node maintenance.mjs retention-plan --source ledger.sqlite --before epoch_milliseconds');
    console.error('       node maintenance.mjs sign-manifest --artifact file.sqlite --output file.manifest.json --secret-file key');
    console.error('       node maintenance.mjs verify-manifest --artifact file.sqlite --manifest file.manifest.json --secret-file key');
    console.error('       node maintenance.mjs locate-history --source ledger.sqlite --archive old.sqlite --archive-manifest old.manifest.json --secret-file key --id value');
    console.error('       node maintenance.mjs checkpoint-archive --source ledger.sqlite --archive old.sqlite --archive-manifest old.manifest.json --secret-file key');
    console.error('       node maintenance.mjs compact-payloads --source ledger.sqlite --archive old.sqlite --archive-manifest old.manifest.json --secret-file key');
    console.error('       node maintenance.mjs list-checkpoints --source ledger.sqlite');
    return 2;
  }
  try {
    const operation = parsed.positionals[0];
    const result = operation === 'sign-manifest'
      ? await createArtifactManifest({ artifact: parsed.values.artifact, output: parsed.values.output,
        secretFile: parsed.values['secret-file'] })
      : operation === 'verify-manifest'
        ? await verifyArtifactManifest({ artifact: parsed.values.artifact, manifest: parsed.values.manifest,
          secretFile: parsed.values['secret-file'] })
        : operation === 'locate-history'
          ? await locateHistory({ source: parsed.values.source, secretFile: parsed.values['secret-file'],
            query: parsed.values.id, archives: parsed.values.archive.map((artifact, index) =>
              ({ artifact, manifest: parsed.values['archive-manifest'][index] })) })
        : operation === 'checkpoint-archive'
          ? await checkpointArchive({ source: parsed.values.source, archive: parsed.values.archive[0],
            manifest: parsed.values['archive-manifest'][0], secretFile: parsed.values['secret-file'] })
        : operation === 'compact-payloads'
          ? await compactArchivedPayloads({ source: parsed.values.source, archive: parsed.values.archive[0],
            manifest: parsed.values['archive-manifest'][0], secretFile: parsed.values['secret-file'] })
        : operation === 'list-checkpoints'
          ? listArchiveCheckpoints({ source: parsed.values.source })
        : operation === 'retention-plan'
          ? await planRetention({ source: parsed.values.source, before: Number(parsed.values.before) })
          : operation === 'archive'
            ? await archiveDelivered({ source: parsed.values.source, output: parsed.values.output,
              before: Number(parsed.values.before) })
            : await snapshotLedger(parsed.values);
    console.log(JSON.stringify({ operation: parsed.positionals[0], ...result }, null, 2));
    return 0;
  } catch (error) {
    console.error('RunLedger maintenance: ' + error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
