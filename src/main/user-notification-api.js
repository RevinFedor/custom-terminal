const { buildTerminalUserEnvelope } = require('./sc-desktop-notification-client');
const { TextDecoder } = require('util');
const MAX_USER_NOTIFICATION_BODY_BYTES = 16 * 1024;

const userNotificationCapability = Object.freeze({
  version: 1, channel: 'telegram', telegramOnly: true, durable: true,
  endpoint: '/api/terminal-tabs/:tabId/notifications', receipt: 'requestId',
  maxTextChars: 2000, maxWaitSeconds: 60, retentionHours: 24,
});

function readUserNotificationBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [], failed = false;
    const tooLarge = () => {
      failed = true; chunks = [];
      reject(Object.assign(new Error('notification body exceeds 16 KiB'), { statusCode: 413 }));
    };
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('notification body interrupted')));
    if (Number(req.headers?.['content-length']) > MAX_USER_NOTIFICATION_BODY_BYTES) {
      req.resume(); tooLarge(); return;
    }
    req.on('data', chunk => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > MAX_USER_NOTIFICATION_BODY_BYTES) tooLarge();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        chunks = [];
        resolve(text ? JSON.parse(text) : {});
      } catch { reject(Object.assign(new Error('invalid UTF-8 JSON notification body'), { statusCode: 400 })); }
    });
  });
}

async function userNotificationRequest({ method, tabId, query = {}, body = {}, descriptor, outbox }) {
  if (!outbox) return { statusCode: 503, body: { ok: false, error: 'user_notification_unavailable' } };
  const source = descriptor(tabId);
  if (!source?.toolType) return { statusCode: 404, body: { ok: false, error: 'source_agent_tab_not_found' } };
  if (method === 'GET') {
    if (typeof query.requestId !== 'string' || !query.requestId.trim() || query.requestId.length > 128) {
      return { statusCode: 400, body: { ok: false, error: 'requestId required' } };
    }
    const receipt = await outbox.readUserNotification(tabId, query.requestId.trim());
    return receipt ? { statusCode: 200, body: { ok: true, ...receipt } }
      : { statusCode: 404, body: { ok: false, error: 'notification_receipt_not_found', requestId: query.requestId } };
  }
  if (method !== 'POST') return { statusCode: 405, body: { ok: false, error: 'unsupported_notification_method' } };
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { statusCode: 400, body: { ok: false, error: 'notification_body_required' } };
  }
  if (body.sourceMeta?.server !== 'terminal' || body.sourceMeta?.tabId !== tabId
    || body.sourceMeta?.projectId !== source.projectId) {
    return { statusCode: 409, body: { ok: false, error: 'notification_source_mismatch' } };
  }
  if (Object.keys(body).some(key => !['text', 'requestId', 'waitSeconds', 'sourceMeta'].includes(key))) {
    return { statusCode: 400, body: { ok: false, error: 'unsupported_notification_field' } };
  }
  let envelope;
  try {
    envelope = buildTerminalUserEnvelope({ ...body, tabId, projectId: source.projectId,
      tabName: source.tabName, createdAt: Date.now() });
  } catch (error) { return { statusCode: 400, body: { ok: false, error: error.message } }; }
  const result = await outbox.enqueue(envelope);
  if (!result.ok) return { statusCode: result.reason === 'request_id_conflict' ? 409 : 503,
    body: { ok: false, error: result.reason, requestId: envelope.requestId,
      deliveryState: 'unknown', durable: result.durable === true } };
  await outbox.attemptUserNotification(envelope.eventId);
  const receipt = await outbox.readUserNotification(tabId, envelope.requestId);
  if (!receipt) return { statusCode: 503, body: { ok: false, error: 'notification_receipt_unavailable',
    requestId: envelope.requestId, deliveryState: 'unknown' } };
  return { statusCode: ['sent', 'failed'].includes(receipt.deliveryState) ? 200 : 202,
    body: { ok: true, ...receipt, duplicate: result.duplicate === true } };
}

module.exports = { userNotificationCapability, userNotificationRequest, readUserNotificationBody };
