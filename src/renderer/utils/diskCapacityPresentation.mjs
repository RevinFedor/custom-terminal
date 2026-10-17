export const EMPTY_DISK_CAPACITY = Object.freeze({ status: 'unknown', measuredAt: null,
  expiresAt: null, warning: null });

export function diskCapacitySnapshotForDisplay(snapshot) {
  const fallback = snapshot?.status === 'error' ? snapshot.fallback : null;
  if (!fallback) return snapshot;
  const hasFreeProjection = Number.isSafeInteger(fallback.freeBytes)
    && Number.isSafeInteger(fallback.remainingGrowthBytes)
    && Number.isSafeInteger(fallback.projectedFreeBytes)
    && typeof fallback.warning === 'boolean';
  return { ...snapshot, ...fallback, status: hasFreeProjection ? 'ready' : 'error',
    sampleErrorCode: snapshot.errorCode };
}

export function diskCapacityPresentation(rawSnapshot, now = Date.now()) {
  const snapshot = diskCapacitySnapshotForDisplay(rawSnapshot);
  if (snapshot?.status !== 'ready') return snapshot?.status === 'stale' ? 'stale'
    : snapshot?.status === 'error' ? 'error' : 'unknown';
  if (!Number.isFinite(snapshot.expiresAt) || snapshot.expiresAt <= now) return 'stale';
  const positiveFields = ['freeBytes', 'budgetBytes', 'reserveBytes', 'remainingGrowthBytes'];
  if (positiveFields.some(key => !Number.isSafeInteger(snapshot[key]) || snapshot[key] < 0)
      || !Number.isSafeInteger(snapshot.projectedFreeBytes) || typeof snapshot.warning !== 'boolean') return 'error';
  const cacheFresh = snapshot.cacheFresh !== false;
  if ((cacheFresh && (!Number.isSafeInteger(snapshot.cacheBytes) || snapshot.cacheBytes < 0))
      || (!cacheFresh && snapshot.cacheBytes != null
        && (!Number.isSafeInteger(snapshot.cacheBytes) || snapshot.cacheBytes < 0))) return 'error';
  return snapshot.warning ? 'warning' : 'healthy';
}

export function diskCapacityBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  // Keep the same two-letter UI convention as the resource chip. The byte
  // budgets and binary divisor are unchanged; this is a display label only.
  return `${(bytes / 1024 ** 3).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ГБ`;
}

export function cacheCapacityGiBNumber(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '—';
  const gib = bytes / 1024 ** 3;
  if (gib > 0 && gib < 0.01) return '<0,01';
  return gib.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}
