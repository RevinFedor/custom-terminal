'use strict';

// Only the durable terminal event owns this notice. Neither a quoted error in
// user/assistant prose nor a transient network error terminates a conversation.
function codexProviderErrorEntry(record, fallbackSessionId, turnIndex = undefined) {
  const payload = record?.payload;
  if (record?.type !== 'event_msg' || payload?.type !== 'task_complete'
    || !payload.error || typeof payload.error !== 'object' || Array.isArray(payload.error)) return null;
  const error = payload.error;
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  const code = typeof error.codex_error_info === 'string' ? error.codex_error_info : 'provider_error';
  const usageLimit = code === 'usage_limit_exceeded';
  const role = usageLimit ? 'usage-limit' : 'provider-error';
  const prefix = 'codex-' + role;
  const sessionId = record.__physicalSessionId || fallbackSessionId;
  if (!sessionId) return null;
  const position = Number.isFinite(record.__byteOffset) ? record.__byteOffset : record.__line;
  if (!Number.isFinite(position)) return null;
  const revoked = /refresh token[\s\S]{0,120}\brevoked\b|please log out and sign in again/i.test(message);
  const content = usageLimit ? 'Usage limit reached'
    : revoked ? 'Codex: вход недействителен. Войдите в аккаунт снова.'
    : 'Codex: запрос завершился ошибкой провайдера.';
  return {
    uuid: `${prefix}-${sessionId}-${record.__line ?? position}`,
    sourceIdentity: `${prefix}-source-${sessionId}-${position}`,
    role, serviceCarrier: role, sessionId, content,
    timestamp: record.timestamp || record.time || record.created_at || '',
    sourceRecordLine: record.__line,
    ...(Number.isFinite(record.__byteOffset) ? { recordByteOffset: record.__byteOffset } : {}),
    ...(Number.isInteger(turnIndex) ? { turnIndex } : {}),
    providerError: { provider: 'codex', code, message,
      info: error.codex_error_info ?? null, turnId: payload.turn_id || null },
  };
}

function codexProviderErrorMessage(record, sessionId) {
  const entry = codexProviderErrorEntry(record, sessionId);
  if (!entry) return null;
  return { type: entry.role, uuid: entry.uuid, timestamp: entry.timestamp, sessionId: entry.sessionId,
    sourceIdentity: entry.sourceIdentity, serviceCarrier: entry.serviceCarrier,
    providerError: entry.providerError, sourceRecordLine: entry.sourceRecordLine,
    ...(entry.recordByteOffset != null ? { recordByteOffset: entry.recordByteOffset } : {}),
    __projectionSource: 'codex-rollout-provider-error', __projectionTranscript: true,
    __projectionTimeline: false, __projectionEphemeral: false,
    message: { role: entry.role, content: [{ type: 'text', text: entry.content }] } };
}

module.exports = { codexProviderErrorEntry, codexProviderErrorMessage };
