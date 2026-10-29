'use strict';

const { materializeHistoryCursor } = require('./history-paged-store');
const { createHistorySearchAccumulator } = require('../shared/history-search.cjs');

// Search consumes the original canonical order, one selected row projection
// at a time. Tool args/results are not a search input and are never decoded.
// Exact locale-lowercase semantics still need ONE complete content String.
// All Timeline marker IDs are part of the old response and stay complete;
// neither that output nor the native lowercase String is claimed bounded.
async function searchHistoryRoot(root, options = {}, { control, stats = {} } = {}) {
  const scan = createHistorySearchAccumulator(options);
  const fields = ['uuid', 'role', 'serviceCarrier', 'content', 'imageCount',
    'sourceIdentity', 'entryRef', 'sourceIdentityAliases', 'uuidAliases',
    'physicalSessionId', 'sessionId'];
  Object.assign(stats, { rows: 0, maxContentChars: 0, maxResidentRowProjections: 0,
    nativeMemoryBounded: false, returnedMarkersBounded: false });
  for (let index = 0; index < root.length; index++) {
    control?.assertCurrent();
    const row = root.at(index), entry = {};
    for (const key of fields) entry[key] = await materializeHistoryCursor(row.field(key), { control });
    const images = row.field('imagePaths');
    // Search observes only array/nonempty, not any image's body or path.
    entry.imagePaths = images.kind === 'array' && images.length ? [null] : [];
    scan.accept(entry, index);
    stats.rows++; stats.maxResidentRowProjections = 1;
    stats.maxContentChars = Math.max(stats.maxContentChars, typeof entry.content === 'string' ? entry.content.length : 0);
    if (control?.checkpoint) await control.checkpoint();
  }
  control?.assertCurrent(); return scan.result();
}

module.exports = { searchHistoryRoot };
