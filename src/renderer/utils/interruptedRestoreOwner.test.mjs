import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import * as restore from './interruptedAutoRestore.mjs';
import { createAgentLaunchAdmission } from './agentLaunchAdmission.mjs';
import { resolvePtyAgentOwner } from './ptyAgentOwner.mjs';
import { createLaunchFixture, assertOnlyFenceObservers } from './agentLaunchFixture.mjs';
const require = createRequire(import.meta.url);
const { waitForAgentReadyTransition, READINESS_CHANGED_EVENT } = require('../../main/agent-ready-wait');
const source = fs.readFileSync(new URL('./continueInterruptedSession.ts', import.meta.url), 'utf8');
// Execute the actual restore body and source checker. Replace module loading,
// Store publication and provider IPC only; the launch helper and ready owner
// remain real. No readiness result is manufactured at the invoke boundary.
const compiled = stripTypeScriptTypes(source.slice(source.indexOf('const resumeInflight')))
  .replace(/^export /gm, '')
  .replace("import('../store/useWorkspaceStore')", '__workspace()')
  + '\n({ continueInterruptedSession })';
const workspace = fs.readFileSync(new URL('../store/useWorkspaceStore.ts', import.meta.url), 'utf8');
const interruptedSource = workspace.match(/export const isTabInterrupted = [\s\S]*?\n};/)?.[0];
assert.ok(interruptedSource, 'actual Store interrupted predicate is present');
const isTabInterrupted = vm.runInNewContext(stripTypeScriptTypes(interruptedSource.replace(/^export /, ''))
  + '\nisTabInterrupted');
function rendererFixture(ipcRenderer, engine, sessionId, pending = {}) {
  const subscriptions = new Set();
  const state = { openProjects: new Map([['P', { projectPath: '/fixture', tabs: new Map([['T', {
    [engine + 'SessionId']: sessionId, commandType: engine, wasInterrupted: true, cwd: '/fixture',
  }]]) }]]) };
  const useWorkspaceStore = { getState: () => state, subscribe: callback => {
    subscriptions.add(callback); return () => subscriptions.delete(callback);
  } };
  const api = vm.runInNewContext(compiled, {
    console: { log() {}, warn() {} }, AbortController, ipcRenderer,
    terminalRegistry: { get: () => null },
    markPendingResume() {}, clearPendingResume() {}, ...pending,
    buildCodexRunPayload: value => value, createAgentLaunchAdmission, resolvePtyAgentOwner, ...restore,
    __workspace: async () => ({ useWorkspaceStore, isTabInterrupted }),
  });
  return { ...api, subscriptions };
}

test('actual renderer empty restore clears only the old UUID guard, then retires interruption after ready', async () => {
  const sequence = [];
  const bus = new EventEmitter();
  const { ipcRenderer } = createLaunchFixture(async (name, request) => {
    sequence.push(name);
    if (name === 'claude:get-presence') return { status: 'inactive', liveLifecycle: false };
    if (name === 'claude:run-command') return {
      success: true, accepted: true, restoredEmptySessionId: 'empty-S',
      launchId: 'fresh-L', sessionId: null,
    };
    assert.equal(name, 'agent:wait-start-ready');
    assert.equal(request.expectedOwner.launchId, 'fresh-L');
    assert.ok(sequence.includes('release-old-uuid'));
    assert.equal(sequence.includes('clear-interrupted'), false);
    const status = await waitForAgentReadyTransition({ tabId: 'T', eventBus: bus,
      expectedOwner: request.expectedOwner, readStatus: async () => ({ status: 'active', inputReady: true,
        liveLifecycle: true, launchGeneration: 'fresh-L', sessionId: 'fresh-S' }) });
    return { success: true, ready: true, status };
  });
  const api = rendererFixture(ipcRenderer, 'claude', 'empty-S', {
    markPendingResume: () => sequence.push('arm-old-uuid'),
    clearPendingResume: () => sequence.push('release-old-uuid'),
  });
  const result = await api.continueInterruptedSession({ tabId: 'T', projectId: 'P',
    sessionId: 'empty-S', engine: 'claude', cwd: '/fixture', clearInterruptedState: () => sequence.push('clear-interrupted') });
  assert.equal(result.ready, true);
  assert.equal(sequence.at(-1), 'clear-interrupted');
  assert.equal(sequence.filter(value => value === 'claude:run-command').length, 1);
  assert.equal(api.subscriptions.size, 0);
  assertOnlyFenceObservers(ipcRenderer);
});

for (const engine of ['claude', 'codex']) for (const joining of [false, true]) for (const replacement of ['other-session', 'same-session-new-launch', 'same-launch-child']) {
  test(`actual ${engine} restore ${joining ? 'joining' : 'new'} wait: ${replacement}`, async () => {
    const bus = new EventEmitter();
    const calls = [];
    let cleared = 0;
    let state = joining
      ? { success: true, liveLifecycle: true, sessionStatus: 'starting', status: 'starting',
          inputReady: false, sessionId: 'S', provenWriterSessionId: 'S', launchId: 'L1', lifecycleGeneration: 'G1' }
      : { success: true, liveLifecycle: false, sessionStatus: 'inactive', status: 'inactive', inputReady: false };
    const { ipcRenderer } = createLaunchFixture(async (name, request) => {
      calls.push({ name, request });
      if (name === (engine === 'codex' ? 'codex:get-runtime-projection' : 'claude:get-presence')) return state;
      if (name === engine + ':run-command') {
        state = { success: true, liveLifecycle: true, status: 'starting', sessionStatus: 'starting',
          inputReady: false, launchId: 'L1', lifecycleGeneration: 'G1', sessionId: 'S', provenWriterSessionId: 'S' };
        return { success: true, accepted: null, acceptancePending: true,
          ...(engine === 'claude' ? { launchGeneration: 'L1' } : { launchId: 'L1', lifecycleGeneration: 'G1' }) };
      }
      assert.equal(name, 'agent:wait-start-ready');
      assert.equal(request.expectedOwner.launchId, 'L1');
      assert.equal(request.expectedOwner.lifecycleGeneration, engine === 'codex' ? 'G1' : undefined);
      const waiting = waitForAgentReadyTransition({ tabId: 'T', readStatus: async () => state,
        eventBus: bus, expectedOwner: request.expectedOwner });
      const mapped = waiting.then(status => ({ success: true, ready: true, status }),
        error => ({ success: false, ready: false, error: error.code, status: error.status }));
      await new Promise(resolve => setImmediate(resolve));
      const sameLaunch = replacement === 'same-launch-child';
      state = { success: true, liveLifecycle: true, status: 'busy', sessionStatus: 'busy', inputReady: true,
        sessionId: replacement === 'other-session' ? 'B' : sameLaunch ? 'child' : 'S',
        provenWriterSessionId: replacement === 'other-session' ? 'B' : sameLaunch ? 'child' : 'S',
        launchId: sameLaunch ? 'L1' : 'L2', lifecycleGeneration: sameLaunch && engine === 'codex' ? 'G1' : 'G2' };
      bus.emit(READINESS_CHANGED_EVENT, null, { tabId: 'T' });
      return mapped;
    });
    const api = rendererFixture(ipcRenderer, engine, 'S');
    const result = await api.continueInterruptedSession({ tabId: 'T', projectId: 'P', sessionId: 'S',
      engine, cwd: '/fixture', clearInterruptedState: () => { cleared += 1; } });
    const valid = replacement === 'same-launch-child';
    assert.equal(result.success, valid);
    assert.equal(cleared, valid ? 1 : 0);
    if (!valid) assert.equal(result.error, 'agent_ready_owner_changed');
    assert.equal(calls.filter(c => c.name === engine + ':run-command').length, joining ? 0 : 1);
    assert.equal(bus.listenerCount(READINESS_CHANGED_EVENT), 0);
    assert.equal(api.subscriptions.size, 0);
    assertOnlyFenceObservers(ipcRenderer);
  });
}
