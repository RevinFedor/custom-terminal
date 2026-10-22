'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistoryMutationInputGate } = require('./history-mutation-input');

function fixture(purpose = 'working-directory') {
  const terminal = {};
  let state = { terminalToken: terminal, projectId: 'p', cwd: '/a', toolType: 'codex',
    sessionId: 's', runSeq: 3, lifecycleGeneration: 't:3', inputRevision: 2,
    subjectId: 'subject', stopping: false, isRunning: false, processLookupUnknown: false };
  const gate = createHistoryMutationInputGate({ capture: () => ({ ...state }), log: { log() {}, warn() {} } });
  const proof = gate.reserve({ tabId: 'tab', operationId: 'move', toolType: 'codex', sessionId: 's', purpose });
  return { gate, proof, set: patch => { state = { ...state, ...patch }; } };
}

test('owned persisted cd checkpoint keeps the SAME FIFO hold through Resume', () => {
  const f = fixture();
  f.gate.beginDirectoryWrite(f.proof, { operationId: 'cd-1', targetCwd: '/b' });
  f.gate.assert('tab', f.proof, { toolType: 'cwd-change', action: 'directory' });
  f.gate.claimDirectoryWrite(f.proof, 'cd-1');
  assert.equal(f.gate.claimSend('tab'), null);
  f.set({ cwd: '/b', runSeq: 4, lifecycleGeneration: 't:4' });
  f.gate.commitDirectoryWrite(f.proof, { operationId: 'cd-1', cwd: '/b',
    success: true, accepted: true, persisted: true, proof: 'live-process-osc7' });
  assert.equal(f.gate.claimSend('tab'), null);
  f.gate.authorizeResume(f.proof, { command: 'codex-c', sessionId: 's' });
  f.gate.assert('tab', f.proof, { toolType: 'codex', sessionId: 's' });
});

test('history lease does not grant a directory-change capability', () => {
  const f = fixture('history');
  assert.throws(() => f.gate.beginDirectoryWrite(f.proof, { operationId: 'cd', targetCwd: '/b' }),
    /history_input_directory_unavailable/);
});

for (const [label, patch, outcome] of [
  ['foreign input', { inputRevision: 3 }, {}],
  ['replaced PTY', { terminalToken: {} }, {}],
  ['different binding', { sessionId: 'other' }, {}],
  ['different subject', { subjectId: 'other' }, {}],
  ['extra command', { runSeq: 5, lifecycleGeneration: 't:5' }, {}],
  ['unpersisted proof', {}, { persisted: false }],
  ['wrong operation', {}, { operationId: 'other' }],
]) test('directory checkpoint rejects ' + label + ' without releasing FIFO', () => {
  const f = fixture();
  f.gate.beginDirectoryWrite(f.proof, { operationId: 'cd', targetCwd: '/b' });
  f.gate.claimDirectoryWrite(f.proof, 'cd');
  f.set({ cwd: '/b', runSeq: 4, lifecycleGeneration: 't:4', ...patch });
  assert.throws(() => f.gate.commitDirectoryWrite(f.proof, { operationId: 'cd', cwd: '/b',
    success: true, accepted: true, persisted: true, proof: 'live-process-osc7', ...outcome }), /history_input_/);
  assert.equal(f.gate.claimSend('tab'), null);
});

test('manual Stop during cd revokes the pending checkpoint', () => {
  const f = fixture();
  f.gate.beginDirectoryWrite(f.proof, { operationId: 'cd', targetCwd: '/b' });
  f.gate.claimDirectoryWrite(f.proof, 'cd');
  f.gate.cancel('tab');
  f.set({ cwd: '/b', runSeq: 4, lifecycleGeneration: 't:4' });
  assert.throws(() => f.gate.commitDirectoryWrite(f.proof, { operationId: 'cd', cwd: '/b',
    success: true, accepted: true, persisted: true, proof: 'live-process-osc7' }), /history_input_/);
});

test('own Resume does not permit changing the execution subject', () => {
  const f = fixture();
  f.gate.authorizeResume(f.proof, { command: 'codex-c', sessionId: 's' });
  f.set({ runSeq: 4, lifecycleGeneration: 't:4', inputOwnerLaunchId: 'OWN' });
  f.gate.claimLaunch(f.proof, 'OWN', 4);
  f.set({ subjectId: 'replacement' });
  assert.throws(() => f.gate.assert('tab', f.proof, { toolType: 'codex', action: 'mutation' }), /owner_changed/);
  assert.equal(f.gate.claimSend('tab'), null);
});
