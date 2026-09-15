import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { controlBarBusyTarget, isControlBarBusyBlocked, isControlBarBusyTarget } from './controlBarBusyTarget.mjs';
import { settingsPresentation } from './agentSettingsPresentation.mjs';

const require = createRequire(import.meta.url);
const { createClaudeSettingsSendRuntime } = require('../../main/claude-settings-send');
const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const main = fs.readFileSync(path.join(src, 'main/main.js'), 'utf8');
const bar = fs.readFileSync(path.join(src, 'renderer/components/Workspace/ClaudeControlBar.tsx'), 'utf8');
const actions = fs.readFileSync(path.join(src, 'renderer/utils/claudePtyActions.ts'), 'utf8');
const ast = ts.createSourceFile('bar.tsx', bar, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const variables = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(ast);
const declaration = name => {
  assert.ok(variables.has(name), name);
  return 'const ' + variables.get(name).getText(ast) + ';';
};
const compile = text => ts.transpileModule(text, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
const pointerEvents = bar.match(/pointerEvents: (isPasteBusy[^,\n]+)/)?.[1];
assert.ok(pointerEvents, 'actual settings-cluster pointer gate');
const noop = () => {};
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function harness({ afterSetting = async () => {}, afterProof = async () => {}, commandRunning = true } = {}) {
  const start = main.indexOf('const pasteInflight = new WeakMap();');
  const end = main.indexOf('\nfunction markActivePtySubmit(', start);
  assert.ok(start > 0 && end > start);
  const { withPtyWriteLock } = vm.runInNewContext(main.slice(start, end) + '\n({ withPtyWriteLock })');
  const held = deferred();
  const release = deferred();
  const events = [];
  const ui = { effort: 'medium', model: 'model-A', seed: null };
  let actualEffort = 'medium';
  let actualModel = 'model-A';
  const term = {};
  const runtime = createClaudeSettingsSendRuntime({
    getTerminal: () => term, withWriteLock: withPtyWriteLock,
    captureRuntime: () => ({ term }), isRuntimeCurrent: () => true,
    readConfirmedSettings: async () => ({ success: true, model: actualModel, effort: actualEffort,
      sessionId: 'S', latestSessionId: 'S', modelProofAt: 1, effortProofAt: 1, effortCurrentRuntime: true }),
    sendCommand: async (_tab, command) => {
      events.push(command);
      if (command.startsWith('/model ')) actualModel = command.slice(7);
      if (command.startsWith('/effort ')) actualEffort = command.slice(8);
      return { success: true };
    },
    readProof: async request => (await afterProof(request)) || { success: true, sessionId: 'S' },
    confirmDialog: noop, retryExactInput: noop, settleClaim: noop,
    toggleThinking: async () => assert.fail('no Think write'),
    paste: async () => {
      events.push('A held'); held.resolve();
      await release.promise;
      events.push('A Enter');
      return { success: true, submitted: true, enterWritten: true };
    },
  });
  let renderer;
  renderer = vm.createContext({
    tabId: 'tab', sessionId: 'S', claudeSessionId: 'S', sessionType: 'claude',
    isClaudePtySession: true, isAnthropicPTY: true, isCodex: false, isSDKTab: false,
    isDeepSeekPTY: false, isCommandRunning: commandRunning,
    isPasteBusy: true, isLocalBusy: false, isBusy: true, codexTurnBusy: false,
    localBusyReason: null, localBusyReasonRef: { current: null },
    providerBindingRef: { current: 'tab' },
    controlActionInFlightRef: { current: null },
    claudeSettingActionsRef: { current: { tabId: 'tab', seq: 0, pending: 0 } },
    console: { log: noop, warn: noop, error: noop },
    window: { __effortSentForTab: new Map(), __modelSentForTab: new Map() },
    isControlBarBusyBlocked, isControlBarBusyTarget,
    setLocalBusyReason: reason => { renderer.localBusyReason = reason; },
    setIsLocalBusy: busy => { renderer.isLocalBusy = busy; renderer.isBusy = busy || renderer.isPasteBusy; },
    setEffortLocal: value => { ui.effort = value; },
    setClaudeModel: value => { ui.model = value; },
    setProviderState: value => { ui.provider = value; },
    setConfirmedSettingsOwnerSessionId: noop, rememberConfirmedSettingsSeed: (_sessionId, seed) => { ui.seed = seed; },
    refreshClaudeConfirmedSettings: noop, focusTerminal: noop, showToast: noop,
    setPinnedPopup: noop, setHoveredTrigger: noop, setHoveredPopup: noop,
    setHoveredModelMenuModel: noop, clearQuickClaudeToggle: noop,
    activeProvider: { id: 'anthropic' },
    claudeCodeModels: [{ id: 'model-B', label: 'Model B' }],
    confirmedClaudeEffort: 'max',
    claudeEffortsForModel: () => ['low', 'medium'],
    resolveClaudeEffortForModel: () => 'low',
    modelActiveId: 'model-A',
    ipcRenderer: { invoke: async (channel, request) => {
      if (channel === 'provider:set-options') {
        events.push('next-launch:' + request.startupEffort);
        return request;
      }
      if (channel === 'claude:apply-settings') return runtime.applySettings(request);
      assert.equal(channel, 'claude:apply-setting');
      const result = await runtime.applySetting(request);
      await afterSetting(request);
      return result;
    } },
  });
  Object.defineProperty(renderer, 'settingsWritePresentation', { get: () => settingsPresentation({
    localBusy: renderer.isLocalBusy && ['model', 'effort', 'quick'].includes(controlBarBusyTarget(renderer.localBusyReason)),
    localTarget: controlBarBusyTarget(renderer.localBusyReason),
  }) });
  Object.defineProperty(renderer, 'settingsWriteBusy', { get: () => renderer.settingsWritePresentation.busy });
  const actionAst = ts.createSourceFile('actions.ts', actions, ts.ScriptTarget.Latest, true);
  const apply = actionAst.statements.find(node => ts.isFunctionDeclaration(node)
    && node.name?.text === 'applyClaudePtySetting');
  const pair = actionAst.statements.find(node => ts.isFunctionDeclaration(node)
    && node.name?.text === 'applyClaudePtySettings');
  assert.ok(apply);
  assert.ok(pair);
  vm.runInContext(compile([apply, pair].map(node => node.getText(actionAst).replace(/^export /, '')).join('\n') + '\n' + [
    'canQueueClaudeSettings', 'claudeSettingActionIsCurrent', 'setLocalBusy',
    'beginControlAction', 'endControlAction', 'beginModelEffortAction', 'endModelEffortAction',
    'setEffortOnPTY', 'applyClaudeModelAndEffort', 'pickEffort', 'pickClaudeModelEffort', 'pickModel',
    'isBusySpinnerOn', 'isBusyBlocked',
  ].map(declaration).join('\n') + '\nglobalThis.pick = pickEffort; globalThis.pickPair = pickClaudeModelEffort; globalThis.pickModel = pickModel;'
    + '\nglobalThis.controls = () => {' + [
      'modelSpinning', 'modelBlocked', 'effortSpinning', 'effortBlocked',
    ].map(declaration).join('\n') + '\nreturn { modelSpinning, modelBlocked, effortSpinning, effortBlocked, pointerEvents: '
    + pointerEvents + ' }; };'), renderer);
  return { runtime, renderer, ui, events, held, release,
    holdA: () => runtime.sendPrompt({ tabId: 'tab', content: 'A', model: 'model-A', effort: 'medium' }),
  };
}

test('Claude choices stay available for a busy reply, startup or stopped process, not an outstanding setting', () => {
  for (const state of [
    { isPasteBusy: true, isLocalBusy: false },
    { isPasteBusy: false, isLocalBusy: true, localBusyReason: 'claude-start' },
    { isPasteBusy: false, isLocalBusy: false, isCommandRunning: false },
  ]) {
    const h = harness();
    Object.assign(h.renderer, state);
    assert.deepEqual(JSON.parse(JSON.stringify(h.renderer.controls())), {
      modelSpinning: false, modelBlocked: false, effortSpinning: false, effortBlocked: false, pointerEvents: 'auto',
    }, 'setting trigger remains a menu, never a cancel-only button');
  }
});

test('Claude setting stays loading after paste until proof; a second UI click is disabled', async () => {
  const highReply = deferred();
  const h = harness({ afterSetting: async request => {
    if (request.kind === 'effort' && request.value === 'high') await highReply.promise;
  } });
  const a = h.holdA();
  await h.held.promise;
  const b = h.renderer.pick('high');
  const c = h.renderer.pick('max');
  await Promise.resolve();
  assert.deepEqual(h.events, ['A held']);
  assert.equal(h.renderer.controls().effortSpinning, true);
  assert.equal(h.renderer.controls().modelBlocked, true);
  assert.equal(h.renderer.controls().effortBlocked, true);
  h.release.resolve();
  await a;
  await c;
  assert.deepEqual(h.events, ['A held', 'A Enter', '/effort high']);
  assert.equal(h.ui.effort, 'medium', 'unconfirmed selection is not displayed as applied');
  assert.equal(h.renderer.isLocalBusy, true);
  highReply.resolve();
  await b;
  assert.equal(h.ui.effort, 'high');
  await h.renderer.pick('max');
  assert.equal(h.ui.effort, 'max');
  assert.equal(h.renderer.window.__effortSentForTab.get('tab').level, 'max');
  assert.equal(h.renderer.isLocalBusy, false);
  assert.equal(h.renderer.claudeSettingActionsRef.current.pending, 0);
});

test('model/effort pair remains blocked between its model proof and its effort proof', async () => {
  const modelReply = deferred();
  const modelApplied = deferred();
  const h = harness({ afterProof: async request => {
    if (request.command.startsWith('/model ')) { modelApplied.resolve(); await modelReply.promise; }
  } });
  const b = h.renderer.pickPair('model-B', 'low');
  await modelApplied.promise;
  const c = h.renderer.pick('high');
  await c;
  modelReply.resolve();
  await b;
  assert.deepEqual(h.events, ['/model model-B', '/effort low']);
  assert.equal(h.ui.effort, 'low');
  assert.equal(h.renderer.isLocalBusy, false);
});

test('ControlBar stores the observed model and nullable variant proof, never the requested ID', async () => {
  const h = harness({ afterProof: async request => request.command.startsWith('/model ')
    ? { success: true, sessionId: 'S', actualValue: 'Fable 5', requestSatisfied: null,
      observed: { label: 'Fable 5', modelId: null, contextTokens: null } }
    : { success: true, sessionId: 'S', actualValue: 'high', requestSatisfied: true,
      observed: { label: 'high', effort: 'high' } } });
  await h.renderer.pickPair('claude-fable-5[1m]', 'high');
  assert.equal(h.ui.model, 'Fable 5');
  assert.equal(h.ui.effort, 'high');
  assert.equal(h.ui.seed.model, 'Fable 5');
  assert.equal(h.ui.seed.modelRequestSatisfied, null);
  assert.deepEqual(h.ui.seed.observedModel, { label: 'Fable 5', modelId: null, contextTokens: null });
  assert.equal(h.renderer.window.__modelSentForTab.get('tab').model, 'Fable 5');
});

test('external Claude setting requests still serialize in main while the UI is disabled', async () => {
  const h = harness();
  const a = h.holdA();
  await h.held.promise;
  const high = h.runtime.applySetting({ tabId: 'tab', kind: 'effort', value: 'high' });
  const max = h.runtime.applySetting({ tabId: 'tab', kind: 'effort', value: 'max' });
  h.release.resolve();
  await Promise.all([a, high, max]);
  assert.deepEqual(h.events, ['A held', 'A Enter', '/effort high', '/effort max']);
});

test('model-only click with a required compatible effort holds both settings before another client', async () => {
  const modelReply = deferred();
  const modelApplied = deferred();
  const h = harness({ afterProof: async request => {
    if (request.command === '/model model-B') { modelApplied.resolve(); await modelReply.promise; }
  } });
  const pick = h.renderer.pickModel('model-B');
  await modelApplied.promise;
  const external = h.runtime.applySetting({ tabId: 'tab', kind: 'effort', value: 'medium', source: 'external' });
  assert.equal(h.renderer.controls().modelBlocked, true);
  assert.equal(h.renderer.controls().effortBlocked, true);
  modelReply.resolve();
  await Promise.all([pick, external]);
  assert.deepEqual(h.events, ['/model model-B', '/effort low', '/effort medium'],
    'compatible effort belongs to the same model choice; it cannot overtake a later client');
});

test('stopped setting choices keep the existing next-launch route without a PTY command', async () => {
  const h = harness({ commandRunning: false });
  await h.renderer.pick('high');
  assert.deepEqual(h.events, ['next-launch:high']);
  assert.equal(h.ui.provider.startupEffort, 'high');
});

test('an unrelated Start action does not prohibit queueing the first settings choice', async () => {
  const h = harness();
  h.renderer.controlActionInFlightRef.current = 'session-start:claude';
  await h.renderer.pick('high');
  assert.deepEqual(h.events, ['/effort high']);
  assert.equal(h.renderer.controlActionInFlightRef.current, 'session-start:claude');
});
