import test from 'node:test';
import assert from 'node:assert/strict';
import { beginHistoryOperationActivity, getHistoryOperationActivities,
  dismissHistoryOperationActivity, subscribeHistoryOperationActivities,
  historyOperationOwnerView, openHistoryOperationOwner } from './historyOperationActivity.mjs';

const workspaceState = () => ({
  view: 'workspace', activeProjectId: 'P', splitPanes: [],
  openProjects: new Map([['P', { currentView: 'terminal', tabs: new Map([
    ['A', { name: 'Source tab' }], ['B', { name: 'Other tab' }],
  ]) }]]),
  getEffectiveTabId: () => 'B',
});

test('operation survives owner unmount and completion never overwrites a newer operation', () => {
  const changes = [];
  const unsubscribe = subscribeHistoryOperationActivities(() => changes.push(getHistoryOperationActivities()));
  const first = beginHistoryOperationActivity({ tabId: 'A', kind: 'delete', sourceSessionId: 'source' });
  assert.ok(first);
  assert.equal(beginHistoryOperationActivity({ tabId: 'A', kind: 'rewind' }), null);
  unsubscribe(); // the owner surface went away; its promise still owns the operation
  first.setPhase('rewriting');
  assert.equal(getHistoryOperationActivities()[0].phase, 'rewriting');
  dismissHistoryOperationActivity(first.id);
  assert.equal(getHistoryOperationActivities()[0].status, 'running', 'dismiss is not cancellation');
  first.finish();
  assert.equal(getHistoryOperationActivities()[0].status, 'done');
  const next = beginHistoryOperationActivity({ tabId: 'A', kind: 'rewind' });
  first.finish('late failure');
  first.setPhase('stopping');
  dismissHistoryOperationActivity(first.id);
  assert.equal(getHistoryOperationActivities()[0].id, next.id);
  assert.equal(getHistoryOperationActivities()[0].status, 'running');
  next.finish('validation failed');
  assert.equal(getHistoryOperationActivities()[0].status, 'failed');
  dismissHistoryOperationActivity(next.id);
  assert.deepEqual(getHistoryOperationActivities(), []);
  assert.equal(changes.length, 1);
});

test('background follows visible window contents, not focus, and navigation uses the operation owner', () => {
  const state = workspaceState();
  assert.equal(historyOperationOwnerView(state, 'A').visible, false);
  state.splitPanes = [{ tabId: 'A' }, { tabId: 'B' }];
  assert.equal(historyOperationOwnerView(state, 'A').visible, true, 'unfocused source remains visible');
  state.splitPanes = [{ tabId: 'B', tabs: [{ tabId: 'A' }, { tabId: 'B' }] }];
  assert.equal(historyOperationOwnerView(state, 'A').visible, false, 'a hidden chip is not visible content');
  state.view = 'home';
  state.splitPanes = [{ tabId: 'A' }];
  assert.equal(historyOperationOwnerView(state, 'A').visible, false);
  const calls = [];
  for (const key of ['showWorkspace', 'setViewingSubAgent', 'switchTab', 'setProjectView']) {
    state[key] = (...args) => calls.push([key, ...args]);
  }
  assert.equal(openHistoryOperationOwner(state, 'A'), true);
  assert.deepEqual(calls, [['showWorkspace', 'P'], ['setViewingSubAgent', null],
    ['switchTab', 'P', 'A'], ['setProjectView', 'P', 'terminal']]);
  assert.equal(openHistoryOperationOwner(state, 'missing'), false);
});
