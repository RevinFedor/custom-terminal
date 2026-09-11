import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentBusyPresentation } from './agentBusyPresentation.mjs';

test('a local end can leave the tab busy without changing the outcome event', () => {
  const event = Object.freeze({ busy: false, activityBusy: true, reason: 'local-command' });
  assert.equal(resolveAgentBusyPresentation(event), true);
  assert.equal(event.busy, false);
});

test('an explicit false aggregate is not replaced by a true operation edge', () => {
  assert.equal(resolveAgentBusyPresentation({ busy: true, activityBusy: false }), false);
});

test('normal turn/Stop edges and other providers retain their existing contract', () => {
  assert.equal(resolveAgentBusyPresentation({ busy: true }), true);
  assert.equal(resolveAgentBusyPresentation({ busy: false, reason: 'manual-stop' }), false);
  assert.equal(resolveAgentBusyPresentation({ busy: true, activityBusy: undefined }), true);
  assert.equal(resolveAgentBusyPresentation(null), false);
});
