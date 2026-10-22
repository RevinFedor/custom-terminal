'use strict';

const { validId } = require('./build-continue-operation');
const PREFIX = '/api/build-continue/operations';
function summary(op) {
  return { version: op.version, id: op.id, phase: op.phase, capturedAt: op.capturedAt,
    sourceMainPid: op.sourceMainPid, activatedAt: op.activatedAt || null,
    participantCount: op.participants.length, targetCount: op.targets.length,
    externalOnlyCount: op.participants.filter(p => p.busy === false && (
      op.references.runs.some(run => run.sourceTabId === p.source.tabId && !['completed', 'failed', 'cancelled'].includes(run.status))
      || op.references.messages.some(message => message.sourceTabId === p.source.tabId && !message.replyMessageId))).length,
    idleCount: op.participants.filter(p => p.busy === false).length,
    targets: op.targets.map(t => ({ tabId: t.source.tabId, provider: t.source.provider,
      route: t.route, state: t.state, reason: t.reason || null, handoffId: t.handoffId })),
    unresolved: op.unresolved };
}
async function handleBuildContinueApi({ req, res, parsed, service, readBody, sendJson, quit }) {
  if (parsed.pathname !== PREFIX && !parsed.pathname.startsWith(PREFIX + '/')) return false;
  try {
    if (parsed.pathname === PREFIX && req.method === 'POST') {
      const body = await readBody(req);
      if (body.version !== 2 || body.action !== 'capture-quit' || !validId(body.operationId)
        || Object.keys(body).some(k => !['version', 'action', 'operationId', 'expectedMainPid'].includes(k))) {
        throw Object.assign(Error('build_continue_request_invalid'), { statusCode: 400 });
      }
      const op = await service.capture(body.operationId, body.expectedMainPid);
      sendJson(res, 200, { ok: true, operation: summary(op), reportUrl: PREFIX + '/' + encodeURIComponent(op.id) });
      quit();
      return true;
    }
    const match = parsed.pathname.match(/^\/api\/build-continue\/operations\/([^/]+)(\/restore)?$/);
    const id = match && decodeURIComponent(match[1]);
    if (!id || !validId(id)) throw Object.assign(Error('build_continue_request_invalid'), { statusCode: 400 });
    if (req.method === 'POST' && match[2]) {
      const body = await readBody(req);
      if (body.version !== 2 || Object.keys(body).some(k => k !== 'version')) throw Object.assign(Error('build_continue_request_invalid'), { statusCode: 400 });
      const op = service.activate(id);
      sendJson(res, 202, { ok: true, operation: summary(op), reportUrl: PREFIX + '/' + encodeURIComponent(id) });
      return true;
    }
    if (req.method === 'GET' && !match[2]) {
      const op = service.get(id);
      sendJson(res, op ? 200 : 404, op ? { ok: true, operation: parsed.query?.full === '1' ? op : summary(op) }
        : { ok: false, code: 'build_continue_operation_not_found' });
      return true;
    }
    sendJson(res, 405, { ok: false, code: 'method_not_allowed' }); return true;
  } catch (error) {
    if (res.writableEnded) return true;
    sendJson(res, error.statusCode || 503, { ok: false, code: error.code || error.message, error: error.message,
      ...(error.operationId ? { operationId: error.operationId } : {}) });
    return true;
  }
}
module.exports = { handleBuildContinueApi, summary, PREFIX };
