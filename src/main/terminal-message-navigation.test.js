'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleTerminalMessageOpen } = require('./terminal-message-navigation');
const source = { tabId: 'restored-test', messageId: 'exact-user', sessionId: 'original', provider: 'codex' };
test('actual private HTTP boundary validates auth/pid, activates first and awaits exact History ACK', async t => {
  const calls = []; let settle;
  const ack = new Promise(resolve => { settle = resolve; });
  const server = http.createServer((req, res) => handleTerminalMessageOpen(req, res, {
    checkAuth: req => req.headers.authorization === 'Bearer private-fixture', pid: 123,
    readBody: async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); },
    sendJson: (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); },
    reveal: () => { calls.push('reveal'); return { ok: true, revealed: true }; },
    bridgeRequest: (action, payload) => { calls.push({ action, payload }); return ack; },
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port;
  const request = body => fetch(url, { method: 'POST', headers: { authorization: 'Bearer private-fixture' }, body: JSON.stringify(body) });
  assert.equal((await request({ source, referenceId: 'action', expectedPid: 999 })).status, 409);
  assert.equal((await request({ source: { ...source, messageId: '' }, referenceId: 'action', expectedPid: 123 })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  assert.equal(calls.length, 0);
  const pending = request({ source, referenceId: 'action', expectedPid: 123 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls[0], 'reveal'); assert.equal(calls[1].action, 'terminalMessageReferenceOpen');
  assert.equal(calls[1].payload.source.messageId, source.messageId); assert.equal('detailsText' in calls[1].payload, false);
  settle({ found: true }); const response = await pending;
  assert.equal(response.status, 200); assert.equal((await response.json()).found, true);
});
test('missing/unknown result never replays open, and dispatch alone is not found', async () => {
  for (const result of [{ found: false, reason: 'identity-not-in-display' }, new Error('bridge-timeout')]) {
    let calls = 0, response;
    await handleTerminalMessageOpen({}, {}, { checkAuth: () => true, pid: 123,
      readBody: async () => ({ source, expectedPid: 123, referenceId: 'action' }),
      reveal: () => ({ ok: true }), sendJson: (_res, status, data) => { response = { status, data }; },
      bridgeRequest: async () => { calls++; if (result instanceof Error) throw result; return result; } });
    assert.equal(calls, 1); assert.equal(response.data.ok, false);
    assert.equal(response.status, result instanceof Error ? 503 : 404);
  }
});
