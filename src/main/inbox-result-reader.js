'use strict';

const { buildCodexInboxResult } = require('./codex-inbox-result');

// A receipt selects the historical send. Runtime/tab status is deliberately
// absent from this proof: neither "idle" nor a tab-level done identifies it.
async function readInboxResult({ runId, record, liveRun = null, loadRecords, projectHistory, hydratePayload, api, cwd, includeEntries = true }) {
  const reply = (statusCode, body) => ({ statusCode, body: { runId, ...body } });
  if (!record) return liveRun
    ? reply(202, { ok: true, pending: true, stage: 'awaiting-receipt' })
    : reply(404, { ok: false, code: 'inbox_result_not_found', error: 'Inbox send receipt not found' });
  if (record.surface !== 'inbox' || record.runId !== runId || record.provider !== 'codex') {
    return reply(409, { ok: false, code: 'inbox_result_identity_mismatch', error: 'Inbox receipt does not identify this Codex send' });
  }
  const meta = { tabId: record.tabId, handoffId: record.handoffId, attemptId: record.attemptId,
    deliveryState: record.state, protocol: 'codex-inbox-result-v1' };
  if (record.state !== 'confirmed') return reply(202, { ok: true, pending: true, ...meta, stage: 'awaiting-exact-audit' });
  const audit = record.auditIdentity;
  if (!audit?.sessionId || audit.provider !== 'codex' || !record.attemptId || audit.attemptId !== record.attemptId
    || (!audit.entryUuid && !audit.sourceIdentity)) {
    return reply(409, { ok: false, ...meta, code: 'inbox_result_audit_unproven', error: 'Confirmed send has no matching exact audit identity' });
  }
  if (typeof loadRecords !== 'function' || typeof projectHistory !== 'function') {
    return reply(503, { ok: false, ...meta, code: 'inbox_result_reader_unavailable', error: 'Codex result reader is unavailable' });
  }
  const sessionId = audit.sessionId;
  const loaded = await loadRecords(sessionId, cwd);
  if (!loaded?.success) return reply(503, { ok: false, ...meta, sessionId,
    code: 'inbox_result_source_unavailable', error: loaded?.error || 'Codex transcript is unavailable' });
  const projected = await projectHistory(sessionId, cwd, { includeTurnCoordinates: true });
  if (!projected?.success || typeof loaded.filePath !== 'string' || !loaded.filePath
    || loaded.filePath !== projected.filePath) {
    return reply(503, { ok: false, ...meta, sessionId,
      code: 'inbox_result_source_changed', error: projected?.error || 'Codex transcript source changed during read' });
  }
  const result = buildCodexInboxResult({ records: loaded.records, sessionId, audit, api, projectedEntries: projected.entries });
  const observed = liveRun?.observedTerminal;
  if (result.ok && !result.terminal.ended && observed?.capacitySurfaceOnly !== true
    && observed?.sessionId === sessionId && observed?.turnId === result.identity?.turnId
    && ['interrupt', 'turn_aborted', 'manual-stop', 'terminal-kill'].includes(observed.reason)) {
    result.terminal = { ended: true, success: false, reason: observed.reason, event: 'done',
      turnId: observed.turnId, proofSource: 'main-terminal-event' };
  }
  // The shared cache may contain desktop preview+refs. Hydrate just this turn,
  // without mutating the cached rows or silently persisting a preview as output.
  const entries = [];
  for (const source of includeEntries ? (result.entries || []) : []) {
    const entry = { ...source };
    const hydrate = async (ref) => {
      if (!ref?.payloadId || typeof hydratePayload !== 'function') throw new Error('Full Codex result payload is unavailable');
      const full = await hydratePayload({ toolType: 'codex', sessionId, cwd, payloadId: ref.payloadId });
      if (!full?.success) throw new Error(full?.error || 'Full Codex result payload is unavailable');
      return full;
    };
    if (entry.thinkingRef) {
      const full = await hydrate(entry.thinkingRef);
      entry.thinking = full.payload;
      entry.thinkingTruncated = full.truncatedForRender === true;
      delete entry.thinkingRef;
    }
    if (Array.isArray(source.actions)) {
      entry.actions = await Promise.all(source.actions.map(async (action) => {
        if (!action?.rawTool?.resultRef) return action;
        const full = await hydrate(action.rawTool.resultRef);
        const rawTool = { ...action.rawTool, result: full.payload, resultTruncated: full.truncatedForRender === true,
          resultTotalChars: full.totalChars };
        delete rawTool.resultRef;
        return { ...action, rawTool };
      }));
    }
    entries.push(entry);
  }
  const body = { ...meta, sessionId, ...result, entries, pending: result.terminal?.ended !== true,
    auditEntryUuid: audit.entryUuid || null, auditSourceIdentity: audit.sourceIdentity || null,
    sourceSnapshot: projected.sourceSnapshot || loaded.sourceSnapshot || null };
  if (!result.ok && ['execution-context-unproven', 'turn-start-unproven'].includes(result.code)) {
    // Codex can durably write its user carrier just before task_started. The
    // exact message is readable; its execution identity is not complete yet.
    return reply(202, { ...body, ok: true, scopeReady: false });
  }
  if (!result.ok) return reply(409, { ...body, error: 'Exact Codex turn result is unproven: ' + result.code });
  return reply(result.terminal.ended ? 200 : 202, body);
}

module.exports = { readInboxResult };
