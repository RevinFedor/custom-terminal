import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import sendTargetContract from '../../shared/agent-send-target-precondition.cjs';

const preparation = fs.readFileSync(new URL('./agentSendPreparation.ts', import.meta.url), 'utf8');
const history = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../../main/main.js', import.meta.url), 'utf8');
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function harness(toolType = 'codex') {
  const ipcRenderer = new EventEmitter();
  const timers = new Map();
  let now = 0, serial = 0, resumes = 0, reads = 0, cancelled = false;
  let cancelWake;
  let state = { status: 'active', inputReady: false };
  const runtime = { toolType, label: toolType, readyEvent: toolType + ':tui-ready',
    getPresence: async () => { reads++; return { ...state }; },
    resume: async () => { resumes++; return { success: true }; },
  };
  const body = preparation.slice(preparation.indexOf('export function createAgentReadyWait('),
    preparation.indexOf('export async function proveAgentComposerForSend('));
  const api = vm.runInNewContext(stripTypeScriptTypes(body.replace(/\bexport /g, ''))
    + '\n({ createAgentReadyWait, prepareAgentRuntimeForSend })', {
    ...sendTargetContract,
    ipcRenderer, Date: { now: () => now }, console: { log() {}, warn() {} },
    setTimeout: (callback, ms) => { const id = ++serial; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    terminalRegistry: { get: () => ({}) },
    isCoordinatedAgentSendCancellationRequested: () => cancelled,
    createCoordinatedAgentSendCancellationWait: () => ({
      promise: new Promise(resolve => { cancelWake = resolve; }), cancel() {},
    }),
  });
  const providerContract = {
    classifySubmitCapability: p => p?.status === 'busy' ? 'queue' : p?.inputReady ? 'direct' : 'blocked',
    startupGateOwnsComposer: () => false, waitForStartupGate: async () => {},
  };
  return { ipcRenderer, timers, runtime,
    start: () => api.prepareAgentRuntimeForSend({ tabId: 'T', runtime, providerContract,
      sessionId: 'S', requestedStatusAtSend: 'active', coordinatedSendToken: 1 }),
    setState: value => { state = value; },
    cancel: () => { cancelled = true; cancelWake(); },
    expire: async () => { now = 30001; for (const timer of [...timers.values()]) timer.callback(); await tick(); },
    get reads() { return reads; }, get resumes() { return resumes; },
  };
}

for (const tool of ['codex', 'claude']) {
  test(tool + ': a live picker waits for current readiness, not another process-start event', async () => {
    const h = harness(tool);
    const result = h.start();
    await tick();
    const before = h.reads;
    h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'OTHER', toolType: tool });
    h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: tool === 'codex' ? 'claude' : 'codex' });
    await tick();
    assert.equal(h.reads, before, 'unrelated tab/provider cannot wake this owner');
    h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: tool, status: 'ready' });
    await tick();
    assert.ok(h.reads > before, 'wake re-reads; its ready label is not authority');
    assert.equal(h.resumes, 0);
    h.setState({ status: 'active', inputReady: true });
    h.ipcRenderer.emit('agent:readiness-changed', null, { tabId: 'T', toolType: tool });
    assert.equal((await result).submitCapability, 'direct');
    assert.equal(h.resumes, 0);
    assert.equal(h.ipcRenderer.eventNames().length, 0);
    assert.equal(h.timers.size, 0);
  });
}

test('deadline re-reads ready state even if its edge was lost; it is not a false refusal', async () => {
  const h = harness();
  const result = h.start();
  await tick();
  h.setState({ status: 'active', inputReady: true });
  await h.expire();
  assert.equal((await result).status, 'active');
  assert.equal(h.timers.size, 0);
});

test('a still-open menu times out with no launch or input; cancellation cleans all wake listeners', async () => {
  const h = harness();
  const result = assert.rejects(h.start(), /not ready|did not become ready/);
  await tick(); await h.expire(); await result;
  assert.equal(h.resumes, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.ipcRenderer.eventNames().length, 0);
  const c = harness();
  const cancelled = assert.rejects(c.start(), /cancelled/);
  await tick(); c.cancel(); await cancelled;
  assert.equal(c.ipcRenderer.eventNames().length, 0);
  assert.equal(c.timers.size, 0);
});

test('normal History Send leaves draft proof after readiness in the common scenario', () => {
  const match = history.match(/if \(([^\n]+)\) \{\s*const terminalDraft = await readTerminalDraft\('send-preflight'\)/);
  assert.ok(match, 'known early draft-read boundary');
  const shouldReadEarly = new Function('statusAtSend', 'recordWithoutReply', 'return ' + match[1]);
  assert.equal(shouldReadEarly('active', false), false, 'normal send must not read a picker as a composer');
  assert.equal(shouldReadEarly('active', true), true, 'record-context still protects the draft before its Stop');
  assert.match(history, /returnDraftOnConflict: true/);
  assert.match(history, /recoverAgentDraftTransferToHistory\(e\?\.draftTransfer \? e : sendFailureResult/);
});

test('main readiness changes wake both main and renderer waiters without synthesizing startup', () => {
  const begin = main.indexOf('function emitAgentReadinessChanged(');
  const end = main.indexOf('\nfunction publishClaudeStartupDefaultsGate(', begin);
  const calls = [];
  const emit = vm.runInNewContext(main.slice(begin, end) + '\nemitAgentReadinessChanged', {
    ipcMain: { emit: (...args) => calls.push(args) },
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => calls.push(args) } },
  });
  emit('T', { toolType: 'codex', source: 'codex-input-control-frame', status: 'ready' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'agent:readiness-changed-internal');
  assert.equal(calls[1][0], 'agent:readiness-changed');
  assert.equal(calls[1][1].tabId, 'T');
  assert.equal(calls[1][1].toolType, 'codex');
});
