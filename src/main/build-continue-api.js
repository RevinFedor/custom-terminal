'use strict';

const { validId } = require('./build-continue-operation');
const PREFIX = '/api/build-continue/operations';
function summary(op) {
  return { version: op.version, id: op.id, phase: op.phase, capturedAt: op.capturedAt,
    ...(op.installBinding ? { installBinding: op.installBinding, registeredAt: op.registeredAt,
      recoveryCancelledAt: op.recoveryCancelledAt || null, activationProof: op.activationProof || null } : {}),
    sourceMainPid: op.sourceMainPid, activatedAt: op.activatedAt || null,
    participantCount: op.participants.length, targetCount: op.targets.length,
    externalOnlyCount: op.participants.filter(p => p.busy === false && (
      op.references.runs.some(run => run.sourceTabId === p.source.tabId && !['completed', 'failed', 'cancelled'].includes(run.status))
      || op.references.messages.some(message => message.sourceTabId === p.source.tabId && !message.replyMessageId))).length,
    idleCount: op.participants.filter(p => p.busy === false).length,
    targets: op.targets.map(t => ({ tabId: t.source.tabId, provider: t.source.provider,
      route: t.route, state: t.state, reason: t.reason || null, handoffId: t.handoffId,
      operationKey: t.operationKey, active: !t.cancellation?.requestedAt
        && !['confirmed', 'already-working', 'result-ready', 'not-needed', 'superseded', 'paused', 'unresolved', 'cancelled'].includes(t.state),
      ...(t.cancellation ? { cancellation: t.cancellation } : {}),
      ...(t.proofWait ? { proofWait: t.proofWait } : {}),
      ...(t.supersessionProof ? { supersessionProof: t.supersessionProof } : {}),
      processRestore: t.state === 'already-working' ? 'running' : 'not-asserted',
      continuationDelivery: t.cancellation?.requestedAt ? 'future-input-revoked; past-delivery-see-receipt'
        : t.route.kind === 'install-callback' ? t.continuationDelivery || 'callback-owned'
        : t.state === 'confirmed' ? 'exact-native-confirmed' : ['accepted', 'sending'].includes(t.state) ? 'application-accepted'
        : t.state === 'unknown' ? 'unknown' : ['result-ready', 'not-needed'].includes(t.state) ? 'not-needed' : t.state,
      naturalFinal: t.state === 'result-ready' ? 'original-result-ready'
        : t.state === 'not-needed' ? 'pre-quit-completion-event' : t.naturalFinal || 'not-observed',
      taskCompletion: 'not-asserted', ...(t.originalInput ? { originalInput: t.originalInput } : {}),
      ...(t.refusalObservation ? { refusalObservation: t.refusalObservation } : {}) })),
    carriedTargets: op.carriedTargets || [],
    unresolved: op.unresolved };
}
async function handleBuildContinueApi({ req, res, parsed, service, readBody, sendJson, quit }) {
  if (parsed.pathname !== PREFIX && !parsed.pathname.startsWith(PREFIX + '/')) return false;
  try {
    if (parsed.pathname === PREFIX && req.method === 'GET') {
      sendJson(res, 200, { ok: true, operations: service.list().map(summary) }); return true;
    }
    if (parsed.pathname === PREFIX && req.method === 'POST') {
      const body = await readBody(req);
      if (body.version === 2 && ['register-voice-install', 'capture-voice-install', 'activate-voice-install', 'cancel-voice-install'].includes(body.action)) {
        if (!validId(body.operationId) || body.binding?.operationId !== body.operationId
          || Object.keys(body).some(k => !['version', 'action', 'operationId', 'expectedMainPid', 'binding'].includes(k))) {
          throw Object.assign(Error('build_continue_request_invalid'), { statusCode: 400 });
        }
        let op;
        if (body.action === 'register-voice-install') {
          if (body.expectedMainPid !== process.pid) throw Object.assign(Error('build_continue_source_changed'), { statusCode: 409 });
          op = await service.registerInstall(body.binding);
        } else if (body.action === 'capture-voice-install') {
          op = await service.capture(body.operationId, body.expectedMainPid, body.binding);
          if (op.phase !== 'captured') throw Object.assign(Error('voice_install_capture_revoked'), { statusCode: 409 });
          service.prepareShutdown(); // mandatory durable evidence BEFORE the Quit ACK/effect
        } else if (body.action === 'activate-voice-install') op = await service.activateInstall(body.operationId, body.binding);
        else op = await service.cancelInstall(body.operationId, body.binding);
        sendJson(res, 200, { ok: true, operation: summary(op), reportUrl: PREFIX + '/' + encodeURIComponent(op.id) });
        if (body.action === 'capture-voice-install') quit();
        return true;
      }
      if (body.version !== 2 || body.action !== 'capture-quit' || !validId(body.operationId)
        || Object.keys(body).some(k => !['version', 'action', 'operationId', 'expectedMainPid'].includes(k))) {
        throw Object.assign(Error('build_continue_request_invalid'), { statusCode: 400 });
      }
      const op = await service.capture(body.operationId, body.expectedMainPid);
      if (op.captureProofVersion === 1) service.prepareTaskShutdown();
      sendJson(res, 200, { ok: true, operation: summary(op), reportUrl: PREFIX + '/' + encodeURIComponent(op.id) });
      quit();
      return true;
    }
    const match = parsed.pathname.match(/^\/api\/build-continue\/operations\/([^/]+)(\/(?:restore|cancel-target|dismiss-capture))?$/);
    const id = match && decodeURIComponent(match[1]);
    if (!id || !validId(id)) throw Object.assign(Error('build_continue_request_invalid'), { statusCode: 400 });
    if (req.method === 'POST' && match[2] === '/dismiss-capture') {
      const body = await readBody(req);
      const acknowledgement = service.dismissCaptureIssue(id, body);
      sendJson(res, 200, { ok: true, acknowledgement,
        operation: summary(service.get(id)), reportUrl: PREFIX + '/' + encodeURIComponent(id) });
      return true;
    }
    if (req.method === 'POST' && match[2] === '/cancel-target') {
      const body = await readBody(req);
      if (body.version !== 2 || !validId(body.requestId) || !body.tabId || !body.handoffId || !body.operationKey
        || Object.keys(body).some(k => !['version', 'requestId', 'tabId', 'handoffId', 'operationKey'].includes(k))) {
        throw Object.assign(Error('build_continue_cancel_request_invalid'), { statusCode: 400 });
      }
      const op = await service.cancelTarget(id, body);
      sendJson(res, 200, { ok: true, operation: summary(op), reportUrl: PREFIX + '/' + encodeURIComponent(id) });
      return true;
    }
    if (req.method === 'POST' && match[2] === '/restore') {
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
