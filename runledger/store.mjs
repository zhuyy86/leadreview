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

const statuses = new Set(['all', 'queued', 'in_flight', 'delivered', 'dead']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function deliveryQuery({ status = 'all', q = '', limit = 25, cursor = null } = {}) {
  if (!statuses.has(status)) throw new DomainError(400, 'Unknown delivery status.');
  if (typeof q !== 'string' || q.length > 128) throw new DomainError(400, 'Search is limited to 128 characters.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new DomainError(400, 'Page limit must be an integer from 1 to 100.');
  }
  q = q.trim().toLowerCase();
  let after = null;
  if (cursor !== null) {
    try {
      if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw new Error();
      after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (after.v !== 1 || !Number.isSafeInteger(after.t) || after.t < 0 || !uuid.test(after.id) ||
          after.status !== status || after.q !== q || after.limit !== limit) throw new Error();
    } catch {
      throw new DomainError(400, 'Invalid cursor. Restart pagination after changing the search, status or limit.');
    }
  }
  return { status, q, limit, after };
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
    CREATE INDEX IF NOT EXISTS deliveries_created ON deliveries(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS deliveries_status_created ON deliveries(status, created_at DESC, id DESC);
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
    CREATE TABLE IF NOT EXISTS dispatch_control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO dispatch_control VALUES (1, 0, 0, 0);
  `);

  function transaction(callback, write = true) {
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
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
      if (dispatchStatus().paused) return null;
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

  function dispatchStatus() {
    const row = db.prepare('SELECT paused, revision, updated_at FROM dispatch_control WHERE id = 1').get();
    return { ...row, paused: Boolean(row.paused) };
  }

  function setDispatch({ paused, expected_revision }, now = Date.now()) {
    if (typeof paused !== 'boolean' || !Number.isSafeInteger(expected_revision) || expected_revision < 0) {
      throw new DomainError(400, 'Provide paused as a boolean and the current expected_revision.');
    }
    return transaction(() => {
      const current = dispatchStatus();
      if (current.revision !== expected_revision) {
        throw new DomainError(409, 'Dispatch changed in another session. Refresh its current revision.');
      }
      if (current.paused !== paused) {
        db.prepare('UPDATE dispatch_control SET paused = ?, revision = revision + 1, updated_at = ? WHERE id = 1')
          .run(paused ? 1 : 0, now);
      }
      return dispatchStatus();
    });
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

  function deliveryStats() {
    const stats = { queued: 0, in_flight: 0, delivered: 0, dead: 0 };
    for (const { status, count } of db.prepare('SELECT status, count(*) AS count FROM deliveries GROUP BY status').all()) {
      stats[status] = count;
    }
    return stats;
  }

  function queueHealth(now) {
    const due = db.prepare(`
      SELECT count(*) AS count, min(next_at) AS oldest_at FROM deliveries
      WHERE status = 'queued' AND next_at <= ?
    `).get(now);
    return {
      due_now: due.count,
      oldest_due_age_ms: due.oldest_at === null ? 0 : Math.max(0, now - due.oldest_at),
      scheduled: db.prepare("SELECT count(*) AS count FROM deliveries WHERE status = 'queued' AND next_at > ?").get(now).count,
      expired_leases: db.prepare("SELECT count(*) AS count FROM deliveries WHERE status = 'in_flight' AND lease_until <= ?").get(now).count
    };
  }

  function latencySummary(sampleSql) {
    // Exact nearest-rank percentiles stay inside SQLite rather than loading
    // the complete history into JavaScript. sampleSql is application SQL only.
    return { ...db.prepare(`
      WITH samples AS (${sampleSql}), ranked AS (
        SELECT elapsed, row_number() OVER (ORDER BY elapsed) AS rank,
          count(*) OVER () AS total FROM samples WHERE elapsed >= 0
      )
      SELECT count(*) AS sample_count,
        (SELECT count(*) FROM samples WHERE elapsed < 0) AS invalid_sample_count,
        min(elapsed) AS min_ms, round(avg(elapsed), 2) AS mean_ms, max(elapsed) AS max_ms,
        max(CASE WHEN rank = (total * 50 + 99) / 100 THEN elapsed END) AS p50_ms,
        max(CASE WHEN rank = (total * 95 + 99) / 100 THEN elapsed END) AS p95_ms,
        max(CASE WHEN rank = (total * 99 + 99) / 100 THEN elapsed END) AS p99_ms
      FROM ranked
    `).get() };
  }

  function latencyMetrics() {
    return {
      attempt: latencySummary(`
        SELECT finished_at - started_at AS elapsed FROM attempts
        WHERE finished_at IS NOT NULL AND outcome != 'in_flight'
      `),
      event_to_delivery: latencySummary(`
        SELECT a.finished_at - d.created_at AS elapsed FROM deliveries d
        JOIN attempts a ON a.delivery_id = d.id AND a.generation = d.generation
        WHERE d.status = 'delivered' AND a.outcome = 'delivered' AND a.finished_at IS NOT NULL
      `),
      generation_to_delivery: latencySummary(`
        SELECT a.finished_at - (
          SELECT min(first.started_at) FROM attempts first
          WHERE first.delivery_id = d.id AND first.generation = d.generation
        ) AS elapsed FROM deliveries d
        JOIN attempts a ON a.delivery_id = d.id AND a.generation = d.generation
        WHERE d.status = 'delivered' AND a.outcome = 'delivered' AND a.finished_at IS NOT NULL
      `)
    };
  }

  function metrics(now = Date.now()) {
    return transaction(() => {
      const attempts = { in_flight: 0, delivered: 0, retry: 0, dead: 0, lease_expired: 0 };
      for (const { outcome, count } of db.prepare('SELECT outcome, count(*) AS count FROM attempts GROUP BY outcome').all()) {
        attempts[outcome] = count;
      }
      return { observed_at: now, deliveries: deliveryStats(), queue: queueHealth(now), attempts,
        latency: latencyMetrics(), receiver: receiverStatus(), dispatch: dispatchStatus() };
    }, false);
  }

  function overview(options) {
    const { status, q, limit, after } = deliveryQuery(options);
    const clauses = [];
    const parameters = [];
    if (status !== 'all') {
      clauses.push('d.status = ?');
      parameters.push(status);
    }
    if (q) {
      // instr treats %, _ and SQL-looking text as literal search characters.
      clauses.push('(instr(lower(e.type), ?) > 0 OR instr(d.event_id, ?) > 0 OR instr(d.id, ?) > 0)');
      parameters.push(q, q, q);
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    return transaction(() => {
      const stats = deliveryStats();
      const { count: matching } = db.prepare(`
        SELECT count(*) AS count FROM deliveries d JOIN events e ON e.id = d.event_id
      ` + where).get(...parameters);
      let pageWhere = where;
      const pageParameters = [...parameters];
      if (after) {
        pageWhere += (where ? ' AND ' : ' WHERE ') + '(d.created_at, d.id) < (?, ?)';
        pageParameters.push(after.t, after.id);
      }
      const deliveries = db.prepare(publicDelivery + pageWhere +
        ' ORDER BY d.created_at DESC, d.id DESC LIMIT ?').all(...pageParameters, limit + 1);
      const hasMore = deliveries.length > limit;
      if (hasMore) deliveries.pop();
      const last = deliveries.at(-1);
      const nextCursor = hasMore ? Buffer.from(JSON.stringify({
        v: 1, t: last.created_at, id: last.id, status, q, limit
      })).toString('base64url') : null;
      return {
        stats, deliveries, receiver: receiverStatus(), queue_health: queueHealth(Date.now()), dispatch: dispatchStatus(),
        page: { limit, matching, has_more: hasMore, next_cursor: nextCursor }
      };
    }, false);
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

  return { ingest, claim, finish, replay, overview, metrics, detail, setReceiver, receive,
    dispatchStatus, setDispatch, close: () => db.close() };
}
