'use strict';

const { extractCodexSettingsCandidate } = require('./codex-source-settings');

// Same short, structured records feed the full parser and the incremental
// History surface. These are provider facts, not guessed commands or an ACK
// inferred from the requested model. No full transcript read is needed here.
function codexSettingsHistoryValues(record) {
  const candidate = extractCodexSettingsCandidate(record, 0);
  if (candidate?.complete) return { model: candidate.model, effort: candidate.effort };
  if (record?.type !== 'turn_context') return null;
  const { model, effort } = record.payload || {};
  return { model: typeof model === 'string' ? model.trim() : '',
    effort: typeof effort === 'string' ? effort.trim() : '' };
}

function codexSettingsHistoryEntry(record, sessionId, kind, value, { live = false } = {}) {
  const physicalSessionId = record.__physicalSessionId || sessionId;
  const offset = record.__byteOffset;
  const sourceIdentity = Number.isSafeInteger(offset) && offset >= 0
    ? `codex-${kind}-source-${physicalSessionId}-${offset}` : null;
  return {
    uuid: live ? sourceIdentity : `codex-${kind}-${physicalSessionId || 'unknown'}-${record.__line}`,
    role: 'slash', content: `/${kind} ${value}`,
    timestamp: record.timestamp || record.time || record.created_at || new Date().toISOString(),
    sessionId: physicalSessionId,
    ...(sourceIdentity ? { sourceIdentity, recordByteOffset: offset } : {}),
    settingsFact: { version: 1, provider: 'codex', kind, value,
      source: record.type === 'turn_context' ? 'turn_context' : 'thread_settings_applied',
      ...(live ? { live: true } : {}) },
  };
}

function projectCodexLiveSettingsHistory(state, record) {
  if (record?.type === 'event_msg' && record.payload?.type === 'thread_rolled_back') {
    delete state.historySettingsProjection;
    return [];
  }
  if (record?.type !== 'event_msg' || record.payload?.type !== 'thread_settings_applied'
    || !state?.sessionId || !Number.isSafeInteger(record.__byteOffset) || record.__byteOffset < 0) return [];
  const values = codexSettingsHistoryValues(record);
  if (!values?.model || !values?.effort) return [];
  const prior = state.historySettingsProjection;
  if (prior && record.__byteOffset <= prior.offset) return [];
  state.historySettingsProjection = { ...values, offset: record.__byteOffset };
  return ['model', 'effort'].filter(kind => !prior || prior[kind] !== values[kind])
    .map(kind => codexSettingsHistoryEntry(record, state.sessionId, kind, values[kind], { live: true }));
}

// Display state immediately BEFORE this canonical window, not current UI
// params. Stubs retain settingsFact, so prepared/SSD windows need no body read.
function codexSettingsWindowBaseline(entries, window, { sessionId, revision, payloadGeneration, contentRevision = null }) {
  const before = { model: null, effort: null };
  for (let index = window.startIndex - 1; index >= 0 && (!before.model || !before.effort); index--) {
    const entry = entries[index], fact = entry?.settingsFact;
    if (fact?.version !== 1 || fact.provider !== 'codex' || !['model', 'effort'].includes(fact.kind)
      || typeof fact.value !== 'string' || !fact.value || before[fact.kind]) continue;
    before[fact.kind] = { uuid: entry.uuid, sourceIdentity: entry.sourceIdentity || null,
      sessionId: entry.sessionId || sessionId, timestamp: entry.timestamp,
      settingsFact: { version: 1, provider: 'codex', kind: fact.kind, value: fact.value, source: fact.source } };
  }
  return { version: 1, scope: { sessionId, revisionToken: revision?.token || null, payloadGeneration, contentRevision },
    window: { startIndex: window.startIndex, firstUuid: window.firstUuid, lastUuid: window.lastUuid,
      total: window.total, hasMoreBelow: window.hasMoreBelow === true }, before };
}

module.exports = { codexSettingsHistoryValues, codexSettingsHistoryEntry, projectCodexLiveSettingsHistory,
  codexSettingsWindowBaseline };
