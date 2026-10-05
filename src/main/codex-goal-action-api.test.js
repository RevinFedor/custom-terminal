'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const url = require('node:url');
const { codexGoalCapability, codexGoalActionRequest } = require('./codex-goal-action-api');
const { createCodexRuntimePolicyController, inspectCodexPolicyDialog } = require('./codex-runtime-policies');

const goal = 'Resume paused goal?\nGoal: private test\n> 1. Resume goal  Mark it active and continue when idle\n  2. Leave paused  Keep it paused; use /goal resume later\nPress enter to confirm or esc to go back';
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const start = source.indexOf('  m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/codex\\/goal$/);');
const end = source.indexOf('  m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/completion-notification$/);', start);
assert.ok(start > 0 && end > start);

async function harness(t) {
  let frame = { valid: true, seq: 1, text: goal };
  let frameAvailable = false;
  const owner = { terminal: {}, live: true, lifecycleGeneration: 'G', runSeq: 1, inputRevision: 1 };
  const writes = [], timers = [];
  const controller = createCodexRuntimePolicyController({
    capture: () => ({ ...owner }), readFrame: async () => frameAvailable ? frame : { valid: false },
    withWriteLock: async (_term, work) => work({ active: true }), readPolicy: () => ({}),
    isComposer: f => f.text === 'composer', stopAll: () => assert.fail('not process Stop'), publish() {},
    setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer() {},
    sendKey: async (_tab, key, { guard }) => {
      assert.equal(guard(), true); writes.push(key);
      if (key === '\r') frame = { valid: true, seq: frame.seq + 1, text: 'composer' };
      else {
        const selected = inspectCodexPolicyDialog(frame.text).selectedIndex;
        const next = selected + (key === '\x1b[B' ? 1 : -1);
        frame = { valid: true, seq: frame.seq + 1,
          text: frame.text.replace('> ', '  ').replace('  ' + next + '.', '> ' + next + '.') };
      }
      controller.observe('T', frame);
      return { written: true };
    },
  });
  controller.observe('T', frame);
  await tick();
  for (const fire of [...timers]) await fire();
  frameAvailable = true;
  const actions = { read: (...args) => controller.readGoalAction(...args), apply: (...args) => controller.applyGoalAction(...args) };
  const route = vm.runInNewContext('(async (req,res,parsed) => { let m;' + source.slice(start, end)
    + '\nres.writeHead(404);res.end("{}");})', {
    codexGoalActionRequest, codexGoalActions: actions, decId: decodeURIComponent,
    findOrchestrationTabDescriptor: id => id === 'T' ? { toolType: 'codex' } : null,
    readBody: async req => { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text); },
    sendJson: (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
  });
  const server = http.createServer((req, res) => route(req, res, url.parse(req.url, true))
    .catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = async (method = 'GET', body, suffix = '', id = 'T') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/terminal-tabs/' + id + '/codex/goal' + suffix,
      { method, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  return { request, writes, owner };
}

for (const action of ['resume', 'leave-paused']) test('actual HTTP Goal route reuses guarded controller: ' + action, async t => {
  const h = await harness(t);
  const initial = await h.request();
  assert.equal(initial.data.status, 'available', JSON.stringify(initial));
  assert.equal(h.writes.length, 0, 'GET is not an action or resume');
  const body = { operationId: initial.data.operationId, requestId: 'choice', action };
  const started = await h.request('POST', body);
  assert.ok([200, 202].includes(started.status), JSON.stringify(started));
  await tick();
  const result = await h.request('GET', undefined, '?requestId=choice');
  assert.equal(result.data.status, 'confirmed', JSON.stringify(result));
  assert.equal(result.data.choiceConfirmed, true);
  assert.deepEqual(h.writes, action === 'resume' ? ['\r'] : ['\x1b[B', '\r']);
  const writes = h.writes.length;
  const duplicate = await h.request('POST', body);
  assert.equal(duplicate.data.replayed, true);
  assert.equal(h.writes.length, writes);
  const conflict = await h.request('POST', { ...body, action: action === 'resume' ? 'leave-paused' : 'resume' });
  assert.equal(conflict.status, 409);
  assert.equal(h.writes.length, writes);
});

test('Goal route rejects stale/invalid/foreign choices and never starts stopped runtime', async t => {
  const h = await harness(t);
  const state = await h.request();
  assert.equal((await h.request('POST', { operationId: 'old', requestId: 'a', action: 'resume' })).status, 409);
  assert.equal((await h.request('POST', '{bad')).status, 400);
  assert.equal((await h.request('POST', { operationId: state.data.operationId, requestId: 'b', action: 'delete' })).status, 400);
  assert.equal((await h.request('GET', undefined, '', 'missing')).status, 404);
  h.owner.live = false;
  assert.equal((await h.request()).data.status, 'unavailable');
  assert.equal((await h.request('POST', { operationId: state.data.operationId, requestId: 'c', action: 'resume' })).status, 409);
  assert.equal(h.writes.length, 0);
  assert.equal(codexGoalActionRequest({ method: 'GET', tabId: 'T' }).status, 503);
  assert.equal(codexGoalCapability.version, 1);
});
