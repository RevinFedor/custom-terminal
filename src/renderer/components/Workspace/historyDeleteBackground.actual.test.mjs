import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createHistoryMutationInputGate } from '../../../main/history-mutation-input.js';
import { beginHistoryOperationActivity, getHistoryOperationActivities,
  dismissHistoryOperationActivity } from '../../utils/historyOperationActivity.mjs';

const source = fs.readFileSync(new URL('./Timeline.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('Timeline.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function actual(name) {
  let found;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, name);
  return ts.transpileModule('const ' + found.getText(ast) + ';', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function fixture(options = {}) {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const ref = { current: 'source-A' };
  const binding = { current: 'source-A' };
  const terminalToken = {};
  const gate = createHistoryMutationInputGate({ capture: () => ({ terminalToken,
    projectId: 'P', cwd: '/source', toolType: 'codex', sessionId: binding.current, inputRevision: 0 }),
    log: { log() {} } });
  const toasts = [];
  const setters = Object.fromEntries(['setSelectionStartId', 'setContextMenu', 'setRangeActionMenu',
    'setDeleteConfirmMode', 'setDeleteEntryConfirmMode', 'setDeletingRange', 'setDeletingPhase'].map(key => [key, () => {}]));
  const context = vm.createContext({ ...setters, console: { log() {}, warn() {}, error() {} },
    sessionId: 'source-A', sessionIdRef: ref, tabId: 'A', cwd: '/source', isCodex: true, toolType: 'codex',
    supportsDeleteRangeActions: true, historyDeleteUiBlocked: false, rejectBlockedHistoryMutation: () => false,
    selectionStartIdRef: { current: null }, beginHistoryOperationActivity,
    getCodexHistoryMutationSettingsProof: () => null,
    useUIStore: { getState: () => ({ showToast: (...args) => toasts.push(args) }) },
    useWorkspaceStore: { getState: () => ({ getCodexSessionId: () => binding.current }) },
    adoptAndRestartCodexHistory: async (child, _reason, _settings, proof) => {
      calls.push(['adopt', child]);
      if (options.failAdopt) throw Error('controlled binding failure');
      binding.current = child; gate.bound(proof, child);
      gate.assert('A', proof, { action: 'resume', sessionId: child });
    },
    ipcRenderer: { invoke: async (channel, args) => {
      calls.push([channel, args]);
      if (channel === 'history-mutation:begin') return gate.reserve(args);
      if (channel === 'history-mutation:finish') return gate.finish(args);
      if (channel === 'codex:delete-range' && args.validateOnly) return pending;
      if (channel === 'terminal:getCommandState') return { isRunning: true };
      if (channel === 'terminal:stop-ai-process') return { success: true };
      if (channel === 'codex:delete-range') return { success: true, newSessionId: 'child-A', removedUsers: 1, removedCount: 3 };
      throw new Error('unexpected ' + channel);
    } },
  });
  vm.runInContext(actual('stopCodexForHistoryMutation') + actual('executeDeleteRange')
    + '\nthis.execute = executeDeleteRange;', context);
  return { ref, binding, calls, toasts, release, gate, execute: () => context.execute({ startIndex: 0, endIndex: 0 }, 'target-A', 'target-A') };
}

test('actual Delete continues in the background with its original source, not the reused Timeline ref', async () => {
  const f = fixture();
  const work = f.execute();
  assert.equal(getHistoryOperationActivities()[0].status, 'running');
  await f.execute();
  assert.equal(f.calls.filter(([channel]) => channel === 'history-mutation:begin').length, 1, 'second click cannot allocate a second operation');
  f.ref.current = 'source-B'; // window navigated/reused its Timeline while IO was pending
  f.release({ success: true });
  await work;
  const writes = f.calls.filter(([channel, args]) => channel === 'codex:delete-range' && !args.validateOnly);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1].sessionId, 'source-A');
  assert.equal(f.calls.find(([channel]) => channel === 'terminal:stop-ai-process')[1].tabId, 'A');
  assert.equal(getHistoryOperationActivities()[0].status, 'done');
  assert.equal(f.toasts[0][7], 'A');
  dismissHistoryOperationActivity(getHistoryOperationActivities()[0].id);
});

test('actual failing preflight reports failure in background, without Stop, rewrite or adoption', async () => {
  const f = fixture();
  const work = f.execute();
  f.ref.current = 'source-B';
  f.release({ success: false, error: 'Selected Codex user turn has no exact rollout identity' });
  await work;
  assert.equal(f.calls.some(([channel]) => channel === 'terminal:stop-ai-process'), false);
  assert.equal(f.calls.filter(([channel, args]) => channel === 'codex:delete-range' && !args.validateOnly).length, 0);
  assert.equal(f.gate.held('A'), false);
  assert.equal(getHistoryOperationActivities()[0].status, 'failed');
  assert.match(getHistoryOperationActivities()[0].message, /no exact rollout identity/);
  assert.equal(f.toasts[0][7], 'A', 'full incident stays on its source, not the currently visible tab');
  assert.equal(f.toasts[0][3], true, 'error remains available');
  dismissHistoryOperationActivity(getHistoryOperationActivities()[0].id);
});

test('actual committed COW + failed adoption preserves child ID, does not Resume source, releases exact reservation', async () => {
  const f = fixture({ failAdopt: true });
  const work = f.execute();
  f.release({ success: true }); await work;
  assert.equal(f.calls.filter(([channel, args]) => channel === 'codex:delete-range' && !args.validateOnly).length, 1);
  assert.equal(f.calls.some(([channel]) => channel === 'codex:run-command'), false);
  assert.match(f.toasts[0][0], /child-A/);
  assert.equal(f.gate.held('A'), false);
  assert.equal(f.binding.current, 'source-A');
  dismissHistoryOperationActivity(getHistoryOperationActivities()[0].id);
});

test('a real binding change is refused, unlike merely navigating to another tab', async () => {
  const f = fixture();
  const work = f.execute();
  f.binding.current = 'different-writer';
  f.release({ success: true });
  await work;
  assert.equal(f.calls.some(([channel]) => channel === 'terminal:stop-ai-process'), false);
  assert.equal(f.calls.some(([channel, args]) => channel === 'codex:delete-range' && !args.validateOnly), false);
  assert.equal(getHistoryOperationActivities()[0].status, 'failed');
  dismissHistoryOperationActivity(getHistoryOperationActivities()[0].id);
});
