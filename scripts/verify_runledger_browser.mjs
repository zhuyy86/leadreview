import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startApp } from '../runledger/server.mjs';
import { runWorker } from '../runledger/worker.mjs';

test('Browser finds an old dead letter, pages the ledger, rejects stale results and replays', { timeout: 30_000 }, async () => {
  const secret = Buffer.from('browser-test-only-secret');
  const app = await startApp({ databasePath: ':memory:', port: 0, workerCount: 0, secret });
  let browser;
  let stopWorker;
  try {
    const fixtureTime = Date.now() - 180_000;
    const old = app.store.ingest({ key: 'old-dead', type: 'old.failed', payload: { run: 'old' } }, fixtureTime);
    app.store.finish(app.store.claim(fixtureTime), { outcome: 'dead', httpStatus: 400, error: 'Injected failure' }, fixtureTime + 1);
    for (let i = 1; i <= 130; i++) {
      app.store.ingest({ key: 'browser-' + i, type: 'ai.run.completed', payload: { index: i } }, fixtureTime + 1000 + i);
    }
    browser = await chromium.launch({
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(app.url);
    async function count(text) {
      await page.waitForFunction(value => document.querySelector('#ledger-count').textContent.split(' · ').includes(value), text);
      await page.waitForFunction(() => document.querySelector('#rows').getAttribute('aria-busy') === 'false');
    }
    async function ids() {
      return page.locator('#rows tr').evaluateAll(rows => rows.map(row => row.dataset.delivery));
    }
    await count('131 matching');
    await page.locator('#dispatch-toggle').click();
    await page.waitForFunction(() => document.querySelector('#dispatch-state').textContent === 'Dispatch paused');
    assert.equal(app.store.dispatchStatus().paused, true);
    await page.reload();
    await count('131 matching');
    assert.equal(await page.locator('#dispatch-state').textContent(), 'Dispatch paused');
    const firstPage = await ids();
    assert.equal(firstPage.length, 25);
    await page.locator('#next-page').click();
    await count('Page 2');
    assert.equal(new Set([...firstPage, ...await ids()]).size, 50);
    await page.locator('#previous-page').click();
    await count('Page 1');
    assert.deepEqual(await ids(), firstPage);

    await page.locator('[data-filter="dead"]').click();
    await count('1 matching');
    assert.deepEqual(await ids(), [old.delivery_id]);
    await page.locator('[data-filter="all"]').click();
    await page.locator('#search').fill(old.event_id);
    await count('1 matching');
    assert.deepEqual(await ids(), [old.delivery_id]);

    // Hold an older successful response until a newer search has rendered.
    let releaseOld;
    let markHeld;
    const held = new Promise(resolve => { markHeld = resolve; });
    const release = new Promise(resolve => { releaseOld = resolve; });
    await page.route('**/api/overview?**', async route => {
      const query = new URL(route.request().url()).searchParams.get('q');
      if (query !== 'stale-query') return route.continue();
      const response = await route.fetch();
      markHeld();
      await release;
      await route.fulfill({ response });
    });
    await page.locator('#search').fill('stale-query');
    await held;
    await page.locator('#search').fill(old.event_id);
    await count('1 matching');
    const deliveredOldResponse = page.waitForResponse(response => response.url().includes('q=stale-query'));
    releaseOld();
    await deliveredOldResponse;
    assert.deepEqual(await ids(), [old.delivery_id]);

    await page.locator('#rows .event-button').click();
    await page.locator('#replay').waitFor();
    stopWorker = runWorker(app.store, {
      receiverUrl: app.url + '/demo/receiver', secret, timeoutMs: 500, baseDelayMs: 20
    });
    await page.locator('#replay').click();
    await page.waitForFunction(() => document.querySelector('#detail .status-pill')?.textContent.includes('Queued'));
    assert.equal(app.store.detail(old.delivery_id).delivery.attempt_count, 0);
    await page.locator('#dispatch-toggle').click();
    await page.waitForFunction(() => document.querySelector('#dispatch-state').textContent === 'Dispatch running');
    await page.waitForFunction(() => document.querySelector('#detail .status-pill')?.textContent.includes('Delivered'));
    assert.equal(app.store.detail(old.delivery_id).delivery.generation, 2);
    assert.deepEqual(app.store.detail(old.delivery_id).attempts.map(row => row.outcome), ['delivered', 'dead']);
    await page.locator('#search').fill('no-such-event');
    await count('0 matching');
    assert.equal(await page.locator('#empty').isVisible(), true);
    assert.equal(await page.locator('#next-page').isDisabled(), true);
    await page.locator('#search').fill('');
    await count('131 matching');

    await page.locator('#latency-summary > summary').click();
    await page.waitForFunction(() => document.querySelector('#latency-status').textContent.startsWith('Observed '));
    assert.equal(await page.locator('#latency-rows .latency-row').count(), 3);
    assert.match(await page.locator('#latency-rows').textContent(), /131 samples/);
    await page.locator('#latency-refresh').click();
    await page.waitForFunction(() => !document.querySelector('#latency-refresh').disabled);

    if (process.env.RUNLEDGER_SCREENSHOT) {
      const path = resolve(process.env.RUNLEDGER_SCREENSHOT);
      await mkdir(dirname(path), { recursive: true });
      await page.screenshot({ path, fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('#next-page').isVisible(), true);
    assert.equal(await page.locator('#dispatch-toggle').isVisible(), true);
    assert.equal(await page.locator('#due-now').textContent(), '0');
    if (process.env.RUNLEDGER_MOBILE_SCREENSHOT) {
      const path = resolve(process.env.RUNLEDGER_MOBILE_SCREENSHOT);
      await mkdir(dirname(path), { recursive: true });
      await page.screenshot({ path, fullPage: true });
    }
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (stopWorker) await stopWorker();
    await app.close();
  }
});

test('Browser recovers a lost batch-replay acknowledgment through its saved operation key', { timeout: 30_000 }, async () => {
  const app = await startApp({ databasePath: ':memory:', port: 0, workerCount: 0 });
  let browser;
  try {
    app.store.setDispatch({ paused: true, expected_revision: 0 });
    const targets = [];
    // Build the dead-letter fixture under running dispatch, then pause it.
    app.store.setDispatch({ paused: false, expected_revision: 1 });
    for (let i = 0; i < 2; i++) {
      const item = app.store.ingest({ key: 'batch-' + i, type: 'batch.failed', payload: { i } }, 100);
      app.store.finish(app.store.claim(100), { outcome: 'dead', httpStatus: 503 }, 101);
      targets.push(item.delivery_id);
    }
    app.store.setDispatch({ paused: true, expected_revision: 2 });
    browser = await chromium.launch({
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}), headless: true
    });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let loseAcknowledgment = true;
    const requestKeys = [];
    await page.route('**/api/replays', async route => {
      requestKeys.push(route.request().postDataJSON().operation_key);
      if (!loseAcknowledgment) return route.continue();
      loseAcknowledgment = false;
      const response = await route.fetch();
      assert.equal(response.status(), 202);
      await route.abort('failed');
    });
    await page.goto(app.url);
    await page.waitForFunction(() => document.querySelector('#rows input[data-replay]'));
    await page.locator('#select-dead-page').click();
    assert.match(await page.locator('#selection-count').textContent(), /^2 selected/);
    await page.locator('#bulk-replay').click();
    await page.waitForFunction(() => document.querySelector('#bulk-replay').textContent === 'Retry replay request'
      && !document.querySelector('#bulk-replay').disabled);
    assert.equal(app.store.operatorActions().length, 1);
    for (const id of targets) assert.equal(app.store.detail(id).delivery.generation, 2);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#bulk-replay').textContent === 'Retry replay request'
      && !document.querySelector('#bulk-replay').disabled);
    await page.locator('#bulk-replay').click();
    await page.waitForFunction(() => document.querySelector('#bulk-replay').textContent === 'Replay selected'
      && document.querySelector('#bulk-replay').disabled);
    assert.equal(requestKeys.length, 2);
    assert.equal(requestKeys[0], requestKeys[1]);
    assert.equal(app.store.operatorActions().length, 1);
    assert.equal(app.store.metrics().deliveries.queued, 2);
    await page.locator('#operator-audit > summary').click();
    await page.waitForFunction(() => document.querySelector('#action-rows').textContent.includes('2 replay(s)'));
    assert.equal(await page.locator('#action-rows code').textContent(), app.store.operatorActions()[0].id);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await app.close();
  }
});
