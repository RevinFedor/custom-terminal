'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { once } = require('node:events');
const { createBuildInstallStatus } = require('./build-install-status');

test('one real HTTP/SSE status owner restores durable same job, rejects stale/source-swapped packets and cancels exact source only', async t => {
  const baseJob = { id: 'J', requestId: 'I', revision: 2, startedAt: 1, phase: 'building', running: true,
    returnTo: { tabId: '753', sessionId: 'S' } };
  let stream, saved = { version: 1, jobs: [{ ...baseJob, revision: 1, phase: 'observing' }] };
  const events = [], cancels = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/terminal/build-install') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ job: baseJob })); }
    if (req.url === '/api/events') { stream = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\r\n\r\n'); return; }
    if (req.url === '/api/terminal/build-install/cancel') {
      let raw = ''; for await (const chunk of req) raw += chunk; cancels.push(JSON.parse(raw));
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, job: { ...baseJob, revision: 4, phase: 'finished', running: false, cancelled: true } }));
    }
    res.writeHead(404); res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = createBuildInstallStatus({ token: () => 'private-token', read: () => saved,
    write: value => saved = value, changed: value => events.push(value),
    selectOwner: async () => ({ pid: process.pid, baseUrl: 'http://127.0.0.1:' + server.address().port }), retryMs: 10000 });
  t.after(async () => { client.stop(); stream?.end(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  assert.equal(client.snapshot('753').jobs[0].phase, 'observing'); assert.equal(client.snapshot('753').stale, true);
  client.start(); const deadline = Date.now() + 3000;
  while (!stream) { assert.ok(Date.now() < deadline); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(client.snapshot('753').known, true); assert.equal(client.snapshot('753').jobs[0].revision, 2);
  stream.write('data: ' + JSON.stringify({ type: 'terminal-build-install', job: { ...baseJob, revision: 3, phase: 'building', stage: 'installing' } }) + '\r\n\r\n');
  while (client.snapshot('753').jobs[0].revision !== 3) { assert.ok(Date.now() < deadline); await new Promise(resolve => setImmediate(resolve)); }
  client.apply({ ...baseJob, revision: 1 }); assert.equal(client.snapshot('753').jobs[0].stage, 'installing');
  assert.throws(() => client.apply({ ...baseJob, revision: 5, returnTo: { tabId: 'sibling', sessionId: 'S' } }), /source changed/);
  assert.deepEqual(client.snapshot('sibling').jobs, []);
  await assert.rejects(client.cancel({ tabId: 'sibling', requestId: 'I', id: 'J' }), /owner unproven/);
  assert.equal(cancels.length, 0);
  await client.cancel({ tabId: '753', requestId: 'I', id: 'J' }); assert.equal(cancels.length, 1);
  assert.deepEqual(cancels[0], { requestId: 'I', id: 'J', reason: 'cancelled from Noted task dock' });
  assert.equal(saved.jobs[0].cancelled, true); assert.ok(events.length >= 3);
});
