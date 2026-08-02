import test from 'node:test';
import assert from 'node:assert/strict';
import {
  directoryChangeEventNames,
  planWorkingDirectoryChange,
} from './workingDirectoryChange.mjs';

test('plain shell tab only changes cwd', () => {
  assert.deepEqual(planWorkingDirectoryChange({}), {
    supportedTool: false,
    waitForTurn: false,
    stopProcess: false,
    restartMode: 'none',
    requiresConfirmation: false,
  });
});

test('busy materialized Claude waits, stops, and continues through a fork', () => {
  assert.deepEqual(planWorkingDirectoryChange({
    toolType: 'claude',
    sessionId: 'session-a',
    presenceStatus: 'busy',
    conversationMaterialized: true,
  }), {
    supportedTool: true,
    waitForTurn: true,
    stopProcess: true,
    restartMode: 'fork',
    requiresConfirmation: true,
  });
});

test('stopped saved Codex restarts in a fork while an empty stopped session stays stopped', () => {
  assert.equal(planWorkingDirectoryChange({
    toolType: 'codex',
    sessionId: 'session-a',
    presenceStatus: 'inactive',
    conversationMaterialized: true,
  }).restartMode, 'fork');
  assert.equal(planWorkingDirectoryChange({
    toolType: 'codex',
    sessionId: 'session-a',
    presenceStatus: 'inactive',
    conversationMaterialized: false,
  }).restartMode, 'none');
});

test('live session without a saved conversation restarts fresh', () => {
  assert.equal(planWorkingDirectoryChange({
    toolType: 'claude',
    presenceStatus: 'active',
  }).restartMode, 'fresh');
});

test('wait channels are provider-specific and include process finish', () => {
  assert.deepEqual(directoryChangeEventNames('codex'), [
    'codex:busy-state',
    'terminal:command-finished',
  ]);
  assert.deepEqual(directoryChangeEventNames('claude'), [
    'claude:busy-state',
    'claude:turn-state',
    'terminal:command-finished',
  ]);
});
