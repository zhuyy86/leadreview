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
const optionalColumns = { dispatch_control: ['id', 'paused', 'revision', 'updated_at'] };

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
    } else if (!['backup', 'restore'].includes(operation) || !parsed.values.output || parsed.values.before !== undefined) {
      throw new Error();
    }
  } catch {
    console.error('Usage: node maintenance.mjs backup|restore --source ledger.sqlite --output new.sqlite');
    console.error('       node maintenance.mjs retention-plan --source ledger.sqlite --before epoch_milliseconds');
    return 2;
  }
  try {
    const result = parsed.positionals[0] === 'retention-plan'
      ? await planRetention({ source: parsed.values.source, before: Number(parsed.values.before) })
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
