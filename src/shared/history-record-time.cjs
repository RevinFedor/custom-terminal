'use strict';

// Display-only provenance. Never call the legacy timestamp resolver here: it
// intentionally supplies Date.now for missing records for other consumers.
function normalizeHistoryRecordTime(value) {
  if (value?.version !== 1 || !['message', 'tool-call'].includes(value.kind)
    || !['record', 'container'].includes(value.scope)) return undefined;
  const timestamp = value.timestamp;
  if (typeof timestamp !== 'string' || !/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) <= 0) return undefined;
  return { version: 1, timestamp, kind: value.kind, scope: value.scope };
}

function historyRecordTimeFromRecord(record, kind = 'message', scope = 'record') {
  return normalizeHistoryRecordTime({ version: 1,
    timestamp: record?.timestamp || record?.time || record?.created_at, kind, scope });
}

function historyRecordTimeEqual(left, right) {
  return left === right || (left?.version === right?.version
    && left?.timestamp === right?.timestamp && left?.kind === right?.kind && left?.scope === right?.scope);
}

function historyRecordTimeKey(value) {
  return value ? [value.version, value.timestamp, value.kind, value.scope].join('\u001f') : '';
}

function historyRecordTimeFields(value) {
  const recordTime = normalizeHistoryRecordTime(value);
  return recordTime ? { recordTime } : {};
}

module.exports = { historyRecordTimeFromRecord, normalizeHistoryRecordTime, historyRecordTimeEqual, historyRecordTimeKey, historyRecordTimeFields };
