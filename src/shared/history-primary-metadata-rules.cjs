'use strict';

// Shared predicate order for the native prepared decoder and the canonical
// cursor validator. An adapter supplies observations, not a materialized row.
// Keep short-circuit order: callers may own native values with accessors.
const HISTORY_PRIMARY_METADATA_CONTAINER_KINDS = Object.freeze(['array', 'object', 'text']);
function isThinHistoryMetadataRow(read, captionText = false) {
  return read('uuid', 'truthy') && read('rowStub', 'true')
    && (captionText ? read('content', 'nullish') || read('content', 'string') : !read('content', 'truthy'))
    && (read('captionTextComplete', 'nullish')
      || captionText && read('captionTextComplete', 'true') && read('content', 'string'))
    && !read('thinking', 'truthy') && !read('compactSummary', 'truthy') && !read('actions', 'lengthTruthy');
}
function nativeThinHistoryMetadataRow(row, captionText = false) {
  return isThinHistoryMetadataRow((key, observation) => {
    const value = row?.[key];
    switch (observation) {
      case 'truthy': return !!value;
      case 'true': return value === true;
      case 'nullish': return value == null;
      case 'string': return typeof value === 'string';
      case 'lengthTruthy': return !!value?.length;
      default: throw new Error('HISTORY_PRIMARY_METADATA_OBSERVATION');
    }
  }, captionText);
}

module.exports = { HISTORY_PRIMARY_METADATA_CONTAINER_KINDS, isThinHistoryMetadataRow, nativeThinHistoryMetadataRow };
