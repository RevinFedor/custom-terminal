'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createClient } = require('./research-maintenance.cjs');
function fixture({ legacy = false, unknown = false, absent = false, failPost = false, startupProof = true } = {}) {
  const calls = [], operations = []; let port = 7878;
  let startup = null;
  const client = createClient({ inspect: () => ({ status: unknown ? 'unknown' : absent ? 'absent' : 'found', server: { port, pid: 100 } }),
    token: () => 'owned-test-token', wait: async options => {
      calls.push({ wait: options.previousPid });
      if ((legacy || absent) && startupProof && !startup) {
        const operationId = 'install:' + (legacy ? 'first' : 'new');
        const next = require('../src/main/external-research-maintenance').transition({ version: 1, operations }, { action: 'begin', operationId });
        operations.splice(0, operations.length, ...next.value.operations);
        startup = { version: 1, operationId, durable: true, beforeRestore: true };
      }
      return { port: 7880, pid: 101 };
    },
    request: async request => {
      calls.push({ port: request.port, method: request.method, body: request.body });
      if (legacy && request.port === 7878) return { statusCode: 404, body: {} };
      if (failPost && request.method === 'POST') throw Object.assign(Error('owned lost ACK'), { code: 'ECONNRESET' });
      const { transition, activeId } = require('../src/main/external-research-maintenance');
      let result = { version: 1, operations };
      if (request.body) {
        const next = transition(result, request.body); operations.splice(0, operations.length, ...next.value.operations);
        result = { ...next.value, operation: next.operation, repeated: next.repeated };
      }
      return { statusCode: 200, body: { ok: true, maintenance: { ...result, activeOperationId: activeId(result), ...(startup ? { startup } : {}) } } };
    } });
  return { client, calls, operations };
}
test('operator begin/complete uses authenticated API and a new verified Main without model input', async () => {
  const f = fixture(), scope = f.client.installScope('install:test:1');
  assert.equal((await scope.begin()).preparedBeforeQuit, true);
  const result = await scope.complete();
  assert.equal(result.complete, true); assert.equal(result.bootstrap, false);
  assert.deepEqual(f.calls.filter(c => c.body).map(c => [c.port, c.body.action, c.body.operationId]),
    [[7878, 'begin', 'install:test:1'], [7880, 'complete', 'install:test:1']]);
  assert.equal(f.calls.find(c => Object.hasOwn(c, 'wait')).wait, 100);
  assert.equal(f.calls.at(-1).method, 'GET');
});
test('first deployment reports missing old quiet ACK honestly, then verifies new policy', async () => {
  const f = fixture({ legacy: true }), scope = f.client.installScope('install:first');
  assert.equal((await scope.begin()).preparedBeforeQuit, false);
  const result = await scope.complete(); assert.equal(result.bootstrap, true); assert.equal(result.complete, true);
  assert.equal(f.operations[0].state, 'completed');
  assert(!f.calls.some(c => c.port === 7880 && c.body?.action === 'begin'), 'late begin cannot masquerade as startup quiet');
  assert.deepEqual(scope.launchArguments(), ['--args', '--research-maintenance-operation=install:first']);
});
test('legacy bootstrap without early startup proof cannot complete or issue a late begin', async () => {
  const f = fixture({ legacy: true, startupProof: false }), scope = f.client.installScope('install:first');
  await scope.begin();
  await assert.rejects(scope.complete(), { code: 'maintenance_startup_unconfirmed' });
  assert.equal(f.operations.length, 0);
  assert(!f.calls.some(c => c.port === 7880 && c.method === 'POST'));
});
test('unknown owner and ambiguous begin ACK never fall back to legacy bootstrap', async () => {
  for (const options of [{ unknown: true }, { failPost: true }]) {
    const f = fixture(options), scope = f.client.installScope('install:unknown');
    await assert.rejects(scope.begin()); assert.equal(f.operations.length, 0);
  }
});
test('known absent previous app supports a first install without inventing a pre-quit ACK', async () => {
  const f = fixture({ absent: true }), scope = f.client.installScope('install:new');
  const begun = await scope.begin(); assert.equal(begun.previousMainAbsent, true); assert.equal(begun.preparedBeforeQuit, false);
  assert.equal((await scope.complete()).complete, true);
});
test('spent operation does not reopen maintenance on retry', async () => {
  const f = fixture(), scope = f.client.installScope('install:spent');
  await scope.begin(); await scope.complete();
  await assert.rejects(scope.begin(), { code: 'maintenance_operation_spent' });
  assert.equal(f.operations[0].state, 'completed');
});
