'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMiniOrchestratorMcpSender } = require('./mini-orchestrator-mcp');
const job = { tabId: 'own-tab', owner: { sessionId: 'own' }, turnId: 'turn', jobId: 'job',
  handoffId: 'mini-orchestrator:job', prompt: 'One correction', isCurrent: () => true };
test('one actual Terminal MCP operation fixes target/queue/handoff, no Reply or result observer', async () => {
  let calls = 0;
  const send = createMiniOrchestratorMcpSender({ endpointFor: () => 'http://127.0.0.1:53133/mcp/terminal?tab=own-tab',
    fetchImpl: async (_url, options) => {
      calls++; const rpc = JSON.parse(options.body);
      assert.equal(rpc.method, 'tools/call'); assert.equal(rpc.params.name, 'send_prompt');
      assert.deepEqual(rpc.params.arguments, { tabId: 'own-tab', prompt: 'One correction', submit: true, queue: true, handoffId: job.handoffId });
      return { ok: true, json: async () => ({ id: rpc.id, result: { content: [{ type: 'text', text: 'Prompt sent. Status: application-queued' }] } }) };
    } });
  assert.equal((await send(job)).status, 'queued'); assert.equal(calls, 1);
});
test('changed source during endpoint await and lost ACK never replay or become sent', async () => {
  let current = true, calls = 0;
  const send = createMiniOrchestratorMcpSender({ endpointFor: async () => { current = false; return 'http://127.0.0.1:53133/mcp/terminal'; },
    fetchImpl: () => { calls++; throw Error('lost'); } });
  assert.equal((await send({ ...job, isCurrent: () => current })).status, 'refused'); assert.equal(calls, 0);
  const unknown = createMiniOrchestratorMcpSender({ endpointFor: () => 'http://127.0.0.1:53133/mcp/terminal', fetchImpl: () => { calls++; throw Error('lost'); } });
  assert.equal((await unknown(job)).status, 'unknown'); assert.equal(calls, 1);
});
test('local Project API transport carries the same terminal-mcp authorship as the hub', async () => {
  // Both transports end in the same guarded send, so History must record the
  // same provenance. The route reads `source` from the body; omitting it left
  // the delivery authorless and rendered as an ordinary human paste.
  let body = null;
  const send = createMiniOrchestratorMcpSender({
    endpointFor: () => ({ kind: 'project-api', base: 'http://127.0.0.1:7777/api/terminal-tabs/', token: 't' }),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:7777/api/terminal-tabs/own-tab/send');
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: 'queued' }) };
    },
  });
  assert.equal((await send(job)).status, 'queued');
  assert.equal(body.source, 'terminal-mcp', 'author of the send, so History renders it as a Terminal MCP message');
  assert.equal(body.prompt, 'One correction');
  assert.equal(body.handoffId, job.handoffId);
  assert.ok(!('sendSurface' in body), 'transport/surface stays owned by the route, never claimed by the caller');
});
