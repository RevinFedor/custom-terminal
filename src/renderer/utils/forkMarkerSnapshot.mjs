export function normalizeForkMarkerEntryUuids(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const normalized = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const uuid = candidate.trim();
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    normalized.push(uuid);
  }
  return normalized;
}

export function normalizeForkMarkers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((marker) => marker && typeof marker === 'object' && !Array.isArray(marker))
    .map((marker) => ({
      ...marker,
      entry_uuids: normalizeForkMarkerEntryUuids(marker.entry_uuids),
    }));
}
