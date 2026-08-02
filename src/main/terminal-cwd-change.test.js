'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDirectoryTarget,
  TerminalCwdChangeProofRegistry,
} = require('./terminal-cwd-change');

test('normalizes an absolute directory target and rejects empty input', () => {
  assert.equal(normalizeDirectoryTarget('/tmp/example/../target'), '/tmp/target');
  assert.equal(normalizeDirectoryTarget(''), null);
  assert.equal(normalizeDirectoryTarget(null), null);
});

test('only exact cwd proof from the same terminal generation completes a change', async () => {
  const terminalA = {};
  const terminalB = {};
  const registry = new TerminalCwdChangeProofRegistry({
    now: () => 100,
    setTimer: () => 1,
    clearTimer: () => {},
    idFactory: () => 'op-1',
  });
  const pending = registry.begin({
    tabId: 'tab-1',
    terminalToken: terminalA,
    fromCwd: '/old',
    targetCwd: '/new',
  });

  assert.equal(registry.observe({ tabId: 'tab-1', terminalToken: terminalB, cwd: '/new' }).matched, false);
  assert.equal(registry.observe({ tabId: 'tab-1', terminalToken: terminalA, cwd: '/other' }).matched, false);
  assert.equal(registry.snapshot('tab-1').operationId, 'op-1');
  assert.equal(registry.observe({
    tabId: 'tab-1',
    terminalToken: terminalA,
    cwd: '/new',
    persisted: true,
  }).matched, true);

  assert.deepEqual(await pending.promise, {
    operationId: 'op-1',
    fromCwd: '/old',
    targetCwd: '/new',
    waitedMs: 0,
    success: true,
    accepted: true,
    cwd: '/new',
    proof: 'live-process-osc7',
    persisted: true,
  });
  assert.equal(registry.snapshot('tab-1'), null);
});

test('a newer operation deterministically cancels the older one', async () => {
  let id = 0;
  const terminal = {};
  const registry = new TerminalCwdChangeProofRegistry({
    now: () => 200,
    setTimer: () => 1,
    clearTimer: () => {},
    idFactory: () => `op-${++id}`,
  });
  const first = registry.begin({ tabId: 'tab-1', terminalToken: terminal, targetCwd: '/one' });
  const second = registry.begin({ tabId: 'tab-1', terminalToken: terminal, targetCwd: '/two' });

  assert.equal((await first.promise).error, 'superseded');
  registry.observe({ tabId: 'tab-1', terminalToken: terminal, cwd: '/two' });
  assert.equal((await second.promise).cwd, '/two');
});

test('timeout is a diagnostic failure and never fabricates cwd success', async () => {
  let timeoutCallback = null;
  const registry = new TerminalCwdChangeProofRegistry({
    now: () => 300,
    setTimer: (callback) => { timeoutCallback = callback; return 1; },
    clearTimer: () => {},
  });
  const pending = registry.begin({
    tabId: 'tab-1',
    terminalToken: {},
    fromCwd: '/old',
    targetCwd: '/new',
  });
  timeoutCallback();
  const result = await pending.promise;
  assert.equal(result.success, false);
  assert.equal(result.error, 'cwd_change_proof_timeout');
  assert.equal(result.cwd, undefined);
});
