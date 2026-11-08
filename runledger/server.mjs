import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHistoryLookupService } from './history-service.mjs';
import { DomainError, openStore } from './store.mjs';
import { runWorker, verify } from './worker.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);
const demoSecret = Buffer.from('runledger-local-demo-signing-key');

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const limit = 32 * 1024;
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length <= limit) chunks.push(chunk);
  }
  if (length > limit) throw new DomainError(413, 'JSON body exceeds 32 KiB.');
  return Buffer.concat(chunks);
}

function parseObject(raw) {
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new DomainError(400, 'Expected a UTF-8 JSON object.');
  }
}

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new DomainError(415, 'Use Content-Type: application/json.');
  }
  return parseObject(await readBody(request));
}

function validatePayload(value, depth = 0) {
  if (depth > 24) throw new DomainError(400, 'Payload exceeds maximum nesting depth.');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new DomainError(400, 'Payload numbers must be finite.');
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) validatePayload(child, depth + 1);
  }
}

export async function startApp({
  databasePath = resolve('data/runledger.sqlite'),
  port = 4327, workerCount = 2, baseDelayMs = 500, timeoutMs = 1800,
  leaseMs = 5000, maxAttempts = 4, secret = demoSecret,
  historyArchives = [], historySecretFile,
  historyCacheMaxEntries = Math.max(1, historyArchives.length), historyCacheTtlMs = 60_000,
  logger = console
} = {}) {
  if (leaseMs <= timeoutMs) throw new Error('Worker lease must exceed request timeout.');
  if (!logger || typeof logger.error !== 'function') throw new TypeError('Logger must provide an error function.');
  if (databasePath !== ':memory:') await mkdir(dirname(databasePath), { recursive: true });
  const store = openStore(databasePath, { leaseMs, maxAttempts });
  let history;
  try {
    history = createHistoryLookupService({ source: databasePath, archives: historyArchives,
      secretFile: historySecretFile, cacheMaxEntries: historyCacheMaxEntries,
      cacheTtlMs: historyCacheTtlMs });
  } catch (error) {
    store.close();
    throw error;
  }
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5000 }, async (req, res) => {
    try {
      const host = req.headers.host;
      const localPort = server.address().port;
      if (host !== '127.0.0.1:' + localPort && host !== 'localhost:' + localPort) {
        return json(res, 403, { error: 'Use the local RunLedger address.' });
      }
      const origin = 'http://' + host;
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== origin) {
        return json(res, 403, { error: 'Cross-origin writes are disabled.' });
      }
      const { pathname, searchParams } = new URL(req.url, origin);
      if (req.method === 'GET' && assets.has(pathname)) {
        const [name, type] = assets.get(pathname);
        const content = await readFile(new URL('public/' + name, import.meta.url));
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Security-Policy': "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store'
        });
        return res.end(content);
      }
      if (req.method === 'GET' && pathname === '/api/overview') {
        for (const key of searchParams.keys()) {
          if (!['status', 'q', 'limit', 'cursor'].includes(key) || searchParams.getAll(key).length !== 1) {
            throw new DomainError(400, 'Unknown or repeated overview query parameter.');
          }
        }
        const limit = searchParams.get('limit');
        if (limit !== null && !/^[1-9]\d{0,2}$/.test(limit)) {
          throw new DomainError(400, 'Page limit must be an integer from 1 to 100.');
        }
        return json(res, 200, store.overview({
          status: searchParams.get('status') ?? 'all', q: searchParams.get('q') ?? '',
          limit: limit === null ? 25 : Number(limit), cursor: searchParams.get('cursor')
        }));
      }
      if (req.method === 'GET' && pathname === '/api/metrics') {
        return json(res, 200, { ...store.metrics(), history_lookup: history.health() });
      }
      if (req.method === 'GET' && pathname === '/api/history') {
        const keys = [...searchParams.keys()];
        const query = searchParams.get('id');
        if (keys.length !== 1 || keys[0] !== 'id' || searchParams.getAll('id').length !== 1 ||
            typeof query !== 'string' || query.length < 1 || query.length > 256) {
          throw new DomainError(400, 'Use one history id from 1 to 256 characters.');
        }
        if (!history.health().enabled) throw new DomainError(503, 'Signed archive history is not configured.');
        return json(res, 200, await history.lookup(query));
      }
      if (req.method === 'POST' && pathname === '/api/replays') {
        const result = store.replayMany(await readJson(req));
        return json(res, result.duplicate ? 200 : 202, result);
      }
      if (req.method === 'GET' && pathname === '/api/actions') {
        const keys = [...searchParams.keys()];
        const limit = searchParams.get('limit') ?? '20';
        if (keys.some(key => key !== 'limit') || keys.length > 1 || !/^[1-9]\d{0,2}$/.test(limit)) {
          throw new DomainError(400, 'Use one action limit from 1 to 100.');
        }
        return json(res, 200, { actions: store.operatorActions(Number(limit)) });
      }
      if (req.method === 'GET' && pathname === '/api/dispatch') return json(res, 200, store.dispatchStatus());
      if (req.method === 'POST' && pathname === '/api/dispatch') {
        const body = await readJson(req);
        if (Object.keys(body).some(key => !['paused', 'expected_revision'].includes(key))) {
          throw new DomainError(400, 'Dispatch accepts paused and expected_revision.');
        }
        return json(res, 200, store.setDispatch(body));
      }
      const detail = /^\/api\/deliveries\/([0-9a-f-]{36})$/.exec(pathname);
      if (req.method === 'GET' && detail) return json(res, 200, store.detail(detail[1]));
      const replay = /^\/api\/deliveries\/([0-9a-f-]{36})\/replay$/.exec(pathname);
      if (req.method === 'POST' && replay) {
        store.replay(replay[1]);
        return json(res, 202, { delivery_id: replay[1] });
      }
      if (req.method === 'POST' && pathname === '/api/demo/receiver') {
        const { mode } = await readJson(req);
        if (!['healthy', 'transient', 'down'].includes(mode)) throw new DomainError(400, 'Unknown receiver mode.');
        return json(res, 200, store.setReceiver(mode));
      }
      if (req.method === 'POST' && pathname === '/api/demo/seed') {
        const runId = randomUUID();
        return json(res, 202, store.ingest({
          key: runId, type: 'ai.run.completed',
          payload: { run_id: runId, pipeline: 'document-review', result: 'ready', artifact_count: 3 }
        }));
      }
      if (req.method === 'POST' && pathname === '/api/events') {
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[\w.-]{1,128}$/.test(key)) {
          throw new DomainError(400, 'Provide a 1–128 character Idempotency-Key header.');
        }
        const { type, payload } = await readJson(req);
        if (typeof type !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(type) ||
            !payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new DomainError(400, 'Provide an event type and a JSON object payload.');
        }
        validatePayload(payload);
        if (Buffer.byteLength(JSON.stringify(payload)) > 30 * 1024) {
          throw new DomainError(413, 'Event payload exceeds 30 KiB.');
        }
        const result = store.ingest({ key, type, payload });
        return json(res, result.duplicate ? 200 : 202, result);
      }
      if (req.method === 'POST' && pathname === '/demo/receiver') {
        const raw = await readBody(req);
        if (!verify(secret, req.headers, raw)) return json(res, 401, { error: 'Invalid webhook signature.' });
        const result = store.receive(req.headers['webhook-id']);
        return json(res, result.status, result);
      }
      return json(res, 404, { error: 'Route not found.' });
    } catch (error) {
      if (error instanceof DomainError) return json(res, error.status, { error: error.message });
      logger.error(error);
      return json(res, 500, { error: 'RunLedger could not complete the request.' });
    }
  });
  try {
    await new Promise((ready, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', ready);
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const url = 'http://127.0.0.1:' + server.address().port;
  const workers = Array.from({ length: workerCount }, () => runWorker(store, {
    receiverUrl: url + '/demo/receiver', secret, timeoutMs, baseDelayMs
  }));
  return {
    url, store,
    async close() {
      await Promise.all(workers.map(stop => stop()));
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
      store.close();
    }
  };
}

export function historyOptionsFromEnv(environment = process.env) {
  const rawArchives = environment.RUNLEDGER_ARCHIVES_JSON;
  const secretFile = environment.RUNLEDGER_ARCHIVE_SECRET;
  if (rawArchives === undefined && secretFile === undefined) return {};
  if (typeof rawArchives !== 'string' || !rawArchives || typeof secretFile !== 'string' || !secretFile) {
    throw new Error('Set RUNLEDGER_ARCHIVES_JSON and RUNLEDGER_ARCHIVE_SECRET together.');
  }
  let historyArchives;
  try { historyArchives = JSON.parse(rawArchives); } catch { throw new Error('RUNLEDGER_ARCHIVES_JSON must be valid JSON.'); }
  if (!Array.isArray(historyArchives)) throw new Error('RUNLEDGER_ARCHIVES_JSON must contain an array.');
  const integer = (name, fallback) => {
    const raw = environment[name];
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(name + ' must be a positive integer.');
    return Number(raw);
  };
  return {
    historyArchives,
    historySecretFile: secretFile,
    historyCacheMaxEntries: integer('RUNLEDGER_HISTORY_CACHE_ENTRIES', Math.max(1, historyArchives.length)),
    historyCacheTtlMs: integer('RUNLEDGER_HISTORY_CACHE_TTL_MS', 60_000)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startApp({
    databasePath: process.env.RUNLEDGER_DB || resolve('data/runledger.sqlite'),
    port: Number(process.env.RUNLEDGER_PORT || 4327),
    workerCount: Number(process.env.RUNLEDGER_WORKERS || 2),
    secret: process.env.RUNLEDGER_SECRET ? Buffer.from(process.env.RUNLEDGER_SECRET) : demoSecret,
    ...historyOptionsFromEnv()
  });
  console.log('RunLedger is running at ' + app.url);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
