import { createHmac, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { retryDecision } from './retry.mjs';

function signature(secret, id, timestamp, body) {
  return createHmac('sha256', secret).update(id + '.' + timestamp + '.').update(body).digest();
}

export function sign(secret, id, body, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': 'v1,' + signature(secret, id, timestamp, body).toString('base64')
  };
}

export function verify(secret, headers, body, now = Date.now()) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signed = headers['webhook-signature'];
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) ||
      typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp) ||
      typeof signed !== 'string' || !/^v1,[A-Za-z0-9+/]{43}=$/.test(signed)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300) return false;
  return timingSafeEqual(Buffer.from(signed.slice(3), 'base64'), signature(secret, id, timestamp, body));
}

async function send(job, { receiverUrl, secret, timeoutMs, baseDelayMs }) {
  const body = JSON.stringify({
    id: job.event_id,
    type: job.type,
    created_at: job.created_at,
    payload: JSON.parse(job.payload)
  });
  let httpStatus;
  let retryAfter;
  let error;
  try {
    const response = await fetch(receiverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sign(secret, job.id, body) },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
    httpStatus = response.status;
    retryAfter = response.headers.get('retry-after');
    await response.body?.cancel().catch(() => {});
    if (!response.ok) error = 'Receiver returned HTTP ' + httpStatus;
  } catch (cause) {
    error = cause.name === 'TimeoutError' ? 'Receiver timed out' : 'Receiver connection failed';
  }
  return retryDecision(job, { httpStatus, retryAfter, error }, { baseDelayMs });
}

export function runWorker(store, options) {
  let stopping = false;
  const done = (async () => {
    while (!stopping) {
      try {
        const job = store.claim();
        if (job) {
          store.finish(job, await send(job, options));
          continue;
        }
      } catch (error) {
        console.error('Worker will retry polling:', error.message);
      }
      await delay(60);
    }
  })();
  return async () => {
    stopping = true;
    await done;
  };
}
