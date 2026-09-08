'use strict';

const { resolveInboxRewindTarget } = require('./inbox-rewind-identity');
const { classifyCodexTurnRecord } = require('./codex-turn-outcome');

const clean = (value) => typeof value === 'string' ? value.trim() : '';
const pending = (reason, turnId = null, event = null) => ({
  ended: false, success: null, reason, event, turnId,
});

/**
 * Read one audited Inbox send from its historical session. This is transcript
 * evidence only: no process generation, writer ownership, or lifecycle changes.
 * api is the existing codex-data._api, injected so the caller owns file access.
 */
function buildCodexInboxResult({ records, sessionId, audit, api, projectedEntries } = {}) {
  const sid = clean(sessionId);
  const exact = { entryUuid: clean(audit?.entryUuid), sourceIdentity: clean(audit?.sourceIdentity) };
  const failed = (code, identity = null, entries = [], event = null) => ({
    ok: false, code, identity, entries,
    terminal: pending(code, identity?.turnId || null, event),
  });
  if (!sid || (!exact.entryUuid && !exact.sourceIdentity)) return failed('missing-audit-identity');
  if (!Array.isArray(records) || typeof api?.findCodexPromptExecutionContext !== 'function'
    || (projectedEntries === undefined && typeof api?.createCodexHistoryProjector !== 'function')) {
    return failed('transcript-api-unavailable');
  }
  if (records.some((record) => !record || typeof record !== 'object' || !Number.isInteger(record.__line) || record.__line < 0)) {
    return failed('transcript-record-metadata-unproven');
  }
  let projected = projectedEntries;
  if (projected === undefined) {
    try {
      const projector = api.createCodexHistoryProjector(sid);
      for (const record of records) projector.feed(record);
      projected = projector.finalize({ includeTurnCoordinates: true });
    } catch {
      return failed('transcript-projection-failed');
    }
  }
  if (!Array.isArray(projected)) return failed('transcript-projection-failed');
  // Both supplied identities must refer to the same canonical row. Source
  // aliases preserve response/event carrier pairing without text matching.
  const resolved = resolveInboxRewindTarget(projected, exact, exact);
  if (!resolved.ok) {
    return failed(resolved.code === 'external_run_rewind_identity_mismatch'
      ? 'audit-identity-mismatch' : 'audit-identity-unproven');
  }
  const user = resolved.entry;
  const identity = {
    sessionId: sid,
    entryUuid: user.uuid,
    sourceIdentity: user.sourceIdentity || null,
    sourceIdentityAliases: [...(user.sourceIdentityAliases || [])],
    sourceUuidAliases: [...(user.sourceUuidAliases || [])],
    turnIndex: Number.isInteger(user.turnIndex) ? user.turnIndex : null,
    turnId: null,
  };
  if (identity.turnIndex == null) return failed('user-turn-coordinate-unproven', identity);
  // Row order is presentation order: tool results can be emitted after the
  // answer row. Select the existing canonical user coordinate, never a text tail.
  const entries = projected.filter((entry) => entry.turnIndex === identity.turnIndex && entry.role === 'assistant');
  let execution;
  try { execution = api.findCodexPromptExecutionContext(records, sid, user.uuid); }
  catch { return failed('execution-context-unproven', identity, entries); }
  const turnId = clean(execution?.turnId);
  if (!turnId || execution?.sessionId !== sid || execution?.provider !== 'codex') {
    return failed('execution-context-unproven', identity, entries);
  }
  identity.turnId = turnId;

  const tracker = {};
  const outcomes = [];
  records.forEach((record, index) => {
    const outcome = classifyCodexTurnRecord(tracker, record);
    if (outcome) outcomes.push({ ...outcome, index, payload: record.payload });
  });
  const starts = outcomes.filter((outcome) => outcome.event === 'task_started' && outcome.turnId === turnId);
  if (starts.length !== 1) return failed(starts.length ? 'duplicate-turn-start' : 'turn-start-unproven', identity, entries);
  const start = starts[0];
  const nextStart = outcomes.find((outcome) => outcome.event === 'task_started' && outcome.index > start.index);
  const ends = outcomes.filter((outcome) => !outcome.busy && outcome.turnId === turnId);
  if (ends.length > 1) return failed('duplicate-turn-end', identity, entries);
  const end = ends[0];
  if (end && (end.index <= start.index || (nextStart && end.index > nextStart.index))) {
    return failed('turn-end-outside-execution', identity, entries, end.event);
  }
  if (!end) {
    const foreignEnd = outcomes.find((outcome) => !outcome.busy && outcome.index > start.index
      && (!nextStart || outcome.index < nextStart.index));
    if (foreignEnd) return failed('turn-end-identity-mismatch', identity, entries, foreignEnd.event);
    if (nextStart) return failed('turn-end-unproven-before-next-start', identity, entries);
    return { ok: true, identity, entries, terminal: pending('awaiting-turn-end', turnId) };
  }
  const terminal = {
    ended: true,
    success: end.reason === 'task_complete' && end.hasFinalResult === true,
    reason: end.reason,
    event: end.event,
    turnId,
  };
  if (end.payload?.error && typeof end.payload.error === 'object') terminal.error = { ...end.payload.error };
  return { ok: true, identity, entries, terminal };
}

module.exports = { buildCodexInboxResult };
