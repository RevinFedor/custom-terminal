'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createClient } = require('./research-maintenance.cjs');
const { transition, activeId } = require('../src/main/external-research-maintenance');

function fixture({ failAt = 'complete-post', commit = true, recoveredId = null, recoveryFails = false,
  refusal = false, bootstrap = false, startupProof = true, foreignActive = false } = {}) {
  const operationId = 'install:confirmation';
  let value = transition(null, { action: 'begin', operationId }, 100).value;
  let failed = false, completePosted = false;
  const calls = [], logs = [];
  const lost = Object.assign(new Error('request timeout'), { code: 'ECONNRESET' });
  const client = createClient({
    inspect: () => bootstrap ? { status: 'absent' } : { status: 'found', server: { port: 7878, pid: 100 } },
    token: () => 'fixture-token', wait: async () => ({ port: 7880, pid: 101 }),
    request: async request => {
      const action = request.body?.action;
      calls.push({ method: request.method, action, operationId: request.body?.operationId });
      let operation;
      if (action === 'complete') {
        completePosted = true;
        if (refusal) return { statusCode: 409, body: { code: 'research_maintenance_owner_changed' } };
        if (commit) { const result = transition(value, request.body, 200); value = result.value; operation = result.operation; }
        if (failAt === 'complete-post') { failed = true; throw lost; }
      } else if (action === 'begin') {
        const result = transition(value, request.body, 100); value = result.value; operation = result.operation;
      }
      if (request.method === 'GET' && completePosted) {
        if (failAt === 'readback' && !failed) { failed = true; throw lost; }
        if (failed && recoveryFails) throw new Error('fixture recovery unavailable');
      }
      let operations = value.operations;
      if (failed && recoveredId) operations = operations.map(op => ({ ...op, operationId: recoveredId }));
      return { statusCode: 200, body: { ok: true, maintenance: { version: 1, operation,
        operations, activeOperationId: failed && foreignActive ? 'install:foreign' : activeId(value),
        ...(bootstrap && startupProof ? { startup: { version: 1, operationId, durable: true, beforeRestore: true } } : {}),
      } } };
    },
  });
  const scope = client.installScope(operationId, { log: text => logs.push(text) });
  return { scope, calls, logs, lost };
}

for (const bootstrap of [false, true]) for (const failAt of ['complete-post', 'readback']) {
  test(`committed ${failAt} lost ACK is recovered by one exact GET (bootstrap=${bootstrap})`, async () => {
    const f = fixture({ failAt, bootstrap }); await f.scope.begin();
    const result = await f.scope.complete();
    assert.equal(result.complete, true);
    assert.equal(result.confirmation, 'recovered-by-exact-readback');
    assert.equal(f.calls.filter(c => c.action === 'complete').length, 1, 'never replay the POST');
    assert.equal(f.calls.filter(c => c.method === 'GET').length,
      (bootstrap ? 1 : 0) + (failAt === 'readback' ? 2 : 1));
    assert.equal(f.calls.at(-1).method, 'GET');
  });
}

for (const options of [{ commit: false }, { recoveredId: 'install:foreign' }, { recoveryFails: true }, { foreignActive: true }]) {
  test('unknown/nonmatching recovery preserves the original error: ' + JSON.stringify(options), async () => {
    const f = fixture(options); await f.scope.begin();
    await assert.rejects(f.scope.complete(), error => error === f.lost);
    assert.equal(f.calls.filter(c => c.action === 'complete').length, 1);
    assert.equal(f.calls.filter(c => c.method === 'GET').length, 1);
  });
}

test('an explicit owner refusal is not transport ambiguity', async () => {
  const f = fixture({ refusal: true }); await f.scope.begin();
  await assert.rejects(f.scope.complete(), { code: 'research_maintenance_owner_changed' });
  assert.equal(f.calls.filter(c => c.method === 'GET').length, 0);
  assert.equal(f.calls.filter(c => c.action === 'complete').length, 1);
});

test('bootstrap still needs its exact durable before-restore receipt before any complete', async () => {
  const f = fixture({ bootstrap: true, startupProof: false }); await f.scope.begin();
  await assert.rejects(f.scope.complete(), { code: 'maintenance_startup_unconfirmed' });
  assert.equal(f.calls.filter(c => c.action === 'complete').length, 0);
});
