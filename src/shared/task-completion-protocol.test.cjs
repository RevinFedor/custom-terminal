'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cjs = require('./task-completion-protocol.cjs');

test('Loop completion protocol has one shared renderer/main carrier', async () => {
  const esm = await import('./task-completion-protocol.mjs');
  assert.equal(esm.LOOP_TASK_COMPLETION_PROTOCOL, cjs.LOOP_TASK_COMPLETION_PROTOCOL);
  assert.equal(cjs.hasTaskCompletionProtocol(cjs.LOOP_TASK_COMPLETION_PROTOCOL), true);
  assert.equal(cjs.hasTaskCompletionProtocol('ordinary request mentioning complete_task'), false);
});
