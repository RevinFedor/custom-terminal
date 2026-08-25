export {
  normalizeForkMarkerEntryUuids,
  resolveForkMarkerBoundary,
  selectDirectForkMarker,
} from '../../shared/fork-marker-boundary.mjs';

import {
  normalizeForkMarkerEntryUuids,
} from '../../shared/fork-marker-boundary.mjs';

export function normalizeForkMarkers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((marker) => marker && typeof marker === 'object' && !Array.isArray(marker))
    .map((marker) => ({
      ...marker,
      entry_uuids: normalizeForkMarkerEntryUuids(marker.entry_uuids),
    }));
}

const HISTORY_REWRITE_FORK_MODES = new Set([
  'history_delete',
  'history_edit',
  'history_rewind',
]);

export function isVisibleForkMarker(marker) {
  if (!marker || marker.hidden === true) return false;
  const mode = String(marker.fork_mode || marker.forkMode || '').trim();
  return !HISTORY_REWRITE_FORK_MODES.has(mode);
}
