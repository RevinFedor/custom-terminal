export {
  normalizeForkMarkerEntryUuids,
  resolveForkMarkerBoundary,
  selectDirectForkMarker,
  selectAppForkMarker,
} from '../../shared/fork-marker-boundary.mjs';

import {
  normalizeForkMarkerEntryUuids,
} from '../../shared/fork-marker-boundary.mjs';
import { isVisibleAppFork } from '../../shared/fork-operation.mjs';

export function normalizeForkMarkers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((marker) => marker && typeof marker === 'object' && !Array.isArray(marker))
    .map((marker) => ({
      ...marker,
      entry_uuids: normalizeForkMarkerEntryUuids(marker.entry_uuids),
    }));
}

export function isVisibleForkMarker(marker) {
  return isVisibleAppFork(marker);
}
