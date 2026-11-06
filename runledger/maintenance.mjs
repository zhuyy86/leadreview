import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
  operator_actions: ['id', 'operation_key', 'digest', 'kind', 'created_at', 'result']
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
    // Completion age, not event age: a recent replay must not look expired.
    // Unfinished history is excluded even if the current status says delivered.
    const candidate = db.prepare(`
      WITH eligible AS (
        SELECT d.id, e.payload FROM deliveries d JOIN events e ON e.id = d.event_id
        WHERE d.status = 'delivered'
          AND (SELECT max(a.finished_at) FROM attempts a WHERE a.delivery_id = d.id
            AND a.generation = d.generation AND a.outcome = 'delivered') < ?
          AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.delivery_id = d.id AND a.finished_at IS NULL)
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
  return db.prepare(`
    SELECT d.*, e.id AS source_event_id, e.idem_key, e.digest, e.type, e.payload,
      e.created_at AS event_created_at
    FROM deliveries d JOIN events e ON e.id = d.event_id
    WHERE d.status = 'delivered'
      AND (SELECT max(a.finished_at) FROM attempts a WHERE a.delivery_id = d.id
        AND a.generation = d.generation AND a.outcome = 'delivered') < ?
      AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.delivery_id = d.id AND a.finished_at IS NULL)
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
      options: { source: { type: 'string' }, output: { type: 'string' }, before: { type: 'string' } } });
    const operation = parsed.positionals[0];
    if (parsed.positionals.length !== 1 || !parsed.values.source) throw new Error();
    if (operation === 'retention-plan') {
      if (parsed.values.output || !/^\d{1,16}$/.test(parsed.values.before ?? '') ||
          Number(parsed.values.before) > 8640000000000000) throw new Error();
    } else if (operation === 'archive') {
      if (!parsed.values.output || !/^\d{1,16}$/.test(parsed.values.before ?? '') ||
          Number(parsed.values.before) > 8640000000000000) throw new Error();
    } else if (!['backup', 'restore'].includes(operation) || !parsed.values.output || parsed.values.before !== undefined) {
      throw new Error();
    }
  } catch {
    console.error('Usage: node maintenance.mjs backup|restore --source ledger.sqlite --output new.sqlite');
    console.error('       node maintenance.mjs archive --source ledger.sqlite --output archive.sqlite --before epoch_milliseconds');
    console.error('       node maintenance.mjs retention-plan --source ledger.sqlite --before epoch_milliseconds');
    return 2;
  }
  try {
    const operation = parsed.positionals[0];
    const result = operation === 'retention-plan'
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
