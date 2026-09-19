import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as coordinator from './agentActionCoordinator.mjs';

const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let action, subscribe;
function visit(node) {
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
const gate = () => { let resolve; const promise = new Promise(r => resolve = r); return { resolve, promise }; };

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
