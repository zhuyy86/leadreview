import { createArchiveVerificationCache, locateHistory } from './maintenance.mjs';

const latencyBuckets = Object.freeze([10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000]);

const emptyCache = () => ({
  max_entries: 0, ttl_ms: 0, entries: 0, hits: 0, misses: 0, coalesced: 0,
  invalidations: 0, expirations: 0, evictions: 0
});

export function createHistoryLookupService({
  source, archives = [], secretFile,
  cacheMaxEntries = Math.max(1, archives.length), cacheTtlMs = 60_000,
  clock = Date.now, durationClock = () => performance.now(), lookupHistory = locateHistory,
  latencyWindowSize = 256, latencyWarningMs = 250, latencyCriticalMs = 1000,
  latencyMinimumSamples = 5
}) {
  if (typeof source !== 'string' || !source || !Array.isArray(archives) || archives.length > 20 ||
      archives.some(item => !item || typeof item.artifact !== 'string' || !item.artifact ||
        typeof item.manifest !== 'string' || !item.manifest) || typeof clock !== 'function' ||
      typeof durationClock !== 'function' || typeof lookupHistory !== 'function' ||
      (archives.length > 0 && (typeof secretFile !== 'string' || !secretFile)) ||
      (archives.length === 0 && secretFile !== undefined)) {
    throw new TypeError('History service requires a source and up to 20 archive/manifest pairs with one secret key.');
  }
  if (!Number.isSafeInteger(latencyWindowSize) || latencyWindowSize < 20 || latencyWindowSize > 10_000 ||
      !Number.isSafeInteger(latencyWarningMs) || latencyWarningMs < 1 || latencyWarningMs > 3_600_000 ||
      !Number.isSafeInteger(latencyCriticalMs) || latencyCriticalMs <= latencyWarningMs ||
      latencyCriticalMs > 3_600_000 || !Number.isSafeInteger(latencyMinimumSamples) ||
      latencyMinimumSamples < 1 || latencyMinimumSamples > latencyWindowSize) {
    throw new TypeError('History latency requires a 20-10000 sample window, ordered 1-3600000 ms thresholds and a minimum within the window.');
  }

  const enabled = archives.length > 0;
  const cache = enabled ? createArchiveVerificationCache({ maxEntries: cacheMaxEntries, ttlMs: cacheTtlMs }) : null;
  const totals = { requests: 0, successes: 0, failures: 0, matches: 0,
    hits: 0, misses: 0, coalesced: 0, bypassed: 0 };
  let lastStartedAt = null;
  let lastSucceededAt = null;
  let lastFailedAt = null;
  let lastError = null;
  const latencySamples = [];
  let latencyTotalSamples = 0;

  function timestamp() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('History service clock must return epoch milliseconds.');
    return value;
  }

  function durationTimestamp() {
    const value = durationClock();
    if (!Number.isFinite(value) || value < 0) throw new TypeError('History duration clock must return non-negative milliseconds.');
    return value;
  }

  function observeLatency(started) {
    const elapsed = Math.max(0, durationTimestamp() - started);
    const rounded = Math.round(elapsed * 1000) / 1000;
    latencyTotalSamples++;
    latencySamples.push(rounded);
    if (latencySamples.length > latencyWindowSize) latencySamples.shift();
  }

  function latencyHealth() {
    const sorted = [...latencySamples].sort((a, b) => a - b);
    const count = sorted.length;
    const percentile = value => count ? sorted[Math.ceil(count * value / 100) - 1] : null;
    const p95 = percentile(95);
    const status = count < latencyMinimumSamples ? 'collecting'
      : p95 >= latencyCriticalMs ? 'critical'
        : p95 >= latencyWarningMs ? 'warning' : 'healthy';
    return {
      unit: 'ms', status, status_basis: 'rolling_p95', sample_capacity: latencyWindowSize,
      sample_count: count, total_samples: latencyTotalSamples,
      dropped_samples: latencyTotalSamples - count, minimum_samples: latencyMinimumSamples,
      warning_ms: latencyWarningMs, critical_ms: latencyCriticalMs,
      min_ms: count ? sorted[0] : null,
      mean_ms: count ? Math.round((sorted.reduce((sum, value) => sum + value, 0) / count) * 1000) / 1000 : null,
      max_ms: count ? sorted[count - 1] : null,
      p50_ms: percentile(50), p95_ms: p95, p99_ms: percentile(99),
      histogram: [...latencyBuckets.map(limit => ({ le_ms: limit,
        count: sorted.filter(value => value <= limit).length })),
      { le_ms: null, count }]
    };
  }

  async function lookup(query) {
    if (!enabled) {
      const error = new Error('Signed archive history is not configured.');
      error.code = 'HISTORY_DISABLED';
      throw error;
    }
    const startedAt = timestamp();
    const durationStarted = durationTimestamp();
    totals.requests++;
    lastStartedAt = startedAt;
    try {
      const result = await lookupHistory({ source, archives, secretFile, query,
        verificationCache: cache, now: startedAt });
      totals.successes++;
      totals.matches += result.matches.length;
      for (const key of ['hits', 'misses', 'coalesced', 'bypassed']) {
        totals[key] += result.verification_cache[key];
      }
      lastSucceededAt = timestamp();
      lastError = null;
      return result;
    } catch (error) {
      totals.failures++;
      lastFailedAt = timestamp();
      lastError = String(error?.message || error).slice(0, 300);
      throw error;
    } finally {
      observeLatency(durationStarted);
    }
  }

  function health() {
    return {
      enabled,
      archives_configured: archives.length,
      totals: { ...totals },
      cache: cache ? cache.snapshot() : emptyCache(),
      latency: latencyHealth(),
      last_started_at: lastStartedAt,
      last_succeeded_at: lastSucceededAt,
      last_failed_at: lastFailedAt,
      last_error: lastError
    };
  }

  return { lookup, health, clearCache: () => cache?.clear() };
}
