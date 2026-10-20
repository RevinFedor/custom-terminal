import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { webcrypto } from 'node:crypto';
import { transformSync } from 'esbuild';
import * as sessionStarting from './sessionStartingState.mjs';
import * as goalAdapter from './codexGoalDesktopAdapter.mjs';

// Browser crypto is available in the actual Electron renderer. Electron28's
// Node-mode host lacks that global; supply the same standard API in this fixture.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const source = fs.readFileSync(process.env.NOTED_GOAL_HOOK_SOURCE
  || new URL('../components/Workspace/useAgentLifecycle.ts', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Executes the complete hook and all its real event handlers. React scheduling,
// store, presence and IPC are finite controlled ports, not a mounted renderer.
function host() {
  const cells = [], effects = [], calls = [];
  let cursor = 0, dirty = false, targetId = 'T', output;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => value === b[i]);
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], next => { const value = typeof next === 'function' ? next(cells[index]) : next;
        if (!Object.is(value, cells[index])) { cells[index] = value; dirty = true; } }];
    },
    useRef(initial) { const index = cursor++; return cells[index] ||= { current: initial }; },
    useMemo(fn, deps) { const index = cursor++; if (!same(cells[index]?.deps, deps)) cells[index] = { deps, value: fn() }; return cells[index].value; },
    useCallback(fn, deps) { return hooks.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const index = cursor++; if (!same(cells[index]?.deps, deps)) {
      const old = cells[index]; cells[index] = { deps, cleanup: old?.cleanup };
      effects.push(() => { old?.cleanup?.(); cells[index].cleanup = fn(); });
    } },
  };
  const ipc = new EventEmitter();
  let current = { ok: true, tabId: 'T', operationId: 'op', status: 'available', currentOperation: true, runtimeLive: true,
    owner: { sessionId: 'S' }, availableActions: ['resume', 'leave-paused'] };
  let heldApply;
  ipc.invoke = async (channel, request) => {
    calls.push({ channel, request });
    if (channel === 'codex:read-goal-action') return { ...current, ...(request.requestId ? { requestId: request.requestId } : {}) };
    if (channel === 'codex:apply-goal-action') return new Promise(resolve => { heldApply = () => {
      current = { ...current, ...request, status: 'pending', availableActions: [], accepted: true };
      resolve(current);
    }; });
    if (channel === 'agent:get-stopping-state') return { stopping: false };
    if (channel === 'agent:get-launch-preparation-state') return { state: null };
    throw new Error('Unexpected IPC ' + channel);
  };
  const tab = id => ({ id, tabType: 'terminal', commandType: 'codex', codexSessionId: id === 'T' ? 'S' : 'other-session' });
  const store = { openProjects: new Map([['P', { tabs: new Map([['T', tab('T')], ['other', tab('other')]]) }]]) };
  const useWorkspaceStore = select => select(store); useWorkspaceStore.getState = () => store;
  const presence = async id => ({ status: 'active', manualActionRequired: true, inputReady: false,
    lastNotReady: { reason: 'codex_resume_goal_action_required', blockers: ['resume-goal'], operationId: id === 'T' ? 'op' : 'other-op' } });
  const modules = {
    react: hooks, '../../store/useWorkspaceStore': { useWorkspaceStore },
    '../../utils/historyAgentRuntimes': { getHistoryAgentRuntime: () => ({ getPresence: presence }) },
    '../../utils/sessionStartingState.mjs': sessionStarting,
    '../../utils/claudeStartupDefaultsGate': {}, '../../utils/claudeStartupFailure.mjs': {},
    '../../utils/ptyAgentOwner.mjs': { resolvePtyAgentOwner: () => 'codex' },
    '../../utils/codexSurfaceReadIdentityStore.mjs': { publishCodexSurfaceReadIdentity() {}, clearCodexSurfaceReadIdentity() {} },
    '../../utils/interruptedAutoRestore.mjs': { reconcileRestoredInterruptedTab() {} },
    '../../utils/codexGoalDesktopAdapter.mjs': goalAdapter,
  };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, require: name => { assert.ok(modules[name], name); return modules[name]; },
    window: { require: () => ({ ipcRenderer: ipc }), addEventListener() {}, removeEventListener() {} },
    console: { warn() {} },
  });
  const render = () => { cursor = 0; dirty = false; output = module.exports.useAgentLifecycle({ projectId: 'P', tabId: targetId, enabled: true });
    for (const effect of effects.splice(0)) effect(); };
  async function settle() { for (let i = 0; i < 12; i++) { if (dirty) render(); await tick(); if (!dirty) return; } assert.fail('hook did not settle'); }
  render();
  return { calls, ipc, settle, get output() { return output; }, release() { heldApply(); },
    switchTab(id) { targetId = id; render(); }, cleanup() { for (const cell of cells) cell?.cleanup?.(); } };
}

test('actual complete lifecycle hook exposes Goal callbacks, synchronous double-click guard and persistent presentation dismiss', async () => {
  const h = host(); await h.settle();
  h.ipc.emit('codex:tui-manual-action-required', null, { tabId: 'T', type: 'resume-goal' }); await h.settle();
  assert.equal(h.output.kind, 'info'); assert.equal(h.output.spinner, false);
  assert.ok(h.output.goalActions, 'Goal must expose Main-authorized choices');
  assert.deepEqual(h.output.goalActions.availableActions, ['resume', 'leave-paused']);
  const click = h.output.goalActions.onChoose;
  click('resume'); click('resume'); await h.settle();
  assert.deepEqual(h.output.goalActions.availableActions, []);
  const request = h.calls.find(call => call.channel === 'codex:apply-goal-action').request;
  assert.equal(request.tabId, 'T'); assert.equal(request.operationId, 'op'); assert.equal(request.action, 'resume');
  assert.ok(request.requestId);
  h.release(); await h.settle();
  h.output.onDismiss(); await h.settle(); assert.equal(h.output, null);
  h.ipc.emit('codex:busy-state', null, { tabId: 'T', busy: true }); await h.settle();
  assert.equal(h.output, null);
  assert.equal(h.calls.filter(call => call.channel === 'codex:apply-goal-action').length, 1);
  assert.ok(h.calls.some(call => call.channel === 'codex:read-goal-action' && call.request.requestId === request.requestId));
  h.cleanup(); assert.equal(h.ipc.eventNames().length, 0);
});

test('actual hook discards old Goal state and callback after target switch', async () => {
  const h = host(); await h.settle();
  h.ipc.emit('codex:tui-manual-action-required', null, { tabId: 'T', type: 'resume-goal' }); await h.settle();
  assert.ok(h.output?.goalActions, 'Goal must expose Main-authorized choices');
  const click = h.output.goalActions.onChoose;
  h.switchTab('other'); await h.settle();
  click('leave-paused'); await h.settle();
  assert.equal(h.calls.filter(call => call.channel === 'codex:apply-goal-action').length, 0);
  assert.notEqual(h.output?.tabId, 'T'); assert.equal(h.output?.goalActions, undefined);
  h.cleanup(); assert.equal(h.ipc.eventNames().length, 0);
});
