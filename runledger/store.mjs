import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export class DomainError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(
      key => JSON.stringify(key) + ':' + canonicalJson(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function openStore(path, { maxAttempts = 4, leaseMs = 5000 } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 4000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      idem_key TEXT NOT NULL UNIQUE,
      digest TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
      status TEXT NOT NULL CHECK (status IN ('queued','in_flight','delivered','dead')),
      generation INTEGER NOT NULL DEFAULT 1,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL,
      next_at INTEGER,
      created_at INTEGER NOT NULL,
      lease_until INTEGER,
      lease_token TEXT,
      last_error TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(next_at, created_at)
      WHERE status = 'queued';
    CREATE INDEX IF NOT EXISTS deliveries_expiry ON deliveries(lease_until)
      WHERE status = 'in_flight';
    CREATE TABLE IF NOT EXISTS attempts (
      token TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL REFERENCES deliveries(id),
      generation INTEGER NOT NULL,
      number INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      outcome TEXT NOT NULL,
      http_status INTEGER,
      error TEXT,
      UNIQUE(delivery_id, generation, number)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS inbox (
      delivery_id TEXT PRIMARY KEY,
      accepted_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS receiver (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT NOT NULL,
      duplicates INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    INSERT OR IGNORE INTO receiver (id, mode) VALUES (1, 'healthy');
    CREATE TABLE IF NOT EXISTS transient_failures (
      delivery_id TEXT PRIMARY KEY
    ) STRICT;
  `);

  function transaction(callback) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const publicDelivery = `
    SELECT d.id, d.event_id, e.type, d.status, d.generation, d.attempt_count,
      d.max_attempts, d.next_at, d.created_at, d.last_error
    FROM deliveries d JOIN events e ON e.id = d.event_id
  `;

  function ingest({ key, type, payload }, now = Date.now()) {
    const serialized = canonicalJson(payload);
    const digest = createHash('sha256').update(type + '\n' + serialized).digest('hex');
    return transaction(() => {
      const existing = db.prepare(`
        SELECT e.id AS event_id, e.digest, d.id AS delivery_id
        FROM events e JOIN deliveries d ON d.event_id = e.id WHERE e.idem_key = ?
      `).get(key);
      if (existing) {
        if (existing.digest !== digest) throw new DomainError(409, 'Idempotency key already represents a different event.');
        return { event_id: existing.event_id, delivery_id: existing.delivery_id, duplicate: true };
      }
      const eventId = randomUUID();
      const deliveryId = randomUUID();
      db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(eventId, key, digest, type, serialized, now);
      db.prepare(`
        INSERT INTO deliveries (id, event_id, status, max_attempts, next_at, created_at)
        VALUES (?, ?, 'queued', ?, ?, ?)
      `).run(deliveryId, eventId, maxAttempts, now, now);
      return { event_id: eventId, delivery_id: deliveryId, duplicate: false };
    });
  }

  function claim(now = Date.now()) {
    return transaction(() => {
      db.prepare(`
        UPDATE attempts SET finished_at = ?, outcome = 'lease_expired', error = 'Worker lease expired'
        WHERE token IN (SELECT lease_token FROM deliveries WHERE status = 'in_flight' AND lease_until <= ?)
      `).run(now, now);
      db.prepare(`
        UPDATE deliveries SET status = CASE WHEN attempt_count >= max_attempts THEN 'dead' ELSE 'queued' END,
          next_at = CASE WHEN attempt_count >= max_attempts THEN NULL ELSE ? END,
          lease_token = NULL, lease_until = NULL, last_error = 'Worker lease expired'
        WHERE status = 'in_flight' AND lease_until <= ?
      `).run(now, now);
      const job = db.prepare(`
        SELECT d.id, d.event_id, d.generation, d.attempt_count, d.max_attempts,
          e.type, e.payload, e.created_at
        FROM deliveries d JOIN events e ON e.id = d.event_id
        WHERE d.status = 'queued' AND d.next_at <= ? ORDER BY d.next_at, d.created_at, d.id LIMIT 1
      `).get(now);
      if (!job) return null;
      const token = randomUUID();
      const number = job.attempt_count + 1;
      db.prepare(`
        UPDATE deliveries SET status = 'in_flight', attempt_count = ?, lease_token = ?, lease_until = ?, next_at = NULL
        WHERE id = ?
      `).run(number, token, now + leaseMs, job.id);
      db.prepare(`
        INSERT INTO attempts (token, delivery_id, generation, number, started_at, outcome)
        VALUES (?, ?, ?, ?, ?, 'in_flight')
      `).run(token, job.id, job.generation, number, now);
      return { ...job, token, number };
    });
  }

  function finish(job, result, now = Date.now()) {
    return transaction(() => {
      const status = result.outcome === 'retry' ? 'queued' : result.outcome;
      const updated = db.prepare(`
        UPDATE deliveries SET status = ?, next_at = ?, last_error = ?, lease_token = NULL, lease_until = NULL
        WHERE id = ? AND status = 'in_flight' AND lease_token = ? AND lease_until > ?
      `).run(status, result.nextAt ?? null, result.error ?? null, job.id, job.token, now);
      if (!updated.changes) return false;
      db.prepare(`
        UPDATE attempts SET finished_at = ?, outcome = ?, http_status = ?, error = ? WHERE token = ?
      `).run(now, result.outcome, result.httpStatus ?? null, result.error ?? null, job.token);
      return true;
    });
  }

  function replay(id, now = Date.now()) {
    const updated = db.prepare(`
      UPDATE deliveries SET status = 'queued', generation = generation + 1, attempt_count = 0,
        next_at = ?, last_error = NULL WHERE id = ? AND status = 'dead'
    `).run(now, id);
    if (!updated.changes) {
      if (!db.prepare('SELECT 1 FROM deliveries WHERE id = ?').get(id)) throw new DomainError(404, 'Delivery not found.');
      throw new DomainError(409, 'Only dead deliveries can be replayed.');
    }
  }

  function receiverStatus() {
    return db.prepare(`
      SELECT mode, duplicates, (SELECT count(*) FROM inbox) AS processed FROM receiver WHERE id = 1
    `).get();
  }

  function setReceiver(mode) {
    db.prepare('UPDATE receiver SET mode = ? WHERE id = 1').run(mode);
    return receiverStatus();
  }

  function receive(id, now = Date.now()) {
    return transaction(() => {
      const { mode } = receiverStatus();
      if (mode === 'down') return { status: 503, message: 'Receiver is unavailable.' };
      if (mode === 'transient' && db.prepare('INSERT OR IGNORE INTO transient_failures VALUES (?)').run(id).changes) {
        return { status: 503, message: 'Injected transient failure.' };
      }
      const accepted = db.prepare('INSERT OR IGNORE INTO inbox VALUES (?, ?)').run(id, now);
      if (!accepted.changes) db.prepare('UPDATE receiver SET duplicates = duplicates + 1 WHERE id = 1').run();
      return { status: 200, duplicate: !accepted.changes };
    });
  }

  function overview() {
    const stats = { queued: 0, in_flight: 0, delivered: 0, dead: 0 };
    for (const { status, count } of db.prepare('SELECT status, count(*) AS count FROM deliveries GROUP BY status').all()) {
      stats[status] = count;
    }
    return {
      stats,
      deliveries: db.prepare(publicDelivery + ' ORDER BY d.created_at DESC, d.id LIMIT 100').all(),
      receiver: receiverStatus()
    };
  }

  function detail(id) {
    const delivery = db.prepare(publicDelivery + ' WHERE d.id = ?').get(id);
    if (!delivery) throw new DomainError(404, 'Delivery not found.');
    delivery.payload = JSON.parse(db.prepare('SELECT payload FROM events WHERE id = ?').get(delivery.event_id).payload);
    const attempts = db.prepare(`
      SELECT generation, number, started_at, finished_at, outcome, http_status, error
      FROM attempts WHERE delivery_id = ? ORDER BY generation DESC, number DESC
    `).all(id);
    return { delivery, attempts };
  }

  return { ingest, claim, finish, replay, overview, detail, setReceiver, receive, close: () => db.close() };
}
