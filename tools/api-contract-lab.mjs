/** API Contract Lab — reproducible HTTP integration regression demo. MIT. */
import http from 'node:http';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const html = x => String(x).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const retryable = new Set([429, 502, 503, 504]);

export function jsonAt(value, path) {
  return path.split('.').reduce((v, k) => v != null && Object.hasOwn(v, k) ? v[k] : undefined, value);
}

export function parseSSE(text) {
  const events = [];
  for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = block.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (data) events.push(data === '[DONE]' ? '[DONE]' : JSON.parse(data));
  }
  return events;
}

function validate(test) {
  if (!test || typeof test.name !== 'string' || !test.name.trim()) throw Error('Each case needs a name');
  const url = new URL(test.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid HTTP URL');
  if (url.search || url.hash) throw Error('Place credentials in headerEnv, not URL query strings');
  if (!Number.isInteger(test.status ?? 200)) throw Error('status must be an integer');
  if (!Number.isInteger(test.timeoutMs ?? 2000) || (test.timeoutMs ?? 2000) < 1) throw Error('Invalid timeoutMs');
  if (!Number.isInteger(test.retries ?? 0) || (test.retries ?? 0) < 0 || (test.retries ?? 0) > 3) throw Error('retries must be 0..3');
  if (test.checks && !Array.isArray(test.checks)) throw Error('checks must be an array');
  for (const check of test.checks ?? []) {
    if (typeof check.path !== 'string' || !check.path) throw Error('check.path required');
    if (!Object.hasOwn(check, 'equals') && !Object.hasOwn(check, 'type')) throw Error('Check needs type or equals');
    if (check.type && !['string', 'number', 'boolean', 'object', 'array', 'null'].includes(check.type)) throw Error('Unknown type');
  }
}

async function boundedBody(response, maxBytes = 1024 * 1024) {
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw Error('Response exceeds 1 MiB');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function runCase(test, env = process.env) {
  validate(test);
  const headers = {'Content-Type': 'application/json', ...(test.headers ?? {})};
  for (const [header, variable] of Object.entries(test.headerEnv ?? {})) {
    if (!env[variable]) throw Error(`Missing environment variable for ${header}`);
    headers[header] = env[variable];
  }
  const start = performance.now();
  const result = {name: test.name, passed: false, attempts: 0, status: null, durationMs: 0, failures: []};
  for (let attempt = 0; attempt <= (test.retries ?? 0); attempt++) {
    result.attempts++;
    let response;
    try {
      response = await fetch(test.url, {
        method: test.method ?? 'GET', headers,
        body: test.body === undefined ? undefined : JSON.stringify(test.body),
        signal: AbortSignal.timeout(test.timeoutMs ?? 2000), redirect: 'error'
      });
      result.status = response.status;
      // POST retries are opt-in because inference requests can incur duplicate cost.
      const mayRetry = ['GET', 'HEAD'].includes(test.method ?? 'GET') || test.allowReplay === true;
      if (retryable.has(response.status) && attempt < (test.retries ?? 0) && mayRetry) {
        const retryAfter = Number(response.headers.get('retry-after') ?? 0);
        await response.body?.cancel();
        await pause(Math.min(2000, Math.max(50 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)));
        continue;
      }
      if (response.status !== (test.status ?? 200)) result.failures.push(`Expected status ${test.status ?? 200}; got ${response.status}`);
      const text = await boundedBody(response);
      let payload;
      if (test.sse) {
        if (!response.headers.get('content-type')?.includes('text/event-stream')) result.failures.push('Expected text/event-stream');
        const events = parseSSE(text);
        if (test.sse.done && events.at(-1) !== '[DONE]') result.failures.push('Missing terminal [DONE]');
        payload = {events: events.filter(x => x !== '[DONE]')};
        if (payload.events.length < (test.sse.minEvents ?? 1)) result.failures.push('Too few SSE data events');
      } else if ((test.checks ?? []).length) payload = JSON.parse(text);
      for (const check of test.checks ?? []) {
        const value = jsonAt(payload, check.path);
        const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        if (check.type && type !== check.type) result.failures.push(`Type mismatch at ${check.path}`);
        if (Object.hasOwn(check, 'equals')) {
          try { assert.deepEqual(value, check.equals); } catch { result.failures.push(`Value mismatch at ${check.path}`); }
        }
      }
      break;
    } catch (error) {
      // Never persist server payloads, URLs, headers or raw error strings.
      result.failures.push(error.name === 'TimeoutError' ? 'Request timed out' : 'Transport or response parsing failed');
      break;
    }
  }
  result.durationMs = Math.round(performance.now() - start);
  if (test.maxMs !== undefined && result.durationMs > test.maxMs) result.failures.push('Latency budget exceeded');
  result.passed = result.failures.length === 0;
  return result;
}

export async function runSuite(cases, concurrency = 3) {
  if (!Array.isArray(cases) || !cases.length) throw Error('Provide at least one case');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw Error('concurrency must be 1..10');
  cases.forEach(validate);
  const results = new Array(cases.length); let next = 0;
  await Promise.all(Array.from({length: Math.min(concurrency, cases.length)}, async () => {
    while (next < cases.length) {
      const index = next++;
      try { results[index] = await runCase(cases[index]); }
      catch { results[index] = {name: cases[index].name, passed: false, attempts: 0, status: null, durationMs: 0, failures: ['Case configuration or credentials invalid']}; }
    }
  }));
  return {formatVersion: 1, total: results.length, passed: results.filter(r => r.passed).length, results};
}

export function reportHTML(report) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>API Contract Lab</title>
  <style>body{font:16px system-ui;background:#0d1728;color:#e5edf9;margin:40px auto;max-width:1080px;padding:20px}h1{font-size:34px}p{color:#b3c4de}table{border-collapse:collapse;width:100%;background:#142238}td,th{text-align:left;padding:14px;border-bottom:1px solid #34435d}.ok{color:#7ee0ae}.bad{color:#ff9f9f}small{color:#b3c4de}</style>
  <h1>API Contract Lab</h1><p>HTTP &amp; SSE integration regression · ${report.passed}/${report.total} cases passed</p>
  <table><tr><th>Contract case</th><th>Result</th><th>HTTP</th><th>Attempts</th><th>Elapsed</th></tr>${report.results.map(r => `<tr><td>${html(r.name)}<br><small>${html(r.failures.join('; '))}</small></td><td class="${r.passed ? 'ok' : 'bad'}">${r.passed ? 'PASS' : 'FAIL'}</td><td>${r.status ?? '—'}</td><td>${r.attempts}</td><td>${r.durationMs} ms</td></tr>`).join('')}</table><p>Local mock demonstration unless explicitly run against your authorized service. Response bodies and credentials are excluded.</p></html>`;
}

async function withMock(callback) {
  let retryCount = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/slow') await pause(90);
    if (req.url === '/retry' && retryCount++ === 0) { res.writeHead(429, {'retry-after': '0'}); return res.end('{}'); }
    if (req.url === '/post429') { res.writeHead(429); return res.end('{}'); }
    if (req.url === '/auth') { res.writeHead(401); return res.end('{"error":{"type":"unauthorized"}}'); }
    if (req.url === '/broken') return res.end('{bad json');
    if (req.url === '/huge') return res.end('x'.repeat(1024 * 1024 + 1));
    if (req.url === '/stream' || req.url === '/truncated') {
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write('data: {"delta":"hello"}\r\n\r\n');
      return res.end(req.url === '/stream' ? 'data: [DONE]\n\n' : '');
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('{"choices":[{"message":{"content":"mock answer"}}],"usage":{"total_tokens":7}}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

function demoCases(base) {
  return [
    {name: 'Chat response contract', url: base + '/json', checks: [{path:'choices.0.message.content',type:'string'},{path:'usage.total_tokens',equals:7}]},
    {name: 'SSE terminal event', url: base + '/stream', sse:{done:true,minEvents:1},checks:[{path:'events.0.delta',equals:'hello'}]},
    {name: 'Authentication error contract', url: base + '/auth', status:401,checks:[{path:'error.type',equals:'unauthorized'}]},
    {name: 'Rate limit recovery', url:base + '/retry',retries:1},
    {name: 'Detect broken JSON (intentional failure)', url:base + '/broken',checks:[{path:'choices',type:'array'}]},
    {name: 'Detect truncated SSE (intentional failure)', url:base + '/truncated',sse:{done:true}},
    {name: 'Timeout detection (intentional failure)',url:base + '/slow',timeoutMs:20}
  ];
}

async function selftest() {
  let passed = 0;
  const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
  await check('SSE CRLF and multi-line data', () => assert.deepEqual(parseSSE('data: {"a":\r\ndata: 1}\r\n\r\ndata: [DONE]\r\n\r\n'), [{a:1}, '[DONE]']));
  await check('Nested arrays and absent paths', () => { assert.equal(jsonAt({a:[{b:2}]},'a.0.b'),2); assert.equal(jsonAt({},'a.b'),undefined); });
  await check('HTML output escapes untrusted names', () => assert.ok(!reportHTML({total:1,passed:0,results:[{name:'<script>',passed:false,status:0,attempts:1,durationMs:0,failures:[]}]}).includes('<script>')));
  await check('Reject non-HTTP destination', () => assert.rejects(runCase({name:'x',url:'file:///tmp/a'})));
  await check('Reject URL credentials', () => assert.rejects(runCase({name:'x',url:'https://user:secret@example.com'})));
  await check('Reject invalid concurrency', () => assert.rejects(runSuite([{name:'x',url:'https://example.com'}],0)));
  await withMock(async base => {
    const suite = await runSuite(demoCases(base), 2);
    for (let i = 0; i < 7; i++) await check(`HTTP fixture ${i + 1}`, () => assert.equal(suite.results[i].passed, i < 4));
    await check('Retry attempt is observable', () => assert.equal(suite.results[3].attempts,2));
    await check('Missing secret is a failed case, no leak', async () => { const r=await runSuite([{name:'x',url:base,headerEnv:{Authorization:'UNSET_CONTRACT_LAB_KEY'}}]); assert.equal(r.passed,0); });
    await check('POST is not retried implicitly', async () => { const r=await runCase({name:'post',url:base+'/post429',method:'POST',body:{},retries:2}); assert.equal(r.attempts,1); assert.equal(r.passed,false); });
    await check('Reject oversized response', async () => assert.equal((await runCase({name:'size',url:base+'/huge'})).passed,false));
    await check('Reports omit header secret and response content', async () => { const r=await runCase({name:'x',url:base,headers:{Authorization:'private-secret'}}); assert.ok(!JSON.stringify(r).includes('private-secret')); assert.ok(!JSON.stringify(r).includes('mock answer')); });
  });
  console.log(`${passed} tests passed`);
}

async function main() {
  const [mode, input, out = 'contract-report'] = process.argv.slice(2);
  if (mode === '--selftest') return selftest();
  let report;
  if (mode === '--demo') report = await withMock(base => runSuite(demoCases(base),2));
  else if (mode === '--run' && input) {
    const config = JSON.parse(await readFile(input, 'utf8'));
    report = await runSuite(config.cases, config.concurrency ?? 3);
  } else throw Error('Usage: node api-contract-lab.mjs --selftest | --demo [unused] [output-prefix] | --run suite.json [output-prefix]');
  await mkdir(new URL('.', pathToFileURL(`${out}.json`)), {recursive:true});
  await writeFile(`${out}.json`, JSON.stringify(report,null,2));
  await writeFile(`${out}.html`, reportHTML(report));
  console.log(`${report.passed}/${report.total} contracts passed. Reports: ${out}.html and ${out}.json`);
  if (mode !== '--demo' && report.passed !== report.total) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Contract Lab failed. Check configuration, credentials and file paths.'); process.exitCode=1; });
