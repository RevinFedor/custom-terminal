'use strict';

const { extractCodexSettingsCandidate } = require('./codex-source-settings');
const clean = value => typeof value === 'string' && value.trim().length <= 160 ? value.trim() || null : null;

function codexLaunchSettings(payload, sessionId, source, timestamp, callId = null) {
  if (!clean(sessionId) || !payload || !clean(payload.model) || callId && !clean(callId)) return null;
  const candidate = extractCodexSettingsCandidate({ type: 'turn_context', payload }, 0);
  return { version: 1, provider: 'codex', sessionId, source,
    model: candidate?.complete ? candidate.model : clean(payload.model),
    effort: candidate?.complete ? clean(candidate.effort) : null,
    timestamp: clean(timestamp), ...(callId ? { callId } : {}) };
}

//0.162 writes this from the RESOLVED child creation snapshot, not caller intent.
// An interacted event deliberately contains None and is never a new launch.
function codexStartedLaunchSettings(payload, callId, sessionId, timestamp) {
  if (payload?.kind !== 'started' || !callId || !sessionId
    || payload.event_id !== callId || payload.agent_thread_id !== sessionId) return null;
  return codexLaunchSettings(payload, sessionId, 'subagent-started', timestamp, callId);
}

function codexOwnTurnLaunchSettings(record, sessionId, physicalSessionId) {
  if (record?.type !== 'turn_context' || !sessionId || sessionId !== physicalSessionId) return null;
  return codexLaunchSettings(record.payload, sessionId, 'own-turn-context', record.timestamp);
}

function claudeOwnAssistantLaunchSettings(record) {
  const model = clean(record?.message?.model);
  if (record?.type !== 'assistant' || !model || model === '<synthetic>') return null;
  return { version: 1, provider: 'claude', sessionId: clean(record.sessionId),
    source: 'own-assistant', model, effort: null, timestamp: clean(record.timestamp) };
}

module.exports = { codexStartedLaunchSettings, codexOwnTurnLaunchSettings, claudeOwnAssistantLaunchSettings };
