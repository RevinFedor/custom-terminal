const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { userNotificationRequest, readUserNotificationBody } = require('./user-notification-api');
const { Readable } = require('node:stream');
const { buildTerminalCompletionEnvelope, buildTerminalUserEnvelope,
  createScDesktopNotificationOutbox, postTerminalCompletionToScDesktop } = require('./sc-desktop-notification-client');

const sourceMeta = { server: 'terminal', tabId: 'source', projectId: 'project' };
const descriptor = () => ({ tabId: 'source', projectId: 'project', toolType: 'codex', tabName: 'Testing' });
const body = (extra = {}) => ({ requestId: 'warning-1', text: 'Cursor warning', waitSeconds: 20, sourceMeta, ...extra });
const envelope = (extra = {}) => buildTerminalUserEnvelope({ ...body(), projectId: 'project', tabId: 'source',
  tabName: 'Testing', createdAt: Date.now(), ...extra });
const quiet = { log() {}, warn() {} };

test('direct HTTP body is bounded before JSON parsing, including chunked requests', async () => {
  const valid = Readable.from([Buffer.from(JSON.stringify(body()))]);
  valid.headers = {};
  assert.equal((await readUserNotificationBody(valid)).text, 'Cursor warning');
  const chunked = Readable.from([Buffer.alloc(8192), Buffer.alloc(8193)]);
  chunked.headers = {};
  await assert.rejects(readUserNotificationBody(chunked), error => error.statusCode === 413);
  const declared = Readable.from([]);
  declared.headers = { 'content-length': 16385 };
  await assert.rejects(readUserNotificationBody(declared), error => error.statusCode === 413);
  assert.doesNotThrow(() => declared.emit('error', new Error('late disconnect')));
});

test('direct HTTP rejects malformed JSON/UTF-8 without notification admission', async () => {
  for (const bytes of [Buffer.from('{broken'), Buffer.from([0xff])]) {
    const req = Readable.from([bytes]); req.headers = {};
    await assert.rejects(readUserNotificationBody(req), error => error.statusCode === 400);
  }
});

async function fixture(t, transport) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-user-notification-'));
  const storagePath = path.join(root, 'outbox.json');
  const outbox = createScDesktopNotificationOutbox({ storagePath, transport, logger: quiet });
  t.after(async () => { outbox.stop(); await outbox.persistChain; await fs.rm(root, { recursive: true, force: true }); });
  const request = (method = 'POST', payload = body(), query = {}) => userNotificationRequest({
    method, tabId: 'source', body: payload, query, descriptor, outbox,
  });
  return { outbox, request, root, storagePath };
}

test('user notification has a separate stable identity, no alarm/completion fields', () => {
  const one = envelope();
  assert.equal(one.eventId, envelope({ createdAt: one.createdAt + 100, tabName: 'Renamed' }).eventId);
  assert.notEqual(one.eventId, envelope({ requestId: 'second' }).eventId);
  for (const field of ['firedAt', 'mode', 'unread', 'persistent', 'fired']) assert.equal(one[field], undefined);
  for (const extra of [{ text: '' }, { text: 'x'.repeat(2001) }, { waitSeconds: -1 },
    { waitSeconds: 61 }, { waitSeconds: '20' }, { requestId: 'bad\nidentity' }]) {
    assert.throws(() => envelope(extra));
  }
});

for (const prefix of ['operational-human:research-operational:', 'research-browser-offline:']) {
  test('automatic Research notice is suppressed before transport: ' + prefix, async t => {
    let calls = 0;
    const h = await fixture(t, async () => { calls++; return { ok: true, messageId: 901, sentAt: Date.now() }; });
    const e = envelope({ requestId: prefix + 'a'.repeat(64), waitSeconds: 0 });
    await h.outbox.enqueue(e); await h.outbox.attemptUserNotification(e.eventId);
    const receipt = await h.outbox.readUserNotification('source', e.requestId);
    assert.equal(calls, 0); assert.equal(receipt.deliveryState, 'suppressed');
    assert.equal(receipt.errorCode, 'research_automatic_notifications_disabled');
    assert.equal(receipt.sentAt, null); assert.equal(receipt.messageId, null);
    assert.equal(receipt.receiptDurable, true);
  });
}

test('manual notify_user keeps its text but cannot use reserved automatic Research identities', async t => {
  let calls = 0;
  const h = await fixture(t, async () => { calls++; return { ok: true, messageId: 903, sentAt: Date.now() }; });
  const denied = await h.request('POST', body({ requestId: 'research-browser-offline:' + 'c'.repeat(64) }));
  assert.equal(denied.statusCode, 409); assert.equal(denied.body.error, 'notification_request_id_reserved');
  assert.equal(calls, 0);
  const manual = await h.request('POST', body({ requestId: 'manual-research-status', text: 'External Research: requested manual status', waitSeconds: 0 }));
  assert.equal(manual.body.deliveryState, 'sent'); assert.equal(calls, 1);
});

test('pending legacy Research Telegram is retired across restart without claiming its unknown prior delivery failed', async t => {
  const h = await fixture(t, async () => assert.fail('old owner does not send'));
  await h.outbox.ready; h.outbox.stop();
  const e = envelope({ requestId: 'operational-human:research-operational:' + 'b'.repeat(64), waitSeconds: 0 });
  await fs.writeFile(h.storagePath, JSON.stringify({ version: 1, settled: [], pending: [{ envelope: e,
    enqueuedAt: Date.now(), attemptCount: 3, nextAttemptAt: 0, durable: true, deliveryState: 'unknown',
    lastError: { code: 'timeout', message: 'prior HTTP outcome unknown' } }] }));
  let calls = 0;
  const restored = createScDesktopNotificationOutbox({ storagePath: h.storagePath, strictLoad: true, logger: quiet,
    transport: async () => { calls++; return { ok: true, messageId: 902, sentAt: Date.now() }; } });
  t.after(async () => { restored.stop(); await restored.persistChain; });
  await restored.ready; await restored.drain(); restored.stop();
  const saved = JSON.parse(await fs.readFile(h.storagePath, 'utf8'));
  assert.equal(calls, 0); assert.equal(saved.pending.length, 0);
  const receipt = saved.settled[0].userReceipt;
  assert.equal(receipt.deliveryState, 'suppressed'); assert.equal(receipt.previousDeliveryState, 'unknown');
  assert.equal(receipt.previousAttemptCount, 3); assert.equal(receipt.messageId, undefined);
  const again = createScDesktopNotificationOutbox({ storagePath: h.storagePath, strictLoad: true, logger: quiet,
    transport: async () => assert.fail('suppressed backlog must not return after restart') });
  t.after(async () => { again.stop(); await again.persistChain; });
  await again.ready;
  assert.equal((await again.readUserNotification('source', e.requestId)).deliveryState, 'suppressed');
});

test('durable admission precedes Telegram, and send receipt fixes the requested wait', async t => {
  let calls = 0, stored;
  const sentAt = Date.now();
  const h = await fixture(t, async event => {
    calls += 1;
    stored = JSON.parse(await fs.readFile(h.storagePath, 'utf8'));
    assert.equal(stored.pending[0].envelope.eventId, event.eventId);
    return { ok: true, messageId: 101, sentAt };
  });
  const result = await h.request();
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.accepted, true);
  assert.equal(result.body.deliveryState, 'sent');
  assert.equal(result.body.waitUntil, sentAt + 20_000);
  assert.equal(calls, 1);
  const read = await h.request('GET', {}, { requestId: 'warning-1' });
  assert.equal(read.body.sentAt, sentAt);
  assert.equal(calls, 1);
});

test('same-ID concurrent/restarted replay never resends or changes first send time', async t => {
  let calls = 0;
  const sentAt = Date.now();
  const h = await fixture(t, async () => { calls += 1; return { ok: true, messageId: 102, sentAt }; });
  const first = h.request();
  const duplicate = h.request();
  assert.equal((await first).body.sentAt, sentAt);
  assert.equal((await duplicate).body.deliveryState, 'sent');
  assert.equal(calls, 1);
  h.outbox.stop();
  const restored = createScDesktopNotificationOutbox({ storagePath: h.storagePath,
    transport: async () => assert.fail('already delivered'), logger: quiet });
  t.after(() => restored.stop());
  const replay = await userNotificationRequest({ method: 'POST', tabId: 'source', body: body(), descriptor, outbox: restored });
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.sentAt, sentAt);
  assert.equal(replay.body.waitUntil, sentAt + 20_000);
});

test('changed text/wait under one ID conflicts before another Telegram attempt', async t => {
  let calls = 0;
  const h = await fixture(t, async () => { calls += 1; return { ok: true, messageId: 103, sentAt: Date.now() }; });
  await h.request();
  for (const extra of [{ text: 'different' }, { waitSeconds: 30 }]) {
    const result = await h.request('POST', body(extra));
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error, 'request_id_conflict');
  }
  assert.equal(calls, 1);
});

test('unknown network outcome and invalid success receipt do not complete the warning', async t => {
  for (const transportResult of [{ ok: false, reason: 'timeout' }, { ok: true }]) {
    const h = await fixture(t, async () => transportResult);
    const result = await h.request();
    h.outbox.stop();
    assert.equal(result.statusCode, 202);
    assert.equal(result.body.accepted, true);
    assert.equal(result.body.deliveryState, 'unknown');
    assert.equal(result.body.sentAt, null);
    assert.equal(result.body.waitUntil, null);
  }
});

test('permanent delivery failure is not a sent/settled success', async t => {
  const h = await fixture(t, async () => ({ ok: false, status: 401, reason: 'http_error' }));
  const result = await h.request();
  assert.equal(result.body.deliveryState, 'failed');
  assert.equal(result.body.messageId, null);
  assert.equal((await h.request()).body.deliveryState, 'failed');
});

test('failed durable write cannot send; identical retry persists before sending', async t => {
  let calls = 0;
  const h = await fixture(t, async () => { calls += 1; return { ok: true, messageId: 104, sentAt: Date.now() }; });
  const persist = h.outbox.persist.bind(h.outbox);
  h.outbox.persist = async () => { throw new Error('disk full'); };
  const failed = await h.request();
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.durable, false);
  assert.equal(calls, 0);
  await h.outbox.drain();
  assert.equal(calls, 0);
  h.outbox.persist = persist;
  assert.equal((await h.request()).body.deliveryState, 'sent');
  assert.equal(calls, 1);
});

test('an unreadable user outbox is unknown, never an empty receipt or a new send', async t => {
  const h = await fixture(t, async () => assert.fail('blocked storage must not send'));
  h.outbox.stop();
  await fs.writeFile(h.storagePath, '{broken');
  const blocked = createScDesktopNotificationOutbox({ storagePath: h.storagePath, strictLoad: true,
    logger: quiet, transport: async () => assert.fail('blocked storage must not send') });
  t.after(() => blocked.stop());
  assert.equal((await blocked.enqueue(envelope())).reason, 'storage_unavailable');
  await assert.rejects(blocked.readUserNotification('source', 'warning-1'), /storage unavailable/);
  assert.equal(await fs.readFile(h.storagePath, 'utf8'), '{broken');
});

test('notification caller/fields are checked without reading History or touching input', async t => {
  let calls = 0;
  const h = await fixture(t, async () => { calls += 1; return { ok: true }; });
  for (const payload of [body({ sourceMeta: { ...sourceMeta, tabId: 'other' } }),
    body({ fired: true }), body({ text: 'x'.repeat(2001) }), body({ waitSeconds: 0.5 })]) {
    const result = await h.request('POST', payload);
    assert.ok([400, 409].includes(result.statusCode));
  }
  assert.equal((await h.request('GET', {}, { requestId: 'missing' })).statusCode, 404);
  assert.equal(calls, 0);
});

test('completion envelopes and their previous queue path are preserved', async t => {
  const h = await fixture(t, async event => {
    assert.equal(event.kind, 'terminal-completion');
    return { ok: true, status: 200 };
  });
  const completion = buildTerminalCompletionEnvelope({ projectId: 'project', tabId: 'source', tabName: 'Testing',
    firedAt: 12345, persistent: true, fired: true });
  assert.deepEqual(completion, { kind: 'terminal-completion', eventId: 'source:12345', projectId: 'project',
    tabId: 'source', tabName: 'Testing', firedAt: 12345, mode: 'persistent', unread: true });
  await h.outbox.enqueue(completion);
  await h.outbox.drain();
  assert.equal(h.outbox.settled.has(completion.eventId), true);
  assert.equal(await h.outbox.readUserNotification('source', 'warning-1'), null);
});

test('HTTP transport selects the user route and requires exact Telegram proof', async t => {
  const h = await fixture(t, async () => assert.fail('no outbox send'));
  const tokenPath = path.join(h.root, 'token');
  await fs.writeFile(tokenPath, 'a'.repeat(64));
  const event = envelope();
  let endpoint;
  const deliver = payload => postTerminalCompletionToScDesktop(event, { tokenPath,
    fetchImpl: async (url, options) => {
      endpoint = url;
      assert.equal(JSON.parse(options.body).kind, 'terminal-user');
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    } });
  assert.equal((await deliver({ ok: true, eventId: 'other', sentAt: Date.now(), deliveries: [{ message_id: 1 }] })).ok, false);
  assert.equal((await deliver({ ok: true, eventId: event.eventId, sentAt: Date.now(), deliveries: [{ message_id: 1 }] })).ok, true);
  assert.equal(endpoint, 'http://127.0.0.1:53127/notifications/terminal-user');
  const completion = buildTerminalCompletionEnvelope({ projectId: 'project', tabId: 'source', firedAt: 12345 });
  const legacy = await postTerminalCompletionToScDesktop(completion, { tokenPath,
    fetchImpl: async url => {
      assert.equal(url, 'http://127.0.0.1:53127/notifications/terminal-completion');
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, deliveries: [{ message_id: 10 }] }) };
    } });
  assert.equal(Object.hasOwn(legacy, 'sentAt'), false);
});
