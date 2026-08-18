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

function forkMarkerChildSessionId(marker) {
  return String(
    marker?.fork_session_id
    || marker?.child_session_id
    || marker?.session_id
    || '',
  ).trim();
}

function forkMarkerSourceSessionId(marker) {
  return String(marker?.source_session_id || marker?.parent_session_id || '').trim();
}

function timelineEntryUuid(entry) {
  if (typeof entry === 'string') return entry.trim();
  return String(entry?.uuid || entry?.userUuid || entry?.entry_uuid || '').trim();
}

function resolveForkMarkerBoundary(entries, marker) {
  const snapshot = normalizeForkMarkerEntryUuids(marker?.entry_uuids);
  if (snapshot.length === 0) {
    return {
      atBeginning: true,
      boundaryIndex: -1,
      boundaryUuid: null,
      matchedCount: 0,
      snapshotCount: 0,
    };
  }

  const snapshotSet = new Set(snapshot);
  let boundaryIndex = -1;
  let boundaryUuid = null;
  let matchedCount = 0;
  for (let index = 0; index < (Array.isArray(entries) ? entries.length : 0); index += 1) {
    const uuid = timelineEntryUuid(entries[index]);
    if (!uuid || !snapshotSet.has(uuid)) continue;
    matchedCount += 1;
    boundaryIndex = index;
    boundaryUuid = uuid;
  }

  return {
    atBeginning: false,
    boundaryIndex,
    boundaryUuid,
    matchedCount,
    snapshotCount: snapshot.length,
  };
}

function markerCreatedAt(marker) {
  const numeric = Number(marker?.occurred_at ?? marker?.created_at ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function selectDirectForkMarker(markers, sessionId, entries = []) {
  const childSessionId = String(sessionId || '').trim();
  if (!childSessionId) return null;
  const candidates = (Array.isArray(markers) ? markers : [])
    .filter((marker) => forkMarkerChildSessionId(marker) === childSessionId);
  if (candidates.length === 0) return null;

  const provenDirect = candidates.filter((marker) => (
    marker?.is_direct === true || marker?.is_direct === 1
  ));
  const pool = provenDirect.length > 0 ? provenDirect : candidates;

  return pool
    .map((marker) => ({
      marker,
      boundary: resolveForkMarkerBoundary(entries, marker),
    }))
    .sort((left, right) => (
      markerCreatedAt(right.marker) - markerCreatedAt(left.marker)
      || right.boundary.boundaryIndex - left.boundary.boundaryIndex
      || right.boundary.snapshotCount - left.boundary.snapshotCount
      || forkMarkerSourceSessionId(right.marker).localeCompare(forkMarkerSourceSessionId(left.marker))
    ))[0]?.marker || null;
}

module.exports = {
  forkMarkerChildSessionId,
  forkMarkerSourceSessionId,
  normalizeForkMarkerEntryUuids,
  resolveForkMarkerBoundary,
  selectDirectForkMarker,
  timelineEntryUuid,
};
