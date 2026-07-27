'use strict';

function normalizeForkMarkerEntryUuids(value) {
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

function parseForkMarkerEntryUuidsJson(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    return normalizeForkMarkerEntryUuids(JSON.parse(value));
  } catch {
    return [];
  }
}

module.exports = {
  normalizeForkMarkerEntryUuids,
  parseForkMarkerEntryUuidsJson,
};
