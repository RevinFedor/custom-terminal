import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { resolvePtyAgentOwner } from './ptyAgentOwner.mjs';

const require = createRequire(import.meta.url);
const { inspectClaudeThinkingPickerSnapshot, inspectClaudeThinkingProceedSnapshot } = require('../../main/claude-thinking-picker-state');
const { createAgentCurrentParamsReader } = require('../../main/agent-current-params');
const directory = path.dirname(new URL(import.meta.url).pathname);
const appSource = fs.readFileSync(path.join(directory, '../App.tsx'), 'utf8');
const parsedApp = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handlerNode;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsedApp) === 'handleWebBridge') handlerNode = node;
  ts.forEachChild(node, visit);
}
visit(parsedApp);
assert.ok(handlerNode?.initializer, 'actual public renderer bridge callback');
const handlerJS = ts.transpileModule('globalThis.handleWebBridge = ' + handlerNode.initializer.getText(parsedApp), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const mainSource = fs.readFileSync(path.join(directory, '../../main/main.js'), 'utf8');
const mainStart = mainSource.indexOf('// Toggle thinking mode reactively:');
const mainEnd = mainSource.indexOf('// Claude rewind through the native', mainStart);
assert.ok(mainStart > 0 && mainEnd > mainStart);

function nativeRuntime() {
  const state = { thinking: true, selected: true, picker: false, inputRevision: 1,
    runSeq: 1, lifecycle: 'G1', sessionId: 'S', processAlive: true, outputSeq: 1 };
  const writes = [];
  const handlers = new Map();
  const mirror = { writeSeq: 1, synchronizedFrameWaiters: new Set() };
  const terminal = { write(data) {
    writes.push(data);
    if (!state.processAlive) return;
    if (data === '\x1bt') { state.picker = !state.picker; state.selected = state.thinking; }
    if (data === '\x1b[A') state.selected = true;
    if (data === '\x1b[B') state.selected = false;
    if (data === '\r' && state.picker) { state.thinking = state.selected; state.picker = false; }
    if (data === '\x1b') state.picker = false;
    mirror.writeSeq = ++state.outputSeq;
  } };
  const terminals = new Map([['tab', terminal]]);
  const frame = () => ({ success: true, authoritativeFrameCommitted: true, writeSeq: state.outputSeq,
    lines: (state.picker ? ['Toggle thinking mode',
      `${state.selected ? '❯' : ' '} Enabled ${state.thinking ? '✔' : ''}`,
      `${!state.selected ? '❯' : ' '} Disabled ${!state.thinking ? '✔' : ''}`,
      'Enter to confirm · Esc to exit'] : ['❯']).map((text, row) => ({ text, row })) });
  const context = vm.createContext({
    require, path, srcMainDir: path.join(directory, '../../main'),
    terminals, claudeCtrlCDangerZone: new Map(),
    bridgeKnownSessions: { get: () => state.sessionId },
    terminalCommandState: { get: () => ({ isRunning: state.processAlive, runSeq: state.runSeq }) },
    getTerminalLifecycleGeneration: () => state.lifecycle,
    getTerminalInputRevision: () => state.inputRevision,
    bumpTerminalInputRevision: () => ++state.inputRevision,
    getHeadlessTerminalMirror: () => mirror,
    getHeadlessVisibleBufferSnapshot: frame,
    waitForHeadlessSynchronizedOutputClose: async () => ({ ready: true }),
    waitForCommittedSemanticFrame: async options => {
      options.trigger?.();
      const snapshot = options.readSnapshot();
      const inspection = options.inspectSnapshot(snapshot);
      return { ready: snapshot.writeSeq > options.afterWriteSeq && options.acceptInspection(inspection), snapshot, inspection,
        writeSeq: snapshot.writeSeq, observedFrames: 1 };
    },
    parseClaudeDraftFromVisibleSnapshot: () => ({ proofOutcome: 'absent' }),
    inspectClaudeThinkingPickerSnapshot, inspectClaudeThinkingProceedSnapshot,
    withPtyWriteLock: async (_terminal, work) => work(),
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    console: { log() {}, warn() {} },
  });
  vm.runInContext(mainSource.slice(mainStart, mainEnd), context);
  return { state, writes, terminals, context, invoke: (channel, ...args) => handlers.get(channel)?.({}, ...args) };
}

function harness({ remembered = false, native = nativeRuntime(), tab = {} } = {}) {
  const selectedTab = { id: 'tab', tabType: 'terminal', commandType: 'claude', claudeSessionId: 'S', cwd: '/fixture', ...tab };
  const replies = [];
  const calls = [];
  const updates = [];
  let override;
  const state = { openProjects: new Map([['project', { tabs: new Map([['tab', selectedTab]]) }]]),
    updateSDKState: (tabId, patch) => updates.push({ tabId, patch }) };
  const params = createAgentCurrentParamsReader({
    capture: () => ({ provider: 'claude', tabType: selectedTab.tabType, sessionId: native.state.sessionId,
      lifecycleGeneration: native.state.lifecycle, terminalRunSeq: native.state.runSeq, inputRevision: native.state.inputRevision }),
    isCurrent: () => true,
    readRuntime: async () => ({ toolType: 'claude', processStatus: native.state.processAlive ? 'found' : 'absent' }),
    readClaudeSettings: async ({ sessionId }) => ({ success: true, sessionId, model: 'opus', effort: 'high' }),
    readClaudeThinking: () => native.invoke('claude:get-thinking-state', 'tab'),
    readCodexSettings: () => assert.fail('not Codex'), readProviderState: () => ({}),
    readContext: () => null, readStoredChoices: () => ({}),
  });
  const context = vm.createContext({
    useWorkspaceStore: { getState: () => state }, resolvePtyAgentOwner,
    window: { __thinkStateForTab: new Map([['tab', remembered]]) },
    console: { log() {}, warn() {}, error() {} },
    applyClaudePtySetting: async () => ({ success: true }),
    ipcRenderer: {
      invoke: async (channel, ...args) => {
        calls.push({ channel, args });
        if (channel === 'agent:get-current-params') return params.read(args[0].tabId);
        if (channel === 'claude:toggle-thinking') return override ? override(...args) : native.invoke(channel, ...args);
        if (channel === 'claude:get-confirmed-settings') return { success: true, sessionId: selectedTab.claudeSessionId, model: 'opus', effort: 'high' };
        if (channel === 'claude:get-bridge-metadata') return {};
        if (channel === 'tab:get-context-pct') return {};
        return native.invoke(channel, ...args);
      },
      send: (channel, payload) => { assert.equal(channel, 'web:bridge-reply'); replies.push(payload); },
    },
  });
  vm.runInContext(handlerJS, context);
  return { native, calls, updates, context, selectedTab, setReply: fn => { override = fn; },
    async request(action, payload) {
      await context.handleWebBridge({}, { requestId: 'request', action, payload });
      assert.ok(replies.length); return replies.at(-1);
    } };
}

test('actual App callback + actual native picker do not flip an already enabled restarted process', async () => {
  const h = harness({ remembered: false });
  const result = await h.request('setSDKParams', { tabId: 'tab', thinking: 'adaptive' });
  assert.equal(h.native.state.thinking, true, 'old renderer false must not invert native true');
  assert.equal(result.ok, true);
  assert.equal(result.data.thinking, 'adaptive');
  assert.deepEqual(h.calls[0].args, ['tab', true]);
  assert.deepEqual(h.native.writes, ['\x1bt', '\x1b'], 'already enabled uses native proof and closes without Arrow/Enter');
});

test('a stale matching renderer value cannot skip a real native change', async () => {
  const h = harness({ remembered: true });
  h.native.state.thinking = false;
  const result = await h.request('setSDKParams', { tabId: 'tab', thinking: 'adaptive' });
  assert.equal(result.ok, true);
  assert.equal(h.native.state.thinking, true);
  assert.equal(result.data.thinking, 'adaptive');
  assert.equal(h.calls.filter(call => call.channel === 'claude:toggle-thinking').length, 1);
});

for (const response of [
  () => { throw Error('native failed'); },
  () => ({ success: false, error: 'picker unavailable' }),
  () => ({ success: true }),
  () => ({ success: true, thinking: false }),
]) {
  test('actual App callback does not echo success without matching native Thinking proof: ' + response.toString(), async () => {
    const h = harness();
    h.setReply(response);
    const result = await h.request('setSDKParams', { tabId: 'tab', thinking: 'adaptive' });
    assert.equal(result.ok, false);
    assert.match(result.error, /[Tt]hinking/);
    assert.equal(h.context.window.__thinkStateForTab.get('tab'), false, 'no optimistic cache write');
  });
}

test('cold Claude without a terminal reports failure rather than the desired value', async () => {
  const h = harness({ tab: { claudeSessionId: null } });
  h.native.terminals.delete('tab');
  assert.equal((await h.request('setSDKParams', { tabId: 'tab', thinking: 'disabled' })).ok, false);
});

test('SDK including DeepSeek preserves its separate state update without native picker calls', async () => {
  const h = harness({ tab: { tabType: 'claude-sdk', sdkProvider: 'deepseek', sdkModel: 'deepseek-v4' } });
  const result = await h.request('setSDKParams', { tabId: 'tab', thinking: 'disabled' });
  assert.equal(result.ok, true);
  assert.equal(h.updates[0].patch.sdkThinking, false);
  assert.deepEqual(h.calls, []);
});

test('GET ignores stale renderer memory and labels its compatible fallback without opening a picker', async () => {
  const h = harness({ remembered: false });
  const result = await h.request('getSDKParams', { tabId: 'tab' });
  assert.equal(result.ok, true);
  assert.equal(result.data.thinking, 'adaptive');
  assert.equal(result.data.thinkingKnown, false);
  assert.equal(result.data.thinkingSource, 'default-intent');
  assert.equal(result.data.thinkingProof, null);
  assert.deepEqual(h.native.writes, []);
});

test('GET reports the exact current picker proof and performs no extra native writes', async () => {
  const h = harness();
  const set = await h.request('setSDKParams', { tabId: 'tab', thinking: 'disabled' });
  assert.equal(set.ok, true);
  assert.equal(set.data.thinking, 'disabled');
  assert.equal(set.data.thinkingProof.source, 'native-thinking-picker');
  const writes = [...h.native.writes];
  const get = await h.request('getSDKParams', { tabId: 'tab' });
  assert.equal(get.data.thinkingKnown, true);
  assert.equal(get.data.thinking, 'disabled');
  assert.equal(get.data.thinkingProof.lifecycleGeneration, 'G1');
  assert.equal(get.data.thinkingProof.inputRevision, h.native.state.inputRevision);
  assert.deepEqual(h.native.writes, writes);
});

test('native external input invalidates current proof; explicit selection recovers from real native state', async () => {
  const h = harness();
  await h.request('setSDKParams', { tabId: 'tab', thinking: 'disabled' });
  h.native.state.thinking = true;
  h.native.state.inputRevision += 1;
  const before = h.native.writes.length;
  const get = await h.request('getSDKParams', { tabId: 'tab' });
  assert.equal(get.data.thinkingKnown, false);
  assert.equal(get.data.thinkingSource, 'last-confirmed-intent');
  assert.equal(get.data.thinkingReadReason, 'input-changed-since-proof');
  assert.equal(get.data.thinkingProof, null);
  assert.equal(h.native.writes.length, before);
  const set = await h.request('setSDKParams', { tabId: 'tab', thinking: 'adaptive' });
  assert.equal(set.ok, true);
  assert.equal(set.data.thinking, 'adaptive');
  assert.deepEqual(h.native.writes.slice(before), ['\x1bt', '\x1b']);
  assert.equal((await h.request('getSDKParams', { tabId: 'tab' })).data.thinkingKnown, true);
});

test('proof cannot survive process restart, session handoff or replacement of the PTY', async () => {
  for (const change of [
    h => { h.native.state.runSeq += 1; h.native.state.lifecycle = 'G2'; h.native.state.thinking = true; },
    h => { h.native.state.sessionId = 'new-session'; },
    h => { h.native.terminals.set('tab', { write() {} }); },
    h => { h.native.state.processAlive = false; },
  ]) {
    const h = harness();
    await h.request('setSDKParams', { tabId: 'tab', thinking: 'disabled' });
    change(h);
    const writes = h.native.writes.length;
    const get = await h.request('getSDKParams', { tabId: 'tab' });
    assert.equal(get.data.thinkingKnown, false);
    assert.equal(get.data.thinking, 'adaptive', 'old-process false is not a next-process default');
    assert.equal(get.data.thinkingSource, 'default-intent');
    assert.equal(h.native.writes.length, writes);
  }
});

test('an IPC failure before native input preserves an independently current proof', async () => {
  const h = harness();
  await h.request('setSDKParams', { tabId: 'tab', thinking: 'disabled' });
  h.setReply(() => { throw Error('transport unavailable'); });
  assert.equal((await h.request('setSDKParams', { tabId: 'tab', thinking: 'adaptive' })).ok, false);
  const get = await h.request('getSDKParams', { tabId: 'tab' });
  assert.equal(get.data.thinkingKnown, true);
  assert.equal(get.data.thinking, 'disabled');
});

test('busy and starting Claude requests retain the existing native picker capability', async () => {
  for (const tab of [{ aiBusy: true }, { claudeSessionId: null, isStarting: true }]) {
    const h = harness({ tab });
    if (!h.selectedTab.claudeSessionId) h.native.state.sessionId = null;
    const result = await h.request('setSDKParams', { tabId: 'tab', thinking: 'disabled' });
    assert.equal(result.ok, true);
    assert.equal(h.native.state.thinking, false);
  }
});

test('cold read has explicit unknown provenance and cold write does not claim a native state', async () => {
  const h = harness({ tab: { claudeSessionId: null } });
  h.native.state.sessionId = null;
  h.native.state.processAlive = false;
  assert.equal((await h.request('getSDKParams', { tabId: 'tab' })).data.thinkingKnown, false);
  assert.deepEqual(h.native.writes, []);
  assert.equal((await h.request('setSDKParams', { tabId: 'tab', thinking: 'disabled' })).ok, false);
});
