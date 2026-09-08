'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createCodexSubmitDropTestFault } = require('./codex-submit-drop-test-fault');

test('fault ignores two keys of one exact attempt, never another prompt or process', () => {
  const terminal = {};
  let owner = { terminal, runSeq: 1, lifecycleGeneration: 'p:1' };
  const fault = createCodexSubmitDropTestFault({ enabled: true, getIdentity: () => owner });
  assert.equal(fault.configure({ tabId: 't', count: 2 }).success, true);
  const audit = {};
  assert.equal(fault.consume('t', terminal, '\r', audit, 'initial'), true);
  assert.equal(fault.consume('t', terminal, '\r', {}, 'initial'), false);
  assert.equal(fault.consume('t', terminal, 'text', audit, 'paste'), false);
  assert.equal(fault.consume('t', terminal, '\r', audit, 'retry'), true);
  assert.equal(fault.consume('t', terminal, '\r', audit, 'retry'), false);
  fault.configure({ tabId: 't' });
  owner = { ...owner, runSeq: 2 };
  assert.equal(fault.consume('t', terminal, '\r', audit, 'initial'), false);
  const disabled = createCodexSubmitDropTestFault({ getIdentity: () => owner });
  assert.equal(disabled.configure({ tabId: 't' }).error, 'test_hook_disabled');
  assert.equal(disabled.consume('t', terminal, '\r', audit, 'initial'), false);
});
