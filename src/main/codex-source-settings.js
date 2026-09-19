'use strict';

const TURN_CONTEXT_EFFORT_KEYS = [
  'effort',
  'reasoning_effort',
  'model_reasoning_effort',
];

const THREAD_SETTINGS_EFFORT_KEYS = [
  'reasoning_effort',
  'effort',
  'model_reasoning_effort',
];

function normalizedString(value, { lowercase = false } = {}) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return lowercase ? normalized.toLowerCase() : normalized;
}

function readCompatibleString(object, keys, options) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    return { value: null, conflict: false };
  }

  const values = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    const value = normalizedString(object[key], options);
    if (value) values.push(value);
  }
  const unique = [...new Set(values)];
  return {
    value: unique.length === 1 ? unique[0] : null,
    conflict: unique.length > 1,
  };
}

function inspectSessionMetadata(records, expectedSessionId) {
  // A resumed/forked rollout can contain copied session_meta records from its
  // ancestry. Only the first metadata record describes this rollout's own
  // identity; this is the same root-meta contract used by codex-data.
  const metadataRecord = records.find((record) => record?.type === 'session_meta');
  if (!metadataRecord) {
    return { valid: false, reason: 'session-meta-absent' };
  }

  const payload = metadataRecord.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, reason: 'session-meta-invalid' };
  }
  const ids = [payload.id, payload.session_id]
    .map((value) => normalizedString(value))
    .filter(Boolean);
  if (ids.length === 0) {
    return { valid: false, reason: 'session-meta-id-absent' };
  }
  if (ids.some((id) => id !== expectedSessionId)) {
    return {
      valid: false,
      reason: 'session-meta-mismatch',
      actualSessionIds: [...new Set(ids)],
    };
  }

  return { valid: true };
}

function extractSettingsCandidate(record, index) {
  const payload = record?.payload;
  let sourceKind = null;
  let settings = null;
  let effortKeys = null;

  if (record?.type === 'turn_context') {
    sourceKind = 'turn_context';
    settings = payload;
    effortKeys = TURN_CONTEXT_EFFORT_KEYS;
  } else if (record?.type === 'event_msg'
    && payload?.type === 'thread_settings_applied') {
    sourceKind = 'thread_settings_applied';
    settings = payload.thread_settings;
    effortKeys = THREAD_SETTINGS_EFFORT_KEYS;
  } else {
    return null;
  }

  const model = normalizedString(settings?.model);
  const effortResult = readCompatibleString(settings, effortKeys, { lowercase: true });
  if (!model || !effortResult.value || effortResult.conflict) {
    return {
      complete: false,
      sourceKind,
      index,
      reason: effortResult.conflict
        ? 'settings-effort-conflict'
        : 'settings-pair-incomplete',
    };
  }

  return {
    complete: true,
    sourceKind,
    index,
    model,
    effort: effortResult.value,
  };
}

// The batch API and the Resume reader share one reducer. Keep the latest
// candidate even when incomplete: falling back to an older pair is unsafe.
function createCodexSourceSettingsReducer(expectedSessionId) {
  const normalizedExpectedSessionId = normalizedString(expectedSessionId);
  let firstMetadata = null;
  let latestCandidate = null;
  let count = 0;
  const feed = (record) => {
    if (!firstMetadata && record?.type === 'session_meta') firstMetadata = record;
    const candidate = extractSettingsCandidate(record, count++);
    if (candidate) latestCandidate = candidate;
  };
  const finalize = () => {
    if (!normalizedExpectedSessionId) {
      return {
        status: 'invalid',
        sourceKind: null,
        reason: 'expected-session-id-invalid',
      };
    }

    const metadata = inspectSessionMetadata(firstMetadata ? [firstMetadata] : [], normalizedExpectedSessionId);
    if (!metadata.valid) {
      return {
        status: 'invalid',
        sourceKind: 'session_meta',
        reason: metadata.reason,
        ...(metadata.actualSessionIds
          ? { actualSessionIds: metadata.actualSessionIds }
          : {}),
      };
    }

    if (!latestCandidate) {
      return {
        status: 'absent',
        sourceKind: null,
        reason: 'settings-pair-absent',
      };
    }

    // Do not resurrect an older pair after the conversation recorded a newer
    // incomplete or conflicting settings event. The exact latest structured
    // state is required before Resume/Fork can safely override config.toml.
    if (!latestCandidate.complete) {
      return {
        status: 'invalid',
        sourceKind: latestCandidate.sourceKind,
        reason: latestCandidate.reason,
        recordIndex: latestCandidate.index,
      };
    }

    return {
      status: 'found',
      sourceKind: latestCandidate.sourceKind,
      model: latestCandidate.model,
      effort: latestCandidate.effort,
      recordIndex: latestCandidate.index,
    };
  };
  return { feed, finalize };
}

function resolveCodexSourceSettingsProof(records, expectedSessionId) {
  if (!Array.isArray(records)) {
    return { status: 'invalid', sourceKind: null, reason: 'records-not-array' };
  }
  const reducer = createCodexSourceSettingsReducer(expectedSessionId);
  for (const record of records) reducer.feed(record);
  return reducer.finalize();
}

module.exports = {
  extractCodexSettingsCandidate: extractSettingsCandidate,
  createCodexSourceSettingsReducer,
  resolveCodexSourceSettingsProof,
};
