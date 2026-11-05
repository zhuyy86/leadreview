// Retry-After is a minimum wait, independent of the exponential backoff cap.
const httpDate = /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;

function retryAfterMs(value, now) {
  if (typeof value !== 'string') return 0;
  value = value.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!httpDate.test(value)) return 0;
  // The obsolete asctime form has no zone but HTTP defines it as UTC.
  const date = Date.parse(value.endsWith('GMT') ? value : value + ' GMT');
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export function retryDecision(job, { httpStatus, retryAfter, error }, {
  now = Date.now(), baseDelayMs = 500, maxBackoffMs = 10_000,
  maxRetryAfterMs = 86_400_000, random = Math.random
} = {}) {
  if (httpStatus >= 200 && httpStatus < 300) return { outcome: 'delivered', httpStatus };
  const retryable = httpStatus === undefined || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
  if (!retryable || job.number >= job.max_attempts) return { outcome: 'dead', httpStatus, error };
  const minimumWait = retryAfterMs(retryAfter, now);
  if (minimumWait > maxRetryAfterMs) {
    return {
      outcome: 'dead', httpStatus,
      error: 'Retry-After exceeds the automatic retry limit; operator review is required.'
    };
  }
  const ceiling = Math.min(maxBackoffMs, baseDelayMs * 2 ** Math.min(job.number - 1, 30));
  const jitteredBackoff = Math.floor(ceiling * (0.5 + random() * 0.5));
  return { outcome: 'retry', nextAt: now + Math.max(jitteredBackoff, minimumWait), httpStatus, error };
}
