'use strict';

function apiError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function compactTabMessage(message) {
  if (!message) return null;
  const { text, prompt, preparedPrompt, frozenPrompt, transportPrompt, ...metadata } = message;
  return {
    ...metadata,
    textChars: typeof text === 'string' ? text.length : message.textChars || 0,
    textPreview: typeof text === 'string' ? text.slice(0, 200) : message.textPreview || '',
  };
}

function messageApiAcceptance(reservation) {
  const message = reservation.message;
  return {
    ok: true,
    accepted: true,
    messageId: message.messageId,
    requestId: message.requestId,
    deliveryState: message.deliveryState,
    deduplicated: reservation.deduplicated === true,
    statusUrl: '/api/tab-messages/' + encodeURIComponent(message.messageId),
    message: compactTabMessage(message),
  };
}

function messageActorId(body) {
  const sourceTabId = typeof body.sourceTabId === 'string' ? body.sourceTabId.trim() : '';
  if (!sourceTabId) throw apiError('message_source_tab_required');
  const meta = body.sourceMeta;
  if (meta?.server === 'terminal' && (meta.mode !== 'internal' || meta.tabId !== sourceTabId)) {
    throw apiError('message_source_identity_mismatch', 403);
  }
  return sourceTabId;
}

async function resolveMessageActor(body, resolveTab) {
  const sourceTabId = messageActorId(body);
  const source = await resolveTab(sourceTabId);
  if (!source) throw apiError('message_source_not_found', 404);
  if (!source.provider || !source.sessionId) throw apiError('message_source_session_unavailable', 409);
  return source;
}

// The caller authenticates HTTP before entering this router. MCP's caller tab
// is carried independently of the requested destination and cannot be overridden.
async function handleTabMessageApi(req, res, parsed, { service, resolveTab, readBody, sendJson }) {
  const root = parsed.pathname === '/api/tab-messages';
  const selected = parsed.pathname.match(/^\/api\/tab-messages\/([^/]+)(\/replies)?$/);
  if (!root && !selected) return false;
  try {
    if (root && req.method === 'GET') {
      const tabId = typeof parsed.query.tabId === 'string' ? parsed.query.tabId.trim() : '';
      if (!tabId) throw apiError('message_tab_required');
      const limit = Math.max(1, Math.min(200, Number(parsed.query.limit) || 100));
      const messages = await service.listForTab(tabId, { limit });
      sendJson(res, 200, { ok: true, messages: messages.map(compactTabMessage) });
    } else if (selected && !selected[2] && req.method === 'GET') {
      const result = await service.getMessage(decodeURIComponent(selected[1]));
      if (!result) throw apiError('message_not_found', 404);
      sendJson(res, 200, { ok: true, ...result });
    } else if (req.method === 'POST' && (root || selected?.[2])) {
      const body = await readBody(req);
      // Validate caller ownership before any lookup. An exact retry is a read
      // of the old reservation, even after the original tabs close or drift.
      const sourceTabId = messageActorId(body);
      const targetTabId = root && typeof body.targetTabId === 'string' ? body.targetTabId.trim() : null;
      const messageId = root ? null : decodeURIComponent(selected[1]);
      if (root && !targetTabId) throw apiError('message_target_tab_required');
      let reservation = service.getExistingReservation({ sourceTabId, requestId: body.requestId,
        kind: root ? 'question' : 'reply', targetTabId, replyTo: messageId, text: body.text });
      if (!reservation) {
        const source = await resolveMessageActor(body, resolveTab);
        if (root) {
          const target = await resolveTab(targetTabId);
          if (!target) throw apiError('message_target_not_found', 404);
          reservation = await service.sendMessage({ source, target, text: body.text, requestId: body.requestId });
        } else {
          reservation = await service.replyToMessage({ responder: source, messageId,
            text: body.text, requestId: body.requestId });
        }
      }
      sendJson(res, 202, messageApiAcceptance(reservation));
    } else {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    }
  } catch (error) {
    console.warn('[TabMessages:API] rejected method=' + req.method
      + ' path=' + String(parsed.pathname).slice(0, 180)
      + ' code=' + (error.code || 'tab_message_failed') + ' status=' + (Number(error.statusCode) || 500));
    sendJson(res, Number(error.statusCode) || 500, { ok: false,
      ...(Number(error.statusCode) >= 400 && Number(error.statusCode) < 500
        ? { accepted: false, submitted: false, deliveryState: 'not-submitted' } : {}),
      ...(error.messageId ? { messageId: error.messageId } : {}),
      code: error.code || 'tab_message_failed', error: error.message || String(error) });
  }
  return true;
}

module.exports = { compactTabMessage, messageApiAcceptance, resolveMessageActor, handleTabMessageApi };
