'use strict';

const { createHash } = require('node:crypto');
const CAPABILITY = Object.freeze({ version: 1, endpoint: '/api/terminal-tabs/inspect',
  maxTabs: 8, maxPreviewChars: 2000, passive: true, responseRead: 'verified-cache-only' });
const revision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unknown = reason => ({ known: false, reason });

function normalizeInspectionRequest(value = {}) {
  const allowed = ['tabIds', 'includeLastResponse', 'maxPreviewChars'];
  if (Object.keys(value).some(key => !allowed.includes(key))
    || !Array.isArray(value.tabIds) || value.tabIds.length < 1 || value.tabIds.length > CAPABILITY.maxTabs
    || value.tabIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 512)
    || new Set(value.tabIds).size !== value.tabIds.length
    || (value.includeLastResponse !== undefined && typeof value.includeLastResponse !== 'boolean')
    || (value.maxPreviewChars !== undefined && (!Number.isInteger(value.maxPreviewChars)
      || value.maxPreviewChars < 0 || value.maxPreviewChars > CAPABILITY.maxPreviewChars))) {
    throw Object.assign(new Error('invalid_tab_inspection_request'), { statusCode: 400 });
  }
  return { tabIds: [...value.tabIds], includeLastResponse: value.includeLastResponse === true,
    maxPreviewChars: value.maxPreviewChars ?? CAPABILITY.maxPreviewChars };
}

function responseProjection(result, state, limit) {
  if (result?.known !== true || result.complete !== true || !result.ref) {
    return { ...unknown(result?.reason || 'response_unavailable'), status: 'unavailable' };
  }
  const context = result.ref.targetExecutionContext;
  const current = state.runtime?.known === true && state.busy === false && state.transitioning === false
    && state.runtime.liveLifecycle === true && state.turn?.status === 'completed'
    && context?.sessionId === state.sessionId && context.turnId === state.turn.turnId;
  const body = typeof result.assistantText === 'string' ? result.assistantText : '';
  return { known: true, status: current ? 'current' : 'historical', scope: 'turn', complete: true,
    ref: result.ref, chars: result.assistantChars ?? body.length,
    truncated: result.truncated === true || body.length > limit,
    ...(limit > 0 ? { preview: body.slice(0, limit) } : {}) };
}

// Bounded projection over existing owners. Reading never registers a wait/job,
// reconciles a process, or grants input/whole-work completion authority.
async function inspectTabs(request, { capture, readResponse, readTracked }) {
  const { tabIds, includeLastResponse, maxPreviewChars } = normalizeInspectionRequest(request);
  const tabs = [];
  for (const tabId of tabIds) {
    try {
      const before = capture(tabId);
      const tracked = readTracked(tabId);
      let lastResponse = { known: false, status: 'not-requested', reason: 'not_requested' };
      if (includeLastResponse && before.known === true && before.exists === true) {
        let result;
        try { result = await readResponse(tabId, before); }
        catch { result = unknown('response_read_failed'); }
        lastResponse = responseProjection(result, before, maxPreviewChars);
      }
      const after = capture(tabId);
      if (before.revision !== after.revision) {
        tabs.push({ tabId, known: false, revision: revision([before.revision, after.revision]),
          reason: 'tab_state_changed', lastResponse: { ...unknown('tab_state_changed'), status: 'unavailable' } });
        continue;
      }
      const currentTracked = readTracked(tabId);
      const execution = before.turn?.executionContext;
      const currentRunIds = (currentTracked.jobs || []).filter(job => job.direction === 'incoming'
        && execution?.turnId && execution.generation != null
        && job.executionContext?.provider === execution.provider
        && job.executionContext?.sessionId === execution.sessionId
        && job.executionContext?.turnId === execution.turnId
        && job.executionContext?.generation === execution.generation).map(job => job.runId);
      tabs.push({ tabId, known: before.known === true, exists: before.exists,
        revision: revision([before.revision, currentTracked]),
        ...(before.reason ? { reason: before.reason } : {}),
        name: before.name || null, provider: before.toolType || null, sessionId: before.sessionId || null,
        runtime: before.runtime || unknown('runtime_unavailable'),
        turn: before.turn || unknown('turn_unavailable'),
        ownBackground: before.ownBackground || unknown('background_unavailable'),
        tracked: currentTracked,
        currentRuns: { known: currentTracked.known === true && currentTracked.truncated !== true,
          runIds: currentRunIds },
        ...(revision(tracked) !== revision(currentTracked) ? { trackedChangedDuringRead: true } : {}),
        lastResponse });
    } catch {
      tabs.push({ tabId, known: false, revision: null, reason: 'tab_inspection_unavailable',
        runtime: unknown('runtime_unavailable'), ownBackground: unknown('background_unavailable'),
        tracked: unknown('tracked_unavailable'), lastResponse: { ...unknown('response_unavailable'), status: 'unavailable' } });
    }
  }
  return { version: 1, passive: true, observedAt: Date.now(), tabs };
}

module.exports = { TAB_INSPECTION_CAPABILITY: CAPABILITY, normalizeInspectionRequest, inspectTabs };
