import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as coordinator from './agentActionCoordinator.mjs';

const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let action, subscribe;
const presentation = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ['presentStatusTitle', 'sendPreparationPending', 'hasFloatingStatus', 'historyComposerFloatingStatus'].includes(node.name.getText(ast))) {
    presentation.set(node.name.getText(ast), node.initializer.getText(ast));
  }
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'AIComposerSurface') {
    const className = node.attributes.properties.find(attr => ts.isJsxAttribute(attr) && attr.name.text === 'className');
    if (className?.initializer) presentation.set('composerFrameClassName',
      ts.isJsxExpression(className.initializer) ? className.initializer.expression.getText(ast) : className.initializer.getText(ast));
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'runAction'
    && ts.isCallExpression(node.initializer)) action = node.initializer.arguments[0].getText(ast);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0]?.getText(ast).startsWith('() => subscribeCoordinatedAgentActions')) subscribe = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast); assert.ok(action); assert.ok(subscribe);
const js = value => ts.transpileModule('globalThis.result = (' + value + ');', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;
const gate = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { resolve, reject, promise }; };

function harness(t, { text = 'fixture prompt', status = 'active', imageFailure = false, contextPending = false, emptyAfterPrepare = false } = {}) {
  coordinator.resetCoordinatedAgentActionsForTests();
  const prepared = gate(), contextEntered = gate(), stopped = gate(), stopEntered = gate();
  const events = [], input = { historyPromptDrafts: { T: text }, historyPromptDraftChips: {}, historyPromptDraftImages: {} };
  const ref = current => ({ current });
  const ctx = { ...coordinator, console: { log() {}, warn() {} },
    tabId: 'T', toolType: 'claude', sessionId: 'S', cwd: '/fixture', projectId: 'P', presenceOwnerKey: 'T:S',
    tabIdRef: ref('T'), presenceOwnerKeyRef: ref('T:S'), presenceGenerationRef: ref(1), actionSeqRef: ref(0),
    actionInFlightRef: ref(false), activeActionKindRef: ref(null), pasteBusyRef: ref(false),
    processStopInFlightRef: ref(false), pendingQuestionRef: ref(null), statusRef: ref(status),
    busyAction: null, resumeMaterialized: true, prompt: text,
    historyPromptHandoffBlocksNewSubmit: () => false, getHistoryPromptHandoffsSnapshot: () => [],
    currentUIActionId: () => 'ui-preparation-fixture', uiPerformancePhaseForAction: (...args) => events.push(['phase', ...args]),
    HISTORY_PENDING_DELIVERY_BLOCK_NOTICE: 'pending', historyDiag: message => events.push(['log', message]),
    normalizeComposerChips: value => value, isTerminalOnlyComposerDraft: () => false,
    serializeComposerDraft: ({ text }) => text,
    retainHistoryDraftImages: (_text, refs) => refs, haveSamePromptImageRefs: () => true, haveSameComposerChips: () => true,
    useUIStore: { getState: () => input },
    setBusyAction: value => { ctx.busyAction = value; }, setDraftWarning: value => events.push(['warning', value]),
    setIsPasteBusy() {}, refreshPresence: () => {
      if (!ctx.processStopInFlightRef.current) ctx.statusRef.current = status;
    },
    setStatusFrom: (value, reason) => { ctx.statusRef.current = value; events.push(['status', value, reason]); },
    reportError: error => events.push(['error', String(error?.message || error)]),
    setHistoryPromptDraft: (id, value) => { input.historyPromptDrafts[id] = value; },
    prepareHistoryPromptForSend: async raw => ({ success: !imageFailure, payload: emptyAfterPrepare ? '' : raw, images: [], warning: 'fixture image unavailable' }),
    createPromptHandoffId: () => 'H', historyPromptHandoffInitialStatus: () => 'sending',
    prepareTabWorkContext: async () => { contextEntered.resolve(); return contextPending ? prepared.promise : { prompt: text, prefix: '' }; },
    settleTabWorkContext: async () => {},
    recoverAgentDraftTransferToHistory: async () => {}, queueSendTransferredOwnership: () => false,
    onPromptStatusChange() {}, retractHistoryPromptHandoff() {},
    ipcRenderer: { invoke: async (name) => { events.push(['ipc', name]); return {}; } },
    runtime: { toolType: 'claude', logPrefix: 'fixture', label: 'Claude', allowSendWhileBusy: true,
      stopProcess: async () => { events.push(['physical-stop']); stopEntered.resolve(); return stopped.promise; } },
  };
  vm.createContext(ctx); vm.runInContext(js(action), ctx); const run = ctx.result;
  vm.runInContext(js(subscribe), ctx); const unsubscribe = ctx.result();
  t.after(() => { unsubscribe(); coordinator.resetCoordinatedAgentActionsForTests(); });
  return { ctx, input, events, run, prepared, contextEntered, stopEntered, stopped };
}

function preparationPresentation(h, owner = 'T', overrides = {}) {
  const ctx = { React, coordinatedComposerAction: coordinator.getCoordinatedAgentAction(owner),
    showStatusText: false, activeLifecycle: null, lifecycleNeedsExplanation: false,
    visibleDraftWarning: null, inlineDraftNoticeMeta: null,
    rewindPreviewActive: false, historyTranscriptFontSize: 13, HISTORY_SERVICE_TEXT_RATIO: 0.82,
    HISTORY_SERVICE_TEXT_WEIGHT: 400, AgentLifecycleActions: () => null,
    ...overrides,
  };
  vm.createContext(ctx);
  // Render the actual caption and the class passed to the real composer shell.
  for (const name of ['presentStatusTitle', 'sendPreparationPending', 'hasFloatingStatus', 'historyComposerFloatingStatus', 'composerFrameClassName']) {
    if (!presentation.has(name)) continue;
    vm.runInContext(js(presentation.get(name)), ctx); ctx[name] = ctx.result;
  }
  return ctx;
}

const renderPreparation = (h, owner = 'T') => renderToStaticMarkup(preparationPresentation(h, owner).historyComposerFloatingStatus);

test('actual History shows preparation before a slow context promise, never claims Main queue acceptance', async t => {
  const h = harness(t, { contextPending: true }); const send = h.run('send', { uiActionId: 'ui-preparation-fixture' });
  await h.contextEntered.promise;
  try {
    const markup = renderPreparation(h);
    assert.match(markup, /data-history-send-preparation/);
    assert.match(markup, /Preparing send\.\.\./);
    assert.doesNotMatch(markup, /IN APP QUEUE|SENT|data-agent-send-phase/);
    assert.equal(h.input.historyPromptDrafts.T, 'fixture prompt');
    assert.equal(renderPreparation(h, 'other-tab'), '', 'foreign surface owns no caption');
    assert.ok(h.events.some(e => e[0] === 'phase' && e[1] === 'ui-preparation-fixture'
      && e[2] === 'history-send-preparation-begin'), 'diagnostics bind to the original UI action');
    const token = coordinator.getCoordinatedAgentAction('T').token;
    await h.run('send');
    assert.equal(coordinator.getCoordinatedAgentAction('T').token, token, 'repeat Enter cannot create another intent');
  } finally { h.prepared.reject(new Error('fixture context read failed')); await send; }
  assert.equal(renderPreparation(h), '', 'failed preparation removes only its caption');
  assert.equal(h.input.historyPromptDrafts.T, 'fixture prompt', 'pre-input failure preserves draft');
});

test('preparation uses the lifecycle caption typography and pulses only its own composer outline', async t => {
  const h = harness(t, { contextPending: true }); const send = h.run('send'); await h.contextEntered.promise;
  try {
    for (const historyTranscriptFontSize of [11, 13, 18]) {
      const view = preparationPresentation(h, 'T', { historyTranscriptFontSize, showStatusText: true,
        statusTitle: 'PREPARING CODEX SESSION...', statusAccent: '#60a5fa' });
      const children = React.Children.toArray(view.historyComposerFloatingStatus.props.children.props.children);
      const preparing = children.find(child => child.props?.['data-history-send-preparation'] !== undefined);
      const lifecycle = children.find(child => child.props?.['data-agent-status-title'] !== undefined);
      assert.equal(preparing.props.children, 'Preparing send...');
      assert.equal(lifecycle.props.children, 'Preparing codex session...');
      assert.deepEqual(preparing.props.style, lifecycle.props.style, 'both captions inherit the same parent font/size/weight');
      assert.equal(view.historyComposerFloatingStatus.props.style.fontSize, historyTranscriptFontSize * 0.82);
      assert.match(view.composerFrameClassName, /\bhp-history-composer-preparing\b/);
    }
    assert.doesNotMatch(preparationPresentation(h, 'other-tab').composerFrameClassName, /hp-history-composer-preparing/);
    const token = coordinator.getCoordinatedAgentAction('T').token;
    coordinator.bindCoordinatedAgentSendHandoff('T', token, 'H');
    assert.doesNotMatch(preparationPresentation(h).composerFrameClassName, /hp-history-composer-preparing/);
  } finally { h.prepared.reject(new Error('fixture complete')); await send; }
  assert.doesNotMatch(preparationPresentation(h).composerFrameClassName, /hp-history-composer-preparing/);
  assert.match(source, /\.hp-history-composer-preparing::after\s*\{[^}]*pointer-events:\s*none;[^}]*animation:\s*hp-history-composer-preparing[^}]*infinite;/);
  assert.match(source, /prefers-reduced-motion:\s*reduce[^]*?\.hp-history-composer-preparing::after\s*\{\s*animation:\s*none;/);
  const pauseCss = fs.readFileSync(new URL('../styles/presentationAnimations.css', import.meta.url), 'utf8');
  assert.match(pauseCss, /\.hp-history-composer-preparing::after\s*\{\s*animation-play-state:\s*paused !important;/);
});

for (const status of ['busy', 'starting', 'inactive']) {
  test('preparation feedback does not remove existing Send capability: ' + status, async t => {
    const h = harness(t, { contextPending: true, status }); const send = h.run('send');
    await h.contextEntered.promise;
    try {
      assert.match(renderPreparation(h), /data-history-send-preparation/);
      assert.equal(h.input.historyPromptDrafts.T, 'fixture prompt');
      assert.equal(coordinator.getCoordinatedAgentAction('T').handoffId, null);
    } finally { h.prepared.reject(new Error('fixture context refusal')); await send; }
    assert.equal(renderPreparation(h), '');
  });
}

test('actual preparation caption stops at handoff and does not return while the action unwinds', async t => {
  const h = harness(t, { contextPending: true }); const send = h.run('send'); await h.contextEntered.promise;
  try {
    assert.match(renderPreparation(h), /data-history-send-preparation/);
    const token = coordinator.getCoordinatedAgentAction('T').token;
    assert.equal(coordinator.bindCoordinatedAgentSendHandoff('T', token, 'H').bound, true);
    assert.equal(renderPreparation(h), '', 'handoff owns delivery feedback, not the composer');
  } finally { h.prepared.reject(new Error('fixture complete')); await send; }
});

test('actual preparation caption disappears on Stop before late context returns', async t => {
  const h = harness(t, { contextPending: true }); const send = h.run('send'); await h.contextEntered.promise;
  try {
    assert.match(renderPreparation(h), /data-history-send-preparation/);
    const stop = h.run('stop'); await h.stopEntered.promise;
    assert.equal(renderPreparation(h), '');
    assert.doesNotMatch(preparationPresentation(h).composerFrameClassName, /hp-history-composer-preparing/);
    h.stopped.resolve({ success: true, stopped: true }); await stop;
  } finally { h.stopped.resolve({ success: true, stopped: true }); h.prepared.reject(new Error('fixture cancelled')); await send; }
});

for (const options of [{ text: '' }, { status: 'unknown' }, { imageFailure: true }]) {
  test('actual History pre-handoff exit releases Send owner: ' + JSON.stringify(options), async t => {
    const h = harness(t, options); const original = h.input.historyPromptDrafts.T;
    await h.run('send');
    assert.equal(coordinator.getCoordinatedAgentAction('T'), null, 'no orphan can hold future Send/Stop');
    assert.equal(h.ctx.actionInFlightRef.current, false); assert.equal(h.ctx.busyAction, null);
    assert.equal(h.input.historyPromptDrafts.T, original);
    assert.equal(h.events.some(e => e[0] === 'physical-stop'), false);
  });
}

test('actual History Stop during pre-handoff await starts common Stop; late preparation cannot submit', async t => {
  const h = harness(t, { contextPending: true });
  const send = h.run('send'); await h.contextEntered.promise;
  assert.equal(coordinator.getCoordinatedAgentAction('T').handoffId, null);
  const stop = h.run('stop'); await h.stopEntered.promise;
  assert.equal(h.ctx.statusRef.current, 'stopping');
  assert.equal(h.events.filter(e => e[0] === 'physical-stop').length, 1);
  // Preparation returns while physical Stop is still awaiting its exit proof.
  h.prepared.resolve({ prompt: 'fixture prompt', prefix: '' });
  await new Promise(setImmediate);
  assert.equal(h.ctx.statusRef.current, 'stopping');
  assert.equal(coordinator.getCoordinatedAgentAction('T').handoffId, null, 'cancelled owner cannot acquire a handoff');
  assert.equal(h.input.historyPromptDrafts.T, 'fixture prompt');
  h.stopped.resolve({ success: true, stopped: true }); await Promise.all([send, stop]);
  assert.equal(coordinator.getCoordinatedAgentAction('T'), null); assert.equal(h.ctx.statusRef.current, 'inactive');
  assert.equal(h.events.filter(e => e[0] === 'physical-stop').length, 1);
  assert.equal(h.events.some(e => e[0] === 'ipc' && e[1].includes('paste')), false);
});

test('unproven physical Stop releases transient stopping without claiming inactive', async t => {
  const h = harness(t, { contextPending: true }); const send = h.run('send'); await h.contextEntered.promise;
  const stop = h.run('stop'); await h.stopEntered.promise;
  h.stopped.resolve({ success: false, error: 'process lookup unavailable' }); await stop;
  assert.notEqual(h.ctx.statusRef.current, 'stopping'); assert.notEqual(h.ctx.statusRef.current, 'inactive');
  h.prepared.resolve({ prompt: 'fixture prompt', prefix: '' }); await send;
  assert.equal(h.input.historyPromptDrafts.T, 'fixture prompt');
  assert.equal(h.events.filter(e => e[0] === 'physical-stop').length, 1);
});
