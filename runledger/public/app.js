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
  for (const button of modeButtons) button.disabled = !online || busy;
  const replayButton = select('#replay');
  if (replayButton) replayButton.disabled = !online || busy;
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
  if (!response.ok) throw new Error(data.error || `Request failed with HTTP ${response.status}.`);
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
  const signature = JSON.stringify([visible, selectedId]);
  if (signature !== tableSignature) {
    const focusedId = document.activeElement?.closest('tr[data-delivery]')?.dataset.delivery;
    rows.replaceChildren(...visible.map(renderRow));
    if (focusedId) {
      const focusedRow = [...rows.children].find(row => row.dataset.delivery === focusedId);
      focusedRow?.querySelector('button').focus({ preventScroll: true });
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
  row.append(eventCell, statusCell, attemptsCell, createdCell);
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
    replay.disabled = busy || !online;
    replay.addEventListener('click', () => mutate(
      `/api/deliveries/${encodeURIComponent(delivery.id)}/replay`, undefined,
      () => 'Replay queued. Previous attempts remain in the timeline.',
    ));
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
  const row = event.target.closest('tr[data-delivery]');
  if (!row) return;
  choose(row.dataset.delivery);
  void loadDetail();
});

async function poll() {
  if (!busy && !loading && !searchTimer) await refresh();
  setTimeout(poll, 1000);
}

void poll();
