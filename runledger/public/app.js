const select = selector => document.querySelector(selector);
const modes = {
  healthy: { label: 'Healthy', color: 'mint', description: 'Accepts signed webhook requests.' },
  transient: { label: 'Transient', color: 'amber', description: 'Returns HTTP 503 on the first request for each delivery.' },
  down: { label: 'Down', color: 'rose', description: 'Returns HTTP 503 for every attempt.' },
};
const statuses = {
  queued: ['Queued', 'amber'], in_flight: ['In flight', 'lavender'],
  delivered: ['Delivered', 'mint'], dead: ['Dead letter', 'rose'],
  retry: ['Retry scheduled', 'amber'], lease_expired: ['Lease expired', 'amber'],
};
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fullClock = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const number = new Intl.NumberFormat();
const modeButtons = [...document.querySelectorAll('[data-mode]')];
const filterButtons = [...document.querySelectorAll('[data-filter]')];
const metricValues = [...document.querySelectorAll('[data-metric]')];
const rows = select('#rows');
const detail = select('#detail');
const detailEmpty = select('#detail-empty');
const connection = select('#connection');
const receiverMode = select('#receiver-mode');
const seedButton = select('#seed');
const notice = select('#notice');

let overview;
let online = false;
let busy = false;
let selectedId;
let filter = 'all';
let overviewRequest = 0;
let detailRequest = 0;
let tableSignature;
let detailSignature;
let noticeTimer;
let pageCursors = [null];
let loading = false;
let searchTimer;
const replaySelection = new Map();
let pendingReplay = readSavedReplay();

function readSavedReplay() {
  try {
    const value = JSON.parse(sessionStorage.getItem('runledger.pendingReplay'));
    if (value && typeof value.operation_key === 'string' && Array.isArray(value.deliveries) &&
        value.deliveries.length >= 1 && value.deliveries.length <= 50 && value.deliveries.every(item =>
          /^[0-9a-f-]{36}$/.test(item.id) && Number.isSafeInteger(item.generation) && item.generation > 0)) return value;
  } catch { /* The server still validates every replay request. */ }
}

function savePendingReplay() {
  try {
    if (pendingReplay) sessionStorage.setItem('runledger.pendingReplay', JSON.stringify(pendingReplay));
    else sessionStorage.removeItem('runledger.pendingReplay');
  } catch { /* Keep the active request in memory when browser storage is unavailable. */ }
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = String(value);
  return node;
}

function pill(status) {
  const [label, color] = statuses[status] ?? [status || 'Unknown', 'neutral'];
  const node = element('span', `status-pill ${color}`);
  node.append(element('span', 'dot'), ` ${label}`);
  return node;
}

function time(value, formatter = clock) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return element('span', null, '—');
  const date = new Date(value);
  const node = element('time', null, formatter.format(date));
  node.dateTime = date.toISOString();
  node.title = fullClock.format(date);
  return node;
}

function updateControls() {
  seedButton.disabled = !online || busy;
  select('#dispatch-toggle').disabled = !online || busy || !overview?.dispatch;
  select('#bulk-replay').disabled = !online || busy || !(pendingReplay || replaySelection.size);
  select('#bulk-replay').textContent = pendingReplay ? 'Retry replay request' : 'Replay selected';
  select('#clear-selection').disabled = busy || Boolean(pendingReplay) || replaySelection.size === 0;
  select('#select-dead-page').disabled = !online || busy || Boolean(pendingReplay) || !overview?.deliveries.some(d => d.status === 'dead');
  select('#selection-count').textContent = pendingReplay ? 'Saved replay request ready for retry' : `${replaySelection.size} selected · 50 per operation`;
  for (const input of rows.querySelectorAll('input[data-replay]')) input.disabled = busy || Boolean(pendingReplay);
  for (const button of modeButtons) button.disabled = !online || busy;
  const replayButton = select('#replay');
  if (replayButton) replayButton.disabled = !online || busy || Boolean(pendingReplay);
  select('#previous-page').disabled = !online || busy || loading || pageCursors.length === 1;
  select('#next-page').disabled = !online || busy || loading || !overview?.page.has_more;
  select('#newest-page').disabled = !online || busy || loading;
  rows.setAttribute('aria-busy', loading);
}

function setConnection(value) {
  online = value;
  connection.className = `connection ${value ? 'online' : 'offline'}`;
  connection.replaceChildren(element('span', 'dot'), value ? ' Connected' : ' Reconnecting');
  updateControls();
}

function showNotice(message, isError = false) {
  clearTimeout(noticeTimer);
  notice.hidden = false;
  notice.classList.toggle('error', isError);
  notice.textContent = message;
  if (!isError) noticeTimer = setTimeout(() => { notice.hidden = true; }, 4000);
}

async function request(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    signal: AbortSignal.timeout(5500),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `Request failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function renderOverview() {
  for (const value of metricValues) value.textContent = number.format(overview.stats[value.dataset.metric] ?? 0);
  const health = overview.queue_health;
  select('#due-now').textContent = number.format(health.due_now);
  select('#scheduled').textContent = number.format(health.scheduled);
  select('#oldest-due').textContent = `${(health.oldest_due_age_ms / 1000).toFixed(1)}s`;
  select('#expired-leases').textContent = number.format(health.expired_leases);
  select('#expired-leases').classList.toggle('warning', health.expired_leases > 0);
  const paused = overview.dispatch.paused;
  select('#dispatch-state').textContent = paused ? 'Dispatch paused' : 'Dispatch running';
  select('#dispatch-hint').textContent = paused
    ? 'Events continue to queue. Resume when the receiver is ready.'
    : 'Workers claim due events. Current requests finish when dispatch pauses.';
  select('#dispatch-toggle').textContent = paused ? 'Resume dispatch' : 'Pause dispatch';
  const current = modes[overview.receiver.mode];
  receiverMode.className = `status-pill ${current.color}`;
  receiverMode.replaceChildren(element('span', 'dot'), ` ${current.label}`);
  select('#mode-hint').textContent = current.description;
  select('#receiver-processed').textContent = number.format(overview.receiver.processed);
  select('#receiver-duplicates').textContent = number.format(overview.receiver.duplicates);
  for (const button of modeButtons) button.setAttribute('aria-pressed', button.dataset.mode === overview.receiver.mode);
  renderTable();
}

function renderTable() {
  if (!overview) return;
  const visible = overview.deliveries;
  for (const delivery of visible) {
    if (replaySelection.has(delivery.id) &&
        (delivery.status !== 'dead' || replaySelection.get(delivery.id) !== delivery.generation)) replaySelection.delete(delivery.id);
  }
  const signature = JSON.stringify([visible, selectedId, [...replaySelection]]);
  if (signature !== tableSignature) {
    const focusedId = document.activeElement?.closest('tr[data-delivery]')?.dataset.delivery;
    const focusSelection = document.activeElement?.matches('input[data-replay]');
    rows.replaceChildren(...visible.map(renderRow));
    if (focusedId) {
      const focusedRow = [...rows.children].find(row => row.dataset.delivery === focusedId);
      focusedRow?.querySelector(focusSelection ? 'input' : 'button')?.focus({ preventScroll: true });
    }
    tableSignature = signature;
  }
  select('#empty').hidden = visible.length > 0;
  const total = Object.values(overview.stats).reduce((sum, count) => sum + count, 0);
  select('#empty-title').textContent = total ? 'No matching deliveries on this page' : 'No events yet';
  select('#empty-hint').textContent = total ? 'Change the filter, search another event or return to newest.' : 'Emit an AI completion event to create a delivery.';
  select('#ledger-count').textContent = `${number.format(visible.length)} shown · ${number.format(overview.page.matching)} matching · Page ${pageCursors.length}`;
  updateControls();
}

function renderRow(delivery) {
  const row = element('tr', delivery.id === selectedId ? 'selected' : '');
  row.dataset.delivery = delivery.id;
  const event = element('button', 'event-button');
  event.type = 'button';
  event.setAttribute('aria-pressed', delivery.id === selectedId);
  event.title = `${delivery.type} · ${delivery.event_id}`;
  event.append(element('strong', null, delivery.type), element('span', null, delivery.event_id));
  const eventCell = element('td');
  eventCell.append(event);
  const statusCell = element('td');
  statusCell.append(pill(delivery.status));
  const attemptsCell = element('td', 'num', `${delivery.attempt_count} / ${delivery.max_attempts}`);
  if (delivery.generation > 1) attemptsCell.append(element('span', 'row-generation', `Gen ${delivery.generation}`));
  const createdCell = element('td');
  createdCell.append(time(delivery.created_at));
  const selectionCell = element('td', 'selection-cell');
  if (delivery.status === 'dead') {
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.replay = delivery.id;
    checkbox.setAttribute('aria-label', 'Select ' + delivery.event_id);
    checkbox.checked = replaySelection.has(delivery.id);
    checkbox.disabled = busy || Boolean(pendingReplay);
    selectionCell.append(checkbox);
  }
  row.append(selectionCell, eventCell, statusCell, attemptsCell, createdCell);
  return row;
}

function renderAttempt(attempt) {
  const line = element('div', 'attempt-line');
  line.append(element('strong', 'attempt-title', `Gen ${attempt.generation} · Attempt ${attempt.number}`), pill(attempt.outcome));
  const meta = element('p', 'attempt-meta');
  meta.append(time(attempt.started_at));
  if (attempt.http_status != null) meta.append(` · HTTP ${attempt.http_status}`);
  if (attempt.finished_at != null) meta.append(` · ${Math.max(0, attempt.finished_at - attempt.started_at)} ms`);
  const item = element('li', 'attempt');
  item.append(line, meta);
  if (attempt.error) item.append(element('p', 'attempt-error', attempt.error));
  return item;
}

function renderDetail({ delivery, attempts }) {
  const payloadOpen = Boolean(detail.querySelector('.payload[open]'));
  const heading = element('div', 'detail-top');
  heading.append(element('h3', 'detail-type', delivery.type), pill(delivery.status));
  const id = element('p', 'detail-id', `Event ${delivery.event_id}`);
  const meta = element('div', 'detail-meta');
  const generation = element('span', null, 'Generation ');
  generation.append(element('b', null, delivery.generation));
  const budget = element('span', null, 'Attempts ');
  budget.append(element('b', null, `${delivery.attempt_count} / ${delivery.max_attempts}`));
  meta.append(generation, budget);
  if (delivery.status === 'queued' && delivery.next_at != null) {
    const next = element('span', null, 'Next attempt ');
    next.append(time(delivery.next_at));
    meta.append(next);
  }
  detail.replaceChildren(heading, id, meta);
  if (delivery.last_error && delivery.status !== 'delivered') {
    detail.append(element('p', 'last-error', delivery.last_error));
  }
  if (delivery.status === 'dead') {
    const replay = element('button', 'button secondary', 'Replay delivery');
    replay.id = 'replay';
    replay.type = 'button';
    replay.disabled = busy || !online || Boolean(pendingReplay);
    replay.addEventListener('click', () => replayBatch([{ id: delivery.id, generation: delivery.generation }]));
    detail.append(replay);
  }
  detail.append(element('h3', 'attempt-heading', 'ATTEMPT HISTORY'));
  if (attempts.length) {
    const list = element('ol', 'attempts');
    list.append(...attempts.map(renderAttempt));
    detail.append(list);
  } else {
    detail.append(element('p', 'no-attempts', 'Waiting for a worker to claim this delivery.'));
  }
  const payload = element('details', 'payload');
  payload.open = payloadOpen;
  payload.append(element('summary', null, 'Inspect event payload'), element('pre', null, JSON.stringify(delivery.payload, null, 2)));
  detail.append(payload);
  detailEmpty.hidden = true;
  detail.hidden = false;
}

async function loadDetail() {
  if (!selectedId) return;
  const id = selectedId;
  const current = ++detailRequest;
  try {
    const data = await request(`/api/deliveries/${encodeURIComponent(id)}`);
    if (current !== detailRequest || id !== selectedId) return;
    const signature = JSON.stringify(data);
    if (signature !== detailSignature) {
      renderDetail(data);
      detailSignature = signature;
    }
  } catch (error) {
    if (current !== detailRequest || id !== selectedId) return;
    if (detailSignature) return;
    detail.replaceChildren(element('p', 'last-error', error.message || 'Could not load this delivery.'));
    detailEmpty.hidden = true;
    detail.hidden = false;
  }
}

function choose(id) {
  if (id === selectedId) return;
  selectedId = id;
  detailSignature = undefined;
  detail.replaceChildren(element('p', 'no-attempts', 'Loading attempt history…'));
  detailEmpty.hidden = true;
  detail.hidden = false;
  renderTable();
}

async function refresh() {
  const current = ++overviewRequest;
  loading = true;
  updateControls();
  try {
    const params = new URLSearchParams({ status: filter, q: select('#search').value.trim(), limit: '25' });
    if (pageCursors.at(-1)) params.set('cursor', pageCursors.at(-1));
    const data = await request('/api/overview?' + params);
    if (current !== overviewRequest) return;
    overview = data;
    setConnection(true);
    renderOverview();
    if (!selectedId && overview.deliveries.length) choose(overview.deliveries[0].id);
    await loadDetail();
  } catch (error) {
    if (current === overviewRequest) {
      setConnection(false);
      showNotice(error.message || 'Could not refresh deliveries.', true);
    }
  } finally {
    if (current === overviewRequest) {
      loading = false;
      updateControls();
    }
  }
}

function resetPages() {
  pageCursors = [null];
  ++overviewRequest;
  loading = true;
  updateControls();
}

async function mutate(path, body, onSuccess) {
  if (busy || !online) return;
  busy = true;
  ++overviewRequest;
  ++detailRequest;
  updateControls();
  try {
    const result = await request(path, 'POST', body);
    showNotice(onSuccess(result));
  } catch (error) {
    showNotice(error.message || 'The action could not be completed. Try again.', true);
  } finally {
    await refresh();
    busy = false;
    updateControls();
  }
}

async function replayBatch(targets) {
  if (busy || !online) return;
  pendingReplay ??= { operation_key: crypto.randomUUID(), deliveries: targets };
  savePendingReplay();
  busy = true;
  ++overviewRequest;
  ++detailRequest;
  updateControls();
  try {
    const result = await request('/api/replays', 'POST', pendingReplay);
    pendingReplay = undefined;
    savePendingReplay();
    replaySelection.clear();
    showNotice(`${result.replayed_count} replay(s) queued. Operation ${result.action_id}.`);
    if (select('#operator-audit').open) await loadActions();
  } catch (error) {
    if (error.status >= 400 && error.status < 500) {
      pendingReplay = undefined;
      savePendingReplay();
      replaySelection.clear();
      showNotice(error.message, true);
    } else {
      showNotice('Replay request saved for retry. Use Retry replay request to read its recorded result.', true);
    }
  } finally {
    await refresh();
    busy = false;
    updateControls();
  }
}

select('#bulk-replay').addEventListener('click', () => replayBatch(
  [...replaySelection].map(([id, generation]) => ({ id, generation }))));
select('#clear-selection').addEventListener('click', () => {
  if (pendingReplay || busy) return;
  replaySelection.clear();
  renderTable();
});
select('#select-dead-page').addEventListener('click', () => {
  if (pendingReplay || busy) return;
  for (const d of overview.deliveries) {
    if (d.status === 'dead' && replaySelection.size < 50) replaySelection.set(d.id, d.generation);
  }
  renderTable();
});
rows.addEventListener('change', event => {
  const id = event.target.dataset.replay;
  if (!id || busy || pendingReplay) return;
  if (event.target.checked) {
    if (replaySelection.size === 50) {
      event.target.checked = false;
      showNotice('Select up to 50 dead letters per operation.', true);
      return;
    }
    replaySelection.set(id, overview.deliveries.find(d => d.id === id).generation);
  } else replaySelection.delete(id);
  renderTable();
});

async function loadActions() {
  const button = select('#actions-refresh');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const data = await request('/api/actions?limit=10');
    select('#action-rows').replaceChildren(...data.actions.map(action => {
      const row = element('li');
      row.append(`${action.replayed_count} replay(s) · `, time(action.created_at, fullClock),
        element('code', null, action.id));
      return row;
    }));
    if (!data.actions.length) select('#action-rows').append(element('li', null, 'Replay operations appear here.'));
  } catch (error) {
    select('#action-rows').replaceChildren(element('li', null, error.message));
  } finally { button.disabled = false; }
}
select('#operator-audit').addEventListener('toggle', event => {
  if (event.currentTarget.open) void loadActions();
});
select('#actions-refresh').addEventListener('click', loadActions);

for (const button of modeButtons) {
  button.addEventListener('click', () => {
    const { mode } = button.dataset;
    if (mode === overview?.receiver.mode) return;
    void mutate('/api/demo/receiver', { mode }, () => `Receiver mode set to ${modes[mode].label.toLowerCase()}.`);
  });
}

seedButton.addEventListener('click', () => mutate('/api/demo/seed', undefined, result => {
  choose(result.delivery_id);
  return 'AI completion event queued. Watch its attempts in the timeline.';
}));

select('#dispatch-toggle').addEventListener('click', () => {
  const paused = !overview.dispatch.paused;
  void mutate('/api/dispatch', { paused, expected_revision: overview.dispatch.revision },
    () => paused ? 'Dispatch paused. Incoming events remain queued.' : 'Dispatch resumed. Workers can claim due events.');
});

for (const button of filterButtons) {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    for (const item of filterButtons) item.setAttribute('aria-pressed', item === button);
    clearTimeout(searchTimer);
    searchTimer = undefined;
    resetPages();
    void refresh();
  });
}

select('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  resetPages();
  searchTimer = setTimeout(() => {
    searchTimer = undefined;
    void refresh();
  }, 250);
});
select('#next-page').addEventListener('click', () => {
  if (loading || !overview?.page.next_cursor) return;
  pageCursors.push(overview.page.next_cursor);
  void refresh();
});
select('#previous-page').addEventListener('click', () => {
  if (loading || pageCursors.length === 1) return;
  pageCursors.pop();
  void refresh();
});
select('#newest-page').addEventListener('click', () => {
  resetPages();
  void refresh();
});
rows.addEventListener('click', event => {
  if (event.target.closest('input[data-replay]')) return;
  const row = event.target.closest('tr[data-delivery]');
  if (!row) return;
  choose(row.dataset.delivery);
  void loadDetail();
});

async function poll() {
  if (!busy && !loading && !searchTimer) await refresh();
  setTimeout(poll, 1000);
}

async function loadLatency() {
  const button = select('#latency-refresh');
  if (button.disabled) return;
  button.disabled = true;
  select('#latency-status').textContent = 'Measuring ledger history…';
  try {
    const data = await request('/api/metrics');
    const labels = { attempt: 'Completed attempts', event_to_delivery: 'Event to delivery', generation_to_delivery: 'Generation to delivery' };
    select('#latency-rows').replaceChildren(...Object.entries(labels).map(([key, label]) => {
      const metric = data.latency[key];
      const row = element('div', 'latency-row');
      const values = ['p50_ms', 'p95_ms', 'p99_ms'].map(name => metric[name] === null ? '—' : number.format(metric[name]));
      row.append(element('strong', null, label), element('span', null,
        `${values.join(' / ')} ms · ${number.format(metric.sample_count)} samples · ${number.format(metric.invalid_sample_count)} invalid`));
      return row;
    }));
    select('#latency-status').textContent = 'Observed ' + fullClock.format(new Date(data.observed_at));
  } catch (error) {
    select('#latency-status').textContent = error.message || 'Measurements unavailable. Try again.';
  } finally {
    button.disabled = false;
  }
}

select('#latency-summary').addEventListener('toggle', event => {
  if (event.currentTarget.open) void loadLatency();
});
select('#latency-refresh').addEventListener('click', loadLatency);

function renderHistoryHealth(health, updateStatus = true) {
  const cache = health.cache;
  select('#history-health').textContent = health.enabled
    ? `${number.format(health.archives_configured)} signed archives · ${number.format(cache.entries)}/${number.format(cache.max_entries)} cached · ${number.format(cache.hits)} hits · ${number.format(cache.misses)} misses · ${number.format(cache.invalidations)} invalidations · ${number.format(cache.expirations)} expirations`
    : 'Archive lookup is ready for configuration through the service environment.';
  select('#history-id').disabled = !health.enabled;
  select('#history-search').disabled = !health.enabled;
  if (updateStatus) {
    select('#history-status').textContent = health.enabled
      ? `${number.format(health.totals.successes)} successful lookups · ${number.format(health.totals.failures)} failed verifications`
      : 'Configure signed archive pairs and their verification key to search retained history.';
  }
}

async function loadHistoryHealth(updateStatus = true) {
  try {
    const data = await request('/api/metrics');
    renderHistoryHealth(data.history_lookup, updateStatus);
  } catch (error) {
    select('#history-status').textContent = error.message || 'History health is unavailable.';
  }
}

async function searchHistory() {
  const input = select('#history-id');
  const button = select('#history-search');
  const query = input.value.trim();
  if (!query || button.disabled) return;
  button.disabled = true;
  select('#history-status').textContent = 'Authenticating archives and searching exact identities…';
  select('#history-results').replaceChildren();
  try {
    const data = await request('/api/history?id=' + encodeURIComponent(query));
    select('#history-results').replaceChildren(...data.matches.map(match => {
      const item = element('li');
      item.append(element('strong', null, match.delivery_id),
        ` · ${match.type} · ${match.status} · ${number.format(match.locations.length)} locations`);
      return item;
    }));
    const resultStatus = data.matches.length
      ? `${number.format(data.matches.length)} exact match${data.matches.length === 1 ? '' : 'es'} · ${number.format(data.archives_verified)} archives verified`
      : `${number.format(data.archives_verified)} archives verified · No exact match`;
    await loadHistoryHealth(false);
    select('#history-status').textContent = resultStatus;
  } catch (error) {
    select('#history-status').textContent = error.message || 'History lookup failed.';
  } finally {
    button.disabled = false;
  }
}

select('#history-summary').addEventListener('toggle', event => {
  if (event.currentTarget.open) void loadHistoryHealth();
});
select('#history-search').addEventListener('click', searchHistory);
select('#history-id').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); void searchHistory(); }
});

void poll();
