import test from 'node:test';
// Electron 28's Node test runner has EventTarget but no browser CustomEvent.
// The production renderer provides it; this fixture only supplies its payload.
const CustomEvent = globalThis.CustomEvent || class extends Event {
  constructor(type, options = {}) { super(type, options); this.detail = options.detail; }
};
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { applyClaudeStartupDefaultsGate, restoreClaudeStartupDefaultsGate } from './sessionStartingState.mjs';
import * as failure from './claudeStartupFailure.mjs';

const here = new URL('./', import.meta.url);
const read = relative => fs.readFileSync(new URL(relative, here), 'utf8');
function gateHarness({ setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const events = [], handlers = new Map();
  let readResult = { success: true, revision: 0, gate: null };
  const ctx = vm.createContext({ exports: {}, require: name => name === './claudeStartupFailure.mjs' ? failure : createRequire(import.meta.url)(name),
    window: { dispatchEvent: event => events.push(event.detail), require: () => ({ ipcRenderer: {
      invoke: async () => typeof readResult === 'function' ? readResult() : readResult,
      on: (name, fn) => handlers.set(name, fn), removeListener() {},
      send: () => assert.fail('main snapshots must not echo a mutation to main'),
    } }) }, CustomEvent, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn });
  vm.runInContext(ts.transpileModule(read('claudeStartupDefaultsGate.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, ctx);
  return { api: ctx.exports, events, setRead: value => { readResult = value; } };
}
const snapshot = (status, revision, generation = 'L', attemptId = 'A') => ({
  tabId: 'T', status, revision, generation, attemptId, error: status === 'failed' ? 'API error: 429' : null,
});

test('actual renderer rereads main instead of trusting a cached failure', async () => {
  const h = gateHarness();
  h.api.applyClaudeStartupDefaultsGateFromMain(snapshot('failed', 1));
  h.setRead({ success: true, revision: 2, gate: snapshot('ready', 2) });
  const state = await h.api.fetchClaudeStartupDefaultsGate('T');
  assert.equal(state.status, 'ready');
  assert.equal(state.generation, 'L'); assert.equal(state.attemptId, 'A');
});

test('a late main read cannot overwrite a newer launch event, including after a clear', async () => {
  const h = gateHarness();
  let release;
  h.setRead(() => new Promise(resolve => { release = resolve; }));
  const waiting = h.api.fetchClaudeStartupDefaultsGate('T');
  h.api.applyClaudeStartupDefaultsGateFromMain(snapshot('pending', 4, 'L2', 'B'));
  release({ success: true, revision: 1, gate: snapshot('failed', 1) });
  assert.equal((await waiting).attemptId, 'B');
  h.api.applyClaudeStartupDefaultsGateFromMain(snapshot('cleared', 5, null, null));
  h.api.applyClaudeStartupDefaultsGateFromMain(snapshot('failed', 4, 'L2', 'B'));
  assert.equal(h.api.getClaudeStartupDefaultsGateSnapshot('T'), null);
});

test('failed main read is unknown, not absence and not permission for the legacy fallback', async () => {
  const h = gateHarness();
  h.api.applyClaudeStartupDefaultsGateFromMain(snapshot('pending', 1));
  h.setRead(() => { throw Error('channel unavailable'); });
  await assert.rejects(h.api.fetchClaudeStartupDefaultsGate('T'), /channel unavailable/);
  assert.equal(h.api.getClaudeStartupDefaultsGateSnapshot('T').status, 'pending');
});

test('current main absence also retires an old-launch cache before the new settings transaction starts', async () => {
  const h = gateHarness();
  h.api.applyClaudeStartupDefaultsGateFromMain(snapshot('failed', 1));
  h.setRead({ success: true, revision: 1, generation: 'L2', gate: null });
  assert.equal(await h.api.fetchClaudeStartupDefaultsGate('T'), null);
  h.api.applyClaudeStartupDefaultsGateFromMain(snapshot('failed', 1));
  assert.equal(h.api.getClaudeStartupDefaultsGateSnapshot('T'), null);
});

test('waiter of A is rejected rather than fulfilled by replacement B', async () => {
  const h = gateHarness();
  h.setRead({ success: true, revision: 1, gate: snapshot('pending', 1) });
  const waiting = h.api.waitForClaudeStartupDefaultsReady('T', 1000);
  const rejected = assert.rejects(waiting, /stopped or replaced/);
  await new Promise(resolve => setImmediate(resolve));
  h.api.applyClaudeStartupDefaultsGateFromMain(snapshot('ready', 2, 'L', 'B'));
  await rejected;
});

test('Send-style waiter has no local deadline and settles only from the exact main gate', async () => {
  let timerCalls = 0;
  const h = gateHarness({
    setTimeoutFn: () => { timerCalls += 1; throw new Error('no local timer expected'); },
    clearTimeoutFn: () => {},
  });
  h.setRead({ success: true, revision: 1, gate: snapshot('pending', 1) });
  const waiting = h.api.waitForClaudeStartupDefaultsReady('T', null);
  let settled = false;
  waiting.finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timerCalls, 0);
  assert.equal(settled, false);
  h.api.applyClaudeStartupDefaultsGateFromMain(snapshot('ready', 2));
  await waiting;
  assert.equal(settled, true);
});

test('dismissed main snapshot cannot recreate failure on remount; newer attempts still show', () => {
  const info = { tabId: 'T', engine: 'claude' };
  const old = applyClaudeStartupDefaultsGate(null, info, snapshot('failed', 1));
  assert.equal(old.startupAttemptId, 'A');
  assert.equal(restoreClaudeStartupDefaultsGate(null, info, { ...snapshot('failed', 2), dismissed: true }), null);
  const next = applyClaudeStartupDefaultsGate(old, info, snapshot('pending', 3, 'L', 'B'));
  assert.equal(applyClaudeStartupDefaultsGate(next, info, snapshot('failed', 1)), next);
});

function nestedFunction(source, name) {
  const ast = ts.createSourceFile('fixture.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, name);
  return ts.isCallExpression(found) ? found.arguments[0].getText(ast) : found.getText(ast);
}

test('actual lifecycle card and History Copy use short text and full diagnostic independently', () => {
  const raw = 'API error: 429 ' + JSON.stringify({ message: 'reason '.repeat(100), request_id: 'late-request' });
  const state = { tabId: 'T', engine: 'claude', startupFailed: true, startupError: raw,
    startupFailedCommand: '/model fable', stickySource: 'claude-startup-defaults' };
  const presentationFn = nestedFunction(read('../components/Workspace/useAgentLifecycle.ts'), 'getSessionStartingPresentation');
  const ctx = vm.createContext({ ...failure, describeLaunchPreparationFailure: () => null });
  vm.runInContext(ts.transpileModule('var present = ' + presentationFn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  const card = ctx.present(state);
  assert.equal(card.title, 'API error');
  assert.equal(card.subtitle, '');
  assert.match(card.detail, /late-request/);
  const report = failure.formatClaudeStartupFailureReport({ ...state, error: raw });
  let copied;
  Object.assign(ctx, { activeLifecycle: { ...card, copyText: report }, statusTitle: card.title, statusDescription: card.subtitle,
    statusDetail: card.detail, statusSessionId: null, tabId: 'T', meta: {},
    clipboard: { writeText: text => { copied = text; } }, setStatusCopied() {},
    statusCopiedTimerRef: { current: null }, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext('var copy = ' + nestedFunction(read('../components/Workspace/HistoryPanel.tsx'), 'copyStatusDetails'), ctx);
  ctx.copy();
  assert.equal(copied, report); assert.match(copied, /late-request/);
});

test('AutoResume distinguishes a settings failure from an actual preparation timeout', () => {
  assert.match(failure.describeClaudeRestoreFailure({ error: 'agent_ready_timeout' }), /не завершил подготовку/);
  assert.match(failure.describeClaudeRestoreFailure({ error: 'agent_startup_defaults_failed', detail: 'API error: 429' }), /лимит запросов/);
  assert.doesNotMatch(failure.describeClaudeRestoreFailure({ error: 'spawn failure' }), /настройки/);
});

test('actual App public projection uses the same main response and preserves a busy successor', () => {
  const source = read('../App.tsx');
  const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'projectClaudeStatusThroughStartupDefaults');
  const ctx = vm.createContext({ getClaudeStartupDefaultsGateSnapshot: () => assert.fail('old renderer gate is not public runtime truth') });
  vm.runInContext(ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  const project = ctx.projectClaudeStatusThroughStartupDefaults;
  for (const state of [{ startupDefaultsPending: true }, { startupFailed: true, startupError: '429' }]) {
    const busy = project('T', 'busy', true, null, false, null, state);
    assert.equal(busy.status, 'busy'); assert.equal(busy.inputReady, true);
  }
  const failed = project('T', 'active', false, null, true, '429', { startupFailed: true, startupError: '429' });
  assert.equal(failed.status, 'active'); assert.equal(failed.inputReady, false);
  assert.equal(project('T', 'active', true, null, false, null, { startupDefaultsReady: true }).startupDefaultsReady, true);
});

test('actual ControlBar failure toast uses short text but gives Copy the original command error', () => {
  const ctx = vm.createContext({ ...failure, tabId: 'T', claudeSessionId: 'S' });
  let toast;
  ctx.showToast = (...args) => { toast = args; };
  const fn = nestedFunction(read('../components/Workspace/ClaudeControlBar.tsx'), 'reportClaudeSettingFailure');
  vm.runInContext(ts.transpileModule('var report = ' + fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  ctx.report(Object.assign(new Error('API error: 429 {"request_id":"exact-request"}'), { code: 'claude_rate_limit', failedCommand: '/model fable' }));
  assert.equal(toast[0], 'Claude: достигнут лимит запросов');
  assert.match(toast[4], /exact-request/); assert.match(toast[4], /\/model fable/);
  assert.equal(toast[7], 'T');
});
