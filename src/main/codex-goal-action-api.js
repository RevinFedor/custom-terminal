'use strict';

const codexGoalCapability = Object.freeze({ version: 1, actions: ['resume', 'leave-paused'],
  endpoint: '/api/terminal-tabs/:tabId/codex/goal', requestId: true, operationId: true,
  recovery: 'read-only', persistence: 'runtime-owner' });

function codexGoalActionRequest({ method, tabId, body, requestId, actions, descriptor }) {
  if (!actions) return { status: 503, data: { ok: false, code: 'app_update_required',
    error: 'This Noted Terminal instance needs the Codex Goal action API.' } };
  if (!descriptor || descriptor.toolType !== 'codex') return { status: 404, data: {
    ok: false, code: 'codex_goal_tab_not_found', error: 'An existing Codex tab is required.' } };
  const result = method === 'GET'
    ? actions.read(tabId, requestId == null ? {} : { requestId })
    : actions.apply(tabId, { operationId: body?.operationId, requestId: body?.requestId, action: body?.action });
  const rejected = result.status === 'rejected';
  const status = rejected ? result.reason === 'invalid-goal-action' ? 400 : 409
    : result.status === 'pending' ? 202 : 200;
  return { status, data: { ...result, ok: !rejected, tabId,
    ...(rejected ? { code: result.reason, error: result.reason } : {}),
    guidance: result.status === 'unknown'
      ? 'Do not repeat Enter or restart the tab. Read this requestId; a new explicit choice requires a newer proven Goal dialog.'
      : 'Resume continues the native goal; leave-paused keeps it paused without deleting it or stopping Codex. This never resends a failed prompt.' } };
}

module.exports = { codexGoalCapability, codexGoalActionRequest };
