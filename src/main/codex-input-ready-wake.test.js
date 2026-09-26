'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const { classifyCodexManualEnterFrame } = require('./codex-model-picker');
const { inspectCodexInputReadyTextCore, selectCodexCurrentInteractiveFrameText } = require('./codex-tui-readiness');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = source.indexOf('async function ensureCodexInputReadyForExternalPrompt(');
const end = source.indexOf('\nfunction codexEventType(', start);
assert.ok(start >= 0 && end > start);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const events = new EventEmitter();
  let ready = false;
  let deadline;
  let armed = 0;
  const fn = vm.runInNewContext(source.slice(start, end) + '\nensureCodexInputReadyForExternalPrompt', {
    CODEX_EXTERNAL_PROMPT_READY_TIMEOUT_MS: 90000,
    getCodexTuiReadyState: async () => ({ inputReady: ready, textReady: ready, processReady: true }),
    hasCodexEstablishedComposerLifecycle: () => true,
    codexStartupAutoEnter: new Map(),
    armCodexStartupAutoEnter: () => { armed++; },
    getCodexRuntimeSessionId: () => 'same-session', terminalProjects: new Map(),
    probeCodexStartupFromRawBuffer: () => ({ ready: false, reason: 'composer-initialization-pending' }),
    markCodexTuiReadyFromRawProbe: async () => false,
    ipcMain: events, console: { warn() {} },
    setTimeout: (callback) => { deadline = callback; return 1; }, clearTimeout() {},
  });
  return { fn, events, ready: () => { ready = true; }, deadline: () => deadline(), armed: () => armed };
}

test('send waiting inside a model picker wakes on the common readiness transition', async () => {
  const h = harness();
  let result;
  const pending = h.fn('T').then((value) => { result = value; });
  await tick();
  h.ready();
  h.events.emit('agent:readiness-changed-internal', null, { tabId: 'other', toolType: 'codex' });
  await tick();
  assert.equal(result, undefined);
  h.events.emit('agent:readiness-changed-internal', null, { tabId: 'T', toolType: 'codex' });
  await tick();
  assert.equal(result?.success, true, 'picker close is not a second startup TUI-ready event');
  await pending;
  assert.equal(h.armed(), 0, 'an established picker must not arm startup auto-Enter machinery');
  assert.equal(h.events.listenerCount('agent:readiness-changed-internal'), 0);
  assert.equal(h.events.listenerCount('agent:tui-ready-internal'), 0);
});

test('deadline re-read that already proves readiness cannot report codex_not_input_ready', async () => {
  const h = harness();
  const pending = h.fn('T');
  await tick();
  h.ready();
  await h.deadline();
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.ready.inputReady, true);
});

test('a pending settings intent reconciles on the same ready edge without a renderer status query', () => {
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
  const handler = ast.statements.find(statement => ts.isExpressionStatement(statement)
    && statement.getText(ast).startsWith("ipcMain.on('agent:readiness-changed-internal'"));
  assert.ok(handler, 'top-level readiness owner, not a temporary operation listener');
  const events = new EventEmitter();
  const calls = [];
  vm.runInNewContext(handler.getText(ast), {
    ipcMain: events,
    scheduleCodexModelEffortIntentReconcile: (...args) => calls.push(args),
  });
  events.emit('agent:readiness-changed-internal', null, { tabId: 'T', toolType: 'codex', status: 'waiting' });
  events.emit('agent:readiness-changed-internal', null, { tabId: 'T', toolType: 'claude', status: 'ready' });
  assert.equal(calls.length, 0);
  events.emit('agent:readiness-changed-internal', null, { tabId: 'T', toolType: 'codex', status: 'ready', source: 'codex-input-control-frame' });
  assert.deepEqual(calls, [['T', 'input-ready:codex-input-control-frame']]);
});

test('committed picker release publishes readiness once, after the initialized composer, on the same lifecycle', () => {
  const part = (name) => {
    const begin = source.indexOf('function ' + name + '(');
    const stop = source.indexOf('\n}\n', begin) + 3;
    assert.ok(begin >= 0 && stop > begin, name);
    return source.slice(begin, stop);
  };
  let generation = 'terminal:1';
  const mirror = {};
  const emitted = [];
  let busy = false;
  const context = {
    classifyCodexManualEnterFrame,
    terminals: new Map(),
    codexSettingsMutationQueue: require('./codex-settings-mutation-queue').createCodexSettingsMutationQueue(),
    codexInputControlFrameCache: new WeakMap(),
    getHeadlessTerminalMirror: (tabId) => tabId === 'T' ? mirror : null,
    codexTuiReadyTabs: new Set(['T']), codexLateMcpProofPending: new Map(),
    codexRuntimePolicies: null,
    codexTuiReadyMeta: new Map([['T', { initializedLifecycleGeneration: generation }]]),
    terminalCommandState: new Map([['T', { isRunning: true }]]),
    getTerminalLifecycleGeneration: () => generation,
    hasCodexPromptOrTurnInFlight: () => busy,
    inspectCodexInputReadyVisibleText: (_text, sourceName, { lines }) => {
      const current = selectCodexCurrentInteractiveFrameText(lines);
      return inspectCodexInputReadyTextCore(current, '', {
        requireSyncMarker: false, requireInitializedComposer: true, source: sourceName,
      });
    },
    emitAgentReadinessChanged: (tabId, detail) => emitted.push({ tabId, ...detail }),
  };
  const names = ['hasCodexEstablishedComposerLifecycle', 'codexInputControlFromCommittedSnapshot',
    'getCodexLiveInputControl', 'isCodexTuiEffectivelyReady', 'observeCodexInputControlReadinessFrame'];
  const api = vm.runInNewContext(names.map(part).join('\n') + '\n({' + names.join(',') + '})', context);
  let sequence = 0;
  const frame = (texts) => ({ success: true, authoritativeFrameCommitted: true,
    committedFrameGeneration: ++sequence, lines: texts.map((text) => ({ text })) });
  const observe = (snapshot) => {
    mirror.lastCommittedVisibleSnapshot = snapshot;
    api.observeCodexInputControlReadinessFrame('T', mirror, snapshot);
  };
  const menu = () => frame(['Select Model', '› 1. gpt-5.6-luna (current)',
    '  2. All models Choose a specific model', 'Press enter to confirm or esc to go back']);
  const composer = () => frame(['› Ask Codex to do anything', 'gpt-5.6-luna medium · Full Access']);
  observe(composer());
  assert.equal(emitted.length, 0, 'no extra startup event without a picker');
  observe(menu());
  assert.equal(api.isCodexTuiEffectivelyReady('T'), false);
  observe(frame(['› Ask Codex to do anything']));
  assert.equal(emitted.length, 0, 'intermediate footer-less redraw is not ready');
  observe(composer());
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].source, 'codex-input-control-frame');
  assert.equal(emitted[0].lifecycleGeneration, 'terminal:1');
  observe(composer());
  assert.equal(emitted.length, 1, 'duplicate frames do not re-publish the same transition');
  observe(menu());
  busy = true;
  observe(composer());
  assert.equal(emitted.length, 1, 'response activity cannot settle an idle picker transition');
  busy = false;
  generation = 'terminal:2';
  observe(composer());
  assert.equal(emitted.length, 1, 'a replacement process cannot inherit the old picker');
  assert.equal(mirror.codexInputControlWaitGeneration, null);
  api.observeCodexInputControlReadinessFrame('T', {}, composer());
  assert.equal(emitted.length, 1, 'a foreign mirror cannot wake this owner');
});
