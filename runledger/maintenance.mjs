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

function inspect(db) {
  const check = db.prepare('PRAGMA quick_check(1)').get();
  if (Object.values(check)[0] !== 'ok') throw new Error('SQLite integrity check failed.');
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const definition = db.prepare("SELECT type FROM sqlite_schema WHERE name = ?").get(table);
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
      options: { source: { type: 'string' }, output: { type: 'string' } } });
    if (parsed.positionals.length !== 1 || !['backup', 'restore'].includes(parsed.positionals[0]) ||
        !parsed.values.source || !parsed.values.output) throw new Error();
  } catch {
    console.error('Usage: node maintenance.mjs backup|restore --source ledger.sqlite --output new.sqlite');
    return 2;
  }
  try {
    const result = await snapshotLedger(parsed.values);
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
