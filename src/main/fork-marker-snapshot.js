'use strict';

const {
  normalizeForkMarkerEntryUuids,
} = require('../shared/fork-marker-boundary.cjs');

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
