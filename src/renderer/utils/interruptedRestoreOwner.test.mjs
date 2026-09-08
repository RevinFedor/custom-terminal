import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import * as restore from './interruptedAutoRestore.mjs';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { waitForAgentReadyTransition, READINESS_CHANGED_EVENT } = require('../../main/agent-ready-wait');
const source = fs.readFileSync(new URL('./continueInterruptedSession.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;

for (const joining of [false, true]) for (const replacement of ['other-session', 'same-session-new-launch', 'same-launch-child']) {
  test(`actual restore ${joining ? 'joining' : 'new'} wait: ${replacement}`, async () => {
    const bus = new EventEmitter();
    const calls = [];
    let cleared = 0;
    let state = joining
      ? { success: true, liveLifecycle: true, sessionStatus: 'starting', status: 'starting',
          inputReady: false, provenWriterSessionId: 'S', launchId: 'L1', lifecycleGeneration: 'G1' }
      : { success: true, liveLifecycle: false, sessionStatus: 'inactive', status: 'inactive', inputReady: false };
    const getStore = () => ({ openProjects: new Map([['P', { tabs: new Map([['T', {
      codexSessionId: 'S', cwd: '/fixture',
    }]]) }]]) });
    const ipcRenderer = { invoke: async (name, request) => {
      calls.push({ name, request });
      if (name === 'codex:get-runtime-projection') return state;
      if (name === 'codex:run-command') {
        state = { success: true, liveLifecycle: true, status: 'starting', sessionStatus: 'starting',
          inputReady: false, launchId: 'L1', lifecycleGeneration: 'G1', provenWriterSessionId: 'S' };
        return { success: true, accepted: null, acceptancePending: true, launchId: 'L1', lifecycleGeneration: 'G1' };
      }
      assert.equal(name, 'agent:wait-start-ready');
      assert.equal(request.expectedOwner.launchId, 'L1');
      assert.equal(request.expectedOwner.lifecycleGeneration, 'G1');
      const waiting = waitForAgentReadyTransition({ tabId: 'T', readStatus: async () => state,
        eventBus: bus, expectedOwner: request.expectedOwner });
      const mapped = waiting.then(status => ({ success: true, ready: true, status }),
        error => ({ success: false, ready: false, error: error.code, status: error.status }));
      await new Promise(resolve => setImmediate(resolve));
      const sameLaunch = replacement === 'same-launch-child';
      state = { success: true, liveLifecycle: true, status: 'busy', sessionStatus: 'busy', inputReady: true,
        provenWriterSessionId: replacement === 'other-session' ? 'B' : sameLaunch ? 'child' : 'S',
        launchId: sameLaunch ? 'L1' : 'L2', lifecycleGeneration: sameLaunch ? 'G1' : 'G2' };
      bus.emit(READINESS_CHANGED_EVENT, null, { tabId: 'T' });
      return mapped;
    } };
    const exports = {};
    vm.runInNewContext(compiled, { exports, console: { log() {}, warn() {} },
      window: { require: () => ({ ipcRenderer }) },
      require: name => {
        if (name.endsWith('terminalRegistry')) return { terminalRegistry: { get: () => null } };
        if (name.endsWith('pendingResume')) return { markPendingResume() {}, clearPendingResume() {} };
        if (name.endsWith('codexLaunch')) return { buildCodexRunPayload: value => value };
        if (name.endsWith('interruptedAutoRestore.mjs')) return restore;
        if (name.endsWith('useWorkspaceStore')) return { useWorkspaceStore: { getState: getStore }, isTabInterrupted: () => true };
        throw Error('unexpected require ' + name);
      },
    });
    const result = await exports.continueInterruptedSession({ tabId: 'T', projectId: 'P', sessionId: 'S',
      engine: 'codex', clearInterruptedState: () => { cleared += 1; } });
    const valid = replacement === 'same-launch-child';
    assert.equal(result.success, valid);
    assert.equal(cleared, valid ? 1 : 0);
    if (!valid) assert.equal(result.error, 'agent_ready_owner_changed');
    assert.equal(calls.filter(c => c.name === 'codex:run-command').length, joining ? 0 : 1);
    assert.equal(bus.listenerCount(READINESS_CHANGED_EVENT), 0);
  });
}
