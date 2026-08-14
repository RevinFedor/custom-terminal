import test from 'node:test';
import assert from 'node:assert/strict';
import { showAgentDraftScreenContradictionToast } from './agentDraftContradictionToast.mjs';

test('screen contradiction produces one persistent tab-scoped error', () => {
  const calls = [];
  const store = {
    toasts: [],
    showToast(...args) {
      calls.push(args);
      this.toasts.push({
        message: args[0],
        type: args[1],
        persistent: args[3],
        tabId: args[7],
        details: args[9],
      });
    },
  };

  assert.equal(showAgentDraftScreenContradictionToast(store, {
    tabId: 'tab-a',
    label: 'Claude',
  }).shown, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'error');
  assert.equal(calls[0][3], true);
  assert.equal(calls[0][7], 'tab-a');

  assert.equal(showAgentDraftScreenContradictionToast(store, {
    tabId: 'tab-a',
    label: 'Claude',
  }).reason, 'already-visible');
  assert.equal(calls.length, 1);

  assert.equal(showAgentDraftScreenContradictionToast(store, {
    tabId: 'tab-b',
    label: 'Claude',
  }).shown, true);
  assert.equal(calls.length, 2);
});
