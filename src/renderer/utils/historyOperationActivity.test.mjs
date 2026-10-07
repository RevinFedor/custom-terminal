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

test('background follows visible window contents, not focus, and navigation uses the operation owner', async () => {
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
  state.openTabById = async (tabId, options) => {
    calls.push([tabId, options]);
    return tabId === 'A';
  };
  assert.equal(await openHistoryOperationOwner(state, 'A'), true);
  assert.deepEqual(calls, [['A', { reason: 'history-operation-owner' }]]);
  assert.equal(await openHistoryOperationOwner(state, 'missing'), false);
});

test('owner wrapper forwards legacy load hints and waits for the root result even without a local record', async () => {
  let resolve;
  const calls = [];
  const state = { openTabById: (id, options) => {
    calls.push([id, options]);
    return new Promise(done => { resolve = done; });
  } };
  let finished = false;
  const opening = openHistoryOperationOwner(state, 'unloaded', { projectId: 'legacy', reason: 'recording-owner' })
    .then(result => { finished = true; return result; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.deepEqual(calls, [['unloaded', { projectId: 'legacy', reason: 'recording-owner' }]]);
  resolve(false);
  assert.equal(await opening, false);
});
