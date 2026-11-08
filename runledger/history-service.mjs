import { createArchiveVerificationCache, locateHistory } from './maintenance.mjs';

const emptyCache = () => ({
  max_entries: 0, ttl_ms: 0, entries: 0, hits: 0, misses: 0, coalesced: 0,
  invalidations: 0, expirations: 0, evictions: 0
});

export function createHistoryLookupService({
  source, archives = [], secretFile,
  cacheMaxEntries = Math.max(1, archives.length), cacheTtlMs = 60_000,
  clock = Date.now
}) {
  if (typeof source !== 'string' || !source || !Array.isArray(archives) || archives.length > 20 ||
      archives.some(item => !item || typeof item.artifact !== 'string' || !item.artifact ||
        typeof item.manifest !== 'string' || !item.manifest) || typeof clock !== 'function' ||
      (archives.length > 0 && (typeof secretFile !== 'string' || !secretFile)) ||
      (archives.length === 0 && secretFile !== undefined)) {
    throw new TypeError('History service requires a source and up to 20 archive/manifest pairs with one secret key.');
  }

  const enabled = archives.length > 0;
  const cache = enabled ? createArchiveVerificationCache({ maxEntries: cacheMaxEntries, ttlMs: cacheTtlMs }) : null;
  const totals = { requests: 0, successes: 0, failures: 0, matches: 0,
    hits: 0, misses: 0, coalesced: 0, bypassed: 0 };
  let lastStartedAt = null;
  let lastSucceededAt = null;
  let lastFailedAt = null;
  let lastError = null;

  function timestamp() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('History service clock must return epoch milliseconds.');
    return value;
  }

  async function lookup(query) {
    if (!enabled) {
      const error = new Error('Signed archive history is not configured.');
      error.code = 'HISTORY_DISABLED';
      throw error;
    }
    const startedAt = timestamp();
    totals.requests++;
    lastStartedAt = startedAt;
    try {
      const result = await locateHistory({ source, archives, secretFile, query,
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
    }
  }

  function health() {
    return {
      enabled,
      archives_configured: archives.length,
      totals: { ...totals },
      cache: cache ? cache.snapshot() : emptyCache(),
      last_started_at: lastStartedAt,
      last_succeeded_at: lastSucceededAt,
      last_failed_at: lastFailedAt,
      last_error: lastError
    };
  }

  return { lookup, health, clearCache: () => cache?.clear() };
}
