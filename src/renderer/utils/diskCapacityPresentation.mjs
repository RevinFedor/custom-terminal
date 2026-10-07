export const EMPTY_DISK_CAPACITY = Object.freeze({ status: 'unknown', measuredAt: null,
  expiresAt: null, warning: null });

export function diskCapacityPresentation(snapshot, now = Date.now()) {
  if (snapshot?.status !== 'ready') return snapshot?.status === 'stale' ? 'stale'
    : snapshot?.status === 'error' ? 'error' : 'unknown';
  if (!Number.isFinite(snapshot.expiresAt) || snapshot.expiresAt <= now) return 'stale';
  const positiveFields = ['freeBytes', 'cacheBytes', 'budgetBytes', 'reserveBytes', 'remainingGrowthBytes'];
  if (positiveFields.some(key => !Number.isSafeInteger(snapshot[key]) || snapshot[key] < 0)
      || !Number.isSafeInteger(snapshot.projectedFreeBytes) || typeof snapshot.warning !== 'boolean') return 'error';
  return snapshot.warning ? 'warning' : 'healthy';
}

export function diskCapacityBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  // This explicitly labels binary GiB; the cache's byte limit uses these units.
  return `${(bytes / 1024 ** 3).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ГиБ`;
}
