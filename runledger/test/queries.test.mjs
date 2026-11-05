import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStore } from '../store.mjs';
import { startApp } from '../server.mjs';

function memory(t) {
  const store = openStore(':memory:');
  t.after(() => store.close());
  return store;
}

function add(store, index, time = 1000) {
  return store.ingest({ key: 'query-' + index, type: 'run.completed', payload: { index } }, time);
}

test('Full-ledger filtering finds a dead letter older than the latest 100 records', t => {
  const store = memory(t);
  const old = add(store, 0);
  const job = store.claim(1000);
  store.finish(job, { outcome: 'dead', httpStatus: 400, error: 'Bad receiver request' }, 1001);
  for (let index = 1; index <= 130; index++) add(store, index, 2000 + index);
  assert.equal(store.overview().deliveries.length, 25);

  const filtered = store.overview({ status: 'dead' });
  assert.deepEqual(filtered.deliveries.map(row => row.id), [old.delivery_id]);
  assert.equal(filtered.page.matching, 1);
  assert.equal(filtered.page.next_cursor, null);
  assert.deepEqual(filtered.stats, { queued: 130, in_flight: 0, delivered: 0, dead: 1 });
  for (const q of [old.delivery_id, old.event_id.slice(0, 12), 'RUN.COMPLETED']) {
    assert.ok(store.overview({ q }).page.matching > 0);
  }
});

test('Keyset traversal keeps tied timestamps deterministic and skips later insertions', t => {
  const store = memory(t);
  const expected = Array.from({ length: 73 }, (_, index) => add(store, index).delivery_id).sort().reverse();
  const seen = [];
  let cursor = null;
  do {
    const page = store.overview({ limit: 7, cursor });
    assert.ok(page.deliveries.length <= 7);
    assert.equal(page.page.has_more, page.page.next_cursor !== null);
    seen.push(...page.deliveries.map(row => row.id));
    if (!cursor) add(store, 'newer', 2000);
    cursor = page.page.next_cursor;
  } while (cursor);
  assert.deepEqual(seen, expected);
  assert.equal(store.overview().page.matching, 74);
});

test('Search is literal, combines with status and binds cursors to the query', t => {
  const store = memory(t);
  for (let index = 0; index < 4; index++) add(store, index);
  const page = store.overview({ q: '  RUN.COMPLETED  ', limit: 2 });
  assert.equal(page.page.matching, 4);
  assert.equal(store.overview({ q: '%_\' OR 1=1' }).page.matching, 0);
  assert.equal(store.overview({ q: 'run_completed' }).page.matching, 0);
  assert.equal(store.overview({ q: 'completed', status: 'dead' }).page.matching, 0);
  assert.equal(store.overview({ q: 'run.completed', limit: 2, cursor: page.page.next_cursor }).deliveries.length, 2);
  for (const options of [
    { status: 'missing' }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { q: 'x'.repeat(129) },
    { cursor: 'bogus' }, { cursor: 'e30' }, { cursor: 'null' },
    { q: 'changed', limit: 2, cursor: page.page.next_cursor },
    { q: 'run.completed', limit: 3, cursor: page.page.next_cursor },
    { status: 'dead', q: 'run.completed', limit: 2, cursor: page.page.next_cursor }
  ]) assert.throws(() => store.overview(options), { status: 400 });
});

test('HTTP overview validates query parameters and exposes complete paginated results', async t => {
  const app = await startApp({ databasePath: ':memory:', port: 0, workerCount: 0 });
  t.after(() => app.close());
  const ids = Array.from({ length: 102 }, (_, index) => add(app.store, index).delivery_id).sort().reverse();
  const response = await fetch(app.url + '/api/overview?limit=100&status=queued&q=completed');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const first = await response.json();
  assert.equal(first.page.matching, 102);
  const next = await fetch(app.url + '/api/overview?' + new URLSearchParams({
    limit: '100', status: 'queued', q: 'completed', cursor: first.page.next_cursor
  })).then(res => res.json());
  assert.deepEqual([...first.deliveries, ...next.deliveries].map(row => row.id), ids);
  assert.equal(next.page.next_cursor, null);
  for (const query of [
    'limit=0', 'limit=101', 'limit=2.5', 'limit=1e2', 'limit=', 'status=unknown',
    'q=' + 'a'.repeat(129), 'cursor=invalid', 'limit=1&limit=2', 'unexpected=1'
  ]) {
    const rejected = await fetch(app.url + '/api/overview?' + query);
    assert.equal(rejected.status, 400, query);
    assert.equal(typeof (await rejected.json()).error, 'string');
  }
});
