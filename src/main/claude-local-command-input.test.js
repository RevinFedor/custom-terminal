'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  advanceClaudeLocalCommandInputState,
} = require('./claude-local-command-input');

function owner(overrides = {}) {
  return {
    terminal: overrides.terminal || {},
    sessionId: overrides.sessionId || 'session-a',
    generation: overrides.generation || 'launch-1',
    promptSeq: overrides.promptSeq ?? 4,
  };
}

test('exact compact is emitted only when Enter belongs to the same prompt generation', () => {
  const currentOwner = owner();
  const typed = advanceClaudeLocalCommandInputState(null, {
    data: '/compact',
    owner: currentOwner,
  });
  assert.deepEqual(typed.submittedCommands, []);
  assert.equal(typed.state.text, '/compact');

  const submitted = advanceClaudeLocalCommandInputState(typed.state, {
    data: '\r',
    owner: currentOwner,
  });
  assert.deepEqual(submitted.submittedCommands, ['/compact']);
  assert.equal(submitted.state, null);
});

test('a returned Claude prompt invalidates an unobserved older slash line', () => {
  const terminal = {};
  const oldPrompt = owner({ terminal, promptSeq: 3 });
  const newPrompt = owner({ terminal, promptSeq: 9 });
  const model = advanceClaudeLocalCommandInputState(null, {
    data: '/model',
    owner: oldPrompt,
  });

  const compact = advanceClaudeLocalCommandInputState(model.state, {
    data: '/compact',
    owner: newPrompt,
  });
  assert.equal(compact.reason, 'owner-reset');
  assert.equal(compact.state.text, '/compact');

  const submitted = advanceClaudeLocalCommandInputState(compact.state, {
    data: '\r',
    owner: newPrompt,
  });
  assert.deepEqual(submitted.submittedCommands, ['/compact']);
});

test('terminal protocol replies cannot append to or clear manual text', () => {
  const currentOwner = owner();
  const typed = advanceClaudeLocalCommandInputState(null, {
    data: '/compact',
    owner: currentOwner,
  });
  const protocol = advanceClaudeLocalCommandInputState(typed.state, {
    data: '\x1b[24;1R',
    owner: currentOwner,
    isTerminalProtocolResponse: true,
  });
  assert.equal(protocol.state.text, '/compact');
  assert.deepEqual(protocol.submittedCommands, []);
});

test('typing without Enter and a failed owner generation never submits', () => {
  const terminal = {};
  const typedOwner = owner({ terminal, generation: 'launch-1' });
  const nextOwner = owner({ terminal, generation: 'launch-2' });
  const typed = advanceClaudeLocalCommandInputState(null, {
    data: '/compact',
    owner: typedOwner,
  });
  assert.deepEqual(typed.submittedCommands, []);

  const enter = advanceClaudeLocalCommandInputState(typed.state, {
    data: '\r',
    owner: nextOwner,
  });
  assert.deepEqual(enter.submittedCommands, []);
  assert.equal(enter.state, null);
});

test('bracketed paste, editing controls and escape sequences stay deterministic', () => {
  const currentOwner = owner();
  let state = advanceClaudeLocalCommandInputState(null, {
    data: '\x1b[200~/compacx\x1b[201~',
    owner: currentOwner,
  }).state;
  state = advanceClaudeLocalCommandInputState(state, {
    data: '\x7ft',
    owner: currentOwner,
  }).state;
  state = advanceClaudeLocalCommandInputState(state, {
    data: '\x1b[A',
    owner: currentOwner,
  }).state;
  const submitted = advanceClaudeLocalCommandInputState(state, {
    data: '\r',
    owner: currentOwner,
  });
  assert.deepEqual(submitted.submittedCommands, ['/compact']);
});
