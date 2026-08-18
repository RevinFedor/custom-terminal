import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveHistoryTerminalActivityAction } from './historyTerminalActivityAction.mjs';

test('terminal activity click never turns an unavailable lifecycle action into copy', () => {
  assert.equal(resolveHistoryTerminalActivityAction({}), 'pending');
  assert.equal(resolveHistoryTerminalActivityAction({ canStartOrResume: true }), 'start');
  assert.equal(resolveHistoryTerminalActivityAction({ canStopProcess: true }), 'stop');
  assert.equal(resolveHistoryTerminalActivityAction({ canInterruptTurn: true }), 'stop');
});

test('stop keeps precedence while lifecycle inputs converge', () => {
  assert.equal(resolveHistoryTerminalActivityAction({
    canInterruptTurn: true,
    canStopProcess: true,
    canStartOrResume: true,
  }), 'stop');
});
