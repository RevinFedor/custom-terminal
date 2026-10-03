'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const http = require('node:http');
const { once } = require('node:events');
const url = require('node:url');
const { TabMessageService } = require('./tab-messages');
const { handleTabMessageApi } = require('./tab-message-api');

test('HTTP accepts two addressed questions while delivery waits; replies return only to their own sources', async t => {
  const db = new Database(':memory:');
  const addresses = new Map(['a', 'b', 'c'].map(tabId => [tabId, {
    tabId, tabName: tabId, projectId: 'project', projectName: 'Project',
    provider: 'codex', sessionId: 'session-' + tabId, cwd: '/synthetic',
  }]));
  const deliveries = [];
  const resolutions = [];
  const resolveTab = async id => { resolutions.push(id); return addresses.get(id); };
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const service = new TabMessageService({ db, resolveTab,
    send: async message => {
      deliveries.push(message);
      if (message.targetTabId === 'b') await blocked;
      return { success: true, status: 'sent', accepted: true, submitted: true, exactAuditConfirmed: true };
    },
  });
  await service.initialize();
  const server = http.createServer(async (req, res) => {
    const handled = await handleTabMessageApi(req, res, url.parse(req.url, true), {
      service, resolveTab,
      readBody: async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); },
      sendJson: (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); },
    });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { release(); service.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); db.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (path, sourceTabId, body) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceTabId, sourceMeta: { server: 'terminal', mode: 'internal', tabId: sourceTabId }, ...body }) });
    return { status: res.status, body: await res.json() };
  };
  const [a, c] = await Promise.all(['a', 'c'].map(source => post('/api/tab-messages', source, {
    targetTabId: 'b', text: 'Question from ' + source, requestId: 'request-' + source,
  })));
  assert.equal(a.status, 202); assert.equal(c.status, 202);
  assert.notEqual(a.body.messageId, c.body.messageId);
  assert.equal(service.getMessage(a.body.messageId).message.text, 'Question from a');
  assert.ok(deliveries.length <= 1, 'one target serializes attempts, HTTP acceptance does not wait on the lane');
  assert.equal(a.body.message.text, undefined, 'acceptance carries only metadata');
  const forged = await post('/api/tab-messages', 'a', { targetTabId: 'b', text: 'forged', requestId: 'forged',
    sourceMeta: { server: 'terminal', mode: 'internal', tabId: 'c' } });
  assert.equal(forged.status, 403);
  release(); await service.wake('b', 'test-ready');
  const secondFirst = await post('/api/tab-messages/' + c.body.messageId + '/replies', 'b', {
    text: 'Answer C', requestId: 'answer-c',
  });
  assert.equal(secondFirst.status, 202);
  const firstSecond = await post('/api/tab-messages/' + a.body.messageId + '/replies', 'b', {
    text: 'Answer A', requestId: 'answer-a',
  });
  assert.equal(firstSecond.status, 202);
  await service.wake('a', 'ready'); await service.wake('c', 'ready');
  assert.deepEqual(deliveries.filter(m => m.kind === 'reply').map(m => [m.text, m.targetTabId]), [
    ['Answer C', 'c'], ['Answer A', 'a'],
  ]);
  const before = deliveries.length;
  const result = await fetch(base + a.body.statusUrl).then(r => r.json());
  assert.equal(result.message.text, 'Question from a'); assert.equal(result.reply.text, 'Answer A');
  assert.equal(deliveries.length, before, 'reading never sends');
  const list = await fetch(base + '/api/tab-messages?tabId=a').then(r => r.json());
  assert.equal(list.messages.length, 2);
  assert.ok(list.messages.every(m => m.text === undefined && m.prompt === undefined));
  const duplicate = await post('/api/tab-messages', 'a', { targetTabId: 'b', text: 'Question from a', requestId: 'request-a' });
  assert.equal(duplicate.body.messageId, a.body.messageId); assert.equal(duplicate.body.deduplicated, true);
  const conflict = await post('/api/tab-messages', 'a', { targetTabId: 'b', text: 'Changed', requestId: 'request-a' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.messageId, a.body.messageId);
  const originalB = addresses.get('b');
  addresses.set('b', { ...originalB, provider: 'claude', sessionId: 'drifted-b' });
  const beforeRetryResolutions = resolutions.length;
  const drifted = await post('/api/tab-messages', 'a', { targetTabId: 'b', text: 'Question from a', requestId: 'request-a' });
  assert.equal(drifted.status, 202);
  assert.equal(drifted.body.messageId, a.body.messageId);
  assert.equal(drifted.body.message.targetSessionId, originalB.sessionId);
  assert.equal(drifted.body.message.targetProvider, originalB.provider);
  addresses.clear();
  const closed = await post('/api/tab-messages', 'a', { targetTabId: 'b', text: 'Question from a', requestId: 'request-a' });
  const closedReply = await post('/api/tab-messages/' + a.body.messageId + '/replies', 'b', {
    text: 'Answer A', requestId: 'answer-a',
  });
  assert.equal(closed.status, 202);
  assert.equal(closed.body.messageId, a.body.messageId);
  assert.equal(closedReply.status, 202);
  assert.equal(closedReply.body.messageId, firstSecond.body.messageId);
  assert.equal(resolutions.length, beforeRetryResolutions, 'exact retries do not resolve any live address');
  const changedClosed = await post('/api/tab-messages', 'a', { targetTabId: 'b', text: 'Changed again', requestId: 'request-a' });
  assert.equal(changedClosed.status, 409);
  assert.equal(changedClosed.body.messageId, a.body.messageId);
  assert.equal(changedClosed.body.accepted, false);
  assert.equal(changedClosed.body.submitted, false);
  assert.equal(changedClosed.body.deliveryState, 'not-submitted');
  assert.equal(Object.hasOwn(changedClosed.body, 'text'), false);
  assert.equal(resolutions.length, beforeRetryResolutions);
  let lookups = 0;
  const lookup = service.getExistingReservation.bind(service);
  service.getExistingReservation = payload => { lookups++; return lookup(payload); };
  const forgedRetry = await post('/api/tab-messages', 'a', {
    targetTabId: 'b', text: 'Question from a', requestId: 'request-a',
    sourceMeta: { server: 'terminal', mode: 'internal', tabId: 'c' },
  });
  assert.equal(forgedRetry.status, 403);
  assert.equal(Object.hasOwn(forgedRetry.body, 'messageId'), false);
  assert.equal(lookups, 0, 'caller metadata is validated before reading an existing reservation');
  const unknown = await post('/api/tab-messages', 'a', { targetTabId: 'b', text: 'new request', requestId: 'unknown' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.accepted, false);
  addresses.set('b', originalB);
  const unknownOriginal = await post('/api/tab-messages/missing-question/replies', 'b', { text: 'new answer', requestId: 'unknown-answer' });
  assert.equal(unknownOriginal.status, 404);
  assert.equal(unknownOriginal.body.submitted, false);
  assert.equal(db.prepare('SELECT count(*) n FROM tab_messages').get().n, 4);
  assert.equal(deliveries.length, before);
});
