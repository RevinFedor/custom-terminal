import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { applyHistoryPresenceProjection } from './historyPresenceProjection.mjs';

const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let refresh, subscribe, lifecycle;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'refreshPresence'
    && ts.isCallExpression(node.initializer)) refresh = node.initializer.arguments[0].getText(ast);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0]?.getText(ast).includes("ipcRenderer.on('agent:process-observation'")) subscribe = node.arguments[0].getText(ast);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0]?.getText(ast).includes('const handleStarted =')
    && node.arguments[0]?.getText(ast).includes('const handleFinished =')) lifecycle = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast); assert.ok(refresh); assert.ok(subscribe); assert.ok(lifecycle);
const code = value => ts.transpileModule('globalThis.result = (' + value + ')', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness(t) {
  const ipc = new EventEmitter(), windowEvents = new EventEmitter(), documentEvents = new EventEmitter();
  let presence = { status: 'unknown', processLookupUnknown: true }, reads = 0;
  let readPresence = async () => presence;
  const ref = current => ({ current });
  const ctx = { console: { log() {}, warn() {} }, applyHistoryPresenceProjection,
    tabId: 'T', projectId: 'P', toolType: 'claude', presenceOwnerKey: 'T:S',
    presenceOwnerKeyRef: ref('T:S'), presenceFlightRef: ref(null), presenceGenerationRef: ref(1),
    processStopInFlightRef: ref(false), statusRef: ref('unknown'), pendingQuestionRef: ref(null),
    runtime: { toolType: 'claude', logPrefix: 'fixture', label: 'Claude',
      readyEvent: 'claude:tui-ready', busyEvent: 'claude:busy-state',
      awaitingEvent: 'claude:awaiting-input', pasteBusyEvent: 'terminal:paste-busy',
      getPresence: async (...args) => { reads++; return readPresence(...args); } },
    setPresenceResolving: value => { ctx.resolving = value; }, resolving: false,
    setStatusFrom: value => { ctx.statusRef.current = value; }, onRuntimeSnapshotChange() {},
    setProcessLifecycleGeneration() {}, setResumeMaterialized() {}, refreshPendingQuestion() {}, setPendingQuestionFrom() {},
    refreshHistoryInBackground() {}, isNonAuthoritativeBusyEvent: () => false,
    pasteBusyRef: ref(false), setIsPasteBusy() {},
    ipcRenderer: ipc, window: { addEventListener: (e, fn) => windowEvents.on(e, fn), removeEventListener: (e, fn) => windowEvents.off(e, fn) },
    document: { visibilityState: 'visible', addEventListener: (e, fn) => documentEvents.on(e, fn), removeEventListener: (e, fn) => documentEvents.off(e, fn) },
  };
  vm.createContext(ctx); vm.runInContext(code(refresh), ctx); ctx.refreshPresence = ctx.result;
  vm.runInContext(code(subscribe), ctx); const unsubscribe = ctx.result(); t.after(unsubscribe);
  vm.runInContext(code(lifecycle), ctx); const unsubscribeLifecycle = ctx.result(); t.after(unsubscribeLifecycle);
  return { ctx, ipc, windowEvents, documentEvents, reads: () => reads,
    set: value => { presence = value; }, setReader: reader => { readPresence = reader; },
    settle: async () => { await ctx.presenceFlightRef.current?.promise; } };
}

function controlledReader() {
  const calls = [];
  return {
    calls,
    read: () => new Promise((resolve, reject) => calls.push({ resolve, reject })),
    async waitFor(count) {
      for (let i = 0; i < 4 && calls.length < count; i += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(calls.length, count, 'current-generation presence read started');
    },
  };
}

test('actual History ends failed checking, then recovered observation reads the same tab once without a timer', async t => {
  const h = harness(t); await h.ctx.refreshPresence();
  assert.equal(h.ctx.statusRef.current, 'unknown'); assert.equal(h.ctx.resolving, false);
  assert.equal(h.reads(), 1);
  h.set({ status: 'inactive', processLookupUnknown: false });
  h.ipc.emit('agent:process-observation', null, { tabId: 'T', toolType: 'claude' });
  await h.settle();
  assert.equal(h.ctx.statusRef.current, 'inactive'); assert.equal(h.ctx.resolving, false); assert.equal(h.reads(), 2);
  h.ipc.emit('agent:process-observation', null, { tabId: 'T', toolType: 'claude' });
  await h.settle(); assert.equal(h.reads(), 2, 'no repeat once state is known');
});

test('foreign wake is ignored; foreground retries only the unresolved read and cannot override process Stop', async t => {
  const h = harness(t); await h.ctx.refreshPresence();
  h.ipc.emit('agent:process-observation', null, { tabId: 'OTHER', toolType: 'claude' });
  h.ipc.emit('agent:process-observation', null, { tabId: 'T', toolType: 'codex' });
  assert.equal(h.reads(), 1);
  h.set({ status: 'active', inputReady: true }); h.windowEvents.emit('focus'); await h.settle();
  assert.equal(h.ctx.statusRef.current, 'active'); assert.equal(h.reads(), 2);
  h.windowEvents.emit('focus'); assert.equal(h.reads(), 2);
  h.ctx.processStopInFlightRef.current = true; h.ctx.statusRef.current = 'stopping';
  const stopGeneration = h.ctx.presenceGenerationRef.current;
  h.ipc.emit('terminal:command-started', null, { tabId: 'T' });
  h.ipc.emit('claude:tui-ready', null, { tabId: 'T' });
  assert.equal(h.ctx.presenceGenerationRef.current, stopGeneration, 'startup/readiness cannot steal ownership from pending Stop');
  assert.equal(h.ctx.statusRef.current, 'stopping');
  await h.ctx.refreshPresence(); assert.equal(h.ctx.statusRef.current, 'stopping');
  assert.equal(h.ctx.processStopInFlightRef.current, true, 'a presence snapshot cannot cancel a pending Stop');
});

test('IPC error finishes observation; a subsequent real foreground event can recover', async t => {
  const h = harness(t);
  h.ctx.runtime.getPresence = async () => { throw Error('observer failed'); };
  await h.ctx.refreshPresence(); assert.equal(h.ctx.statusRef.current, 'unknown'); assert.equal(h.ctx.resolving, false);
  h.ctx.runtime.getPresence = async () => ({ status: 'busy', inputReady: true });
  h.windowEvents.emit('focus'); await h.settle(); assert.equal(h.ctx.statusRef.current, 'busy');
});

test('late inactive read cannot undo the actual command-started event; retry preserves starting with inputReady', async t => {
  const h = harness(t), reader = controlledReader(); h.setReader(reader.read);
  const pending = h.ctx.refreshPresence();
  assert.equal(reader.calls.length, 1);

  h.ipc.emit('terminal:command-started', null, { tabId: 'T', commandType: 'claude' });
  assert.equal(h.ctx.statusRef.current, 'starting');
  assert.equal(h.ctx.presenceGenerationRef.current, 2);

  reader.calls[0].resolve({ status: 'inactive', inputReady: false });
  await reader.waitFor(2);
  assert.equal(h.ctx.statusRef.current, 'starting', 'obsolete inactive is discarded before it can enable Start/Resume');

  reader.calls[1].resolve({ status: 'starting', inputReady: true });
  await pending;
  assert.equal(h.ctx.statusRef.current, 'starting', 'inputReady does not fabricate active from the main-owned phase');
  assert.equal(h.ctx.resolving, false);
});

test('late busy read cannot undo command-finished; current inactive proof settles the flight', async t => {
  const h = harness(t), reader = controlledReader(); h.setReader(reader.read);
  const pending = h.ctx.refreshPresence();
  h.ipc.emit('terminal:command-finished', null, { tabId: 'T' });
  assert.equal(h.ctx.presenceGenerationRef.current, 2);

  reader.calls[0].resolve({ status: 'busy', inputReady: true });
  await reader.waitFor(2);
  assert.equal(h.ctx.statusRef.current, 'unknown', 'old busy cannot replace the post-finish state');

  reader.calls[1].resolve({ status: 'inactive', inputReady: false });
  await pending;
  assert.equal(h.ctx.statusRef.current, 'inactive');
  assert.equal(h.ctx.resolving, false);
});

test('a ready event invalidates the prior read and retains the current starting snapshot', async t => {
  const h = harness(t), reader = controlledReader(); h.setReader(reader.read);
  const pending = h.ctx.refreshPresence();
  h.ipc.emit('claude:tui-ready', null, { tabId: 'T' });
  assert.equal(h.ctx.presenceGenerationRef.current, 2);

  reader.calls[0].resolve({ status: 'inactive', inputReady: false });
  await reader.waitFor(2);
  reader.calls[1].resolve({ status: 'starting', inputReady: true });
  await pending;
  assert.equal(h.ctx.statusRef.current, 'starting');
});

test('late query failure after command-started retries instead of restoring unknown', async t => {
  const h = harness(t), reader = controlledReader(); h.setReader(reader.read);
  const pending = h.ctx.refreshPresence();
  h.ipc.emit('terminal:command-started', null, { tabId: 'T' });
  reader.calls[0].reject(new Error('old lookup failed'));
  await reader.waitFor(2);
  assert.equal(h.ctx.statusRef.current, 'starting');
  reader.calls[1].resolve({ status: 'starting', inputReady: true });
  await pending;
  assert.equal(h.ctx.statusRef.current, 'starting');
});

test('background wake recovers unknown; foreground focus while hidden does not start a read', async t => {
  const h = harness(t);
  h.setReader(async () => { throw Error('observer failed'); });
  await h.ctx.refreshPresence();
  assert.equal(h.ctx.statusRef.current, 'unknown');
  assert.equal(h.ctx.resolving, false);

  h.ctx.document.visibilityState = 'hidden';
  const readsBeforeHiddenFocus = h.reads();
  h.windowEvents.emit('focus');
  assert.equal(h.reads(), readsBeforeHiddenFocus);

  h.setReader(async () => ({ status: 'active', inputReady: true }));
  h.ipc.emit('agent:process-observation', null, { tabId: 'T', toolType: 'claude' });
  await h.settle();
  assert.equal(h.ctx.statusRef.current, 'active', 'the exact observation wake still serves a background-mounted History');
});

test('an old owner reply is ignored after History rebind and cannot clear the new owner flight', async t => {
  const h = harness(t), reader = controlledReader(); h.setReader(reader.read);
  const oldFlight = h.ctx.refreshPresence();
  h.ctx.presenceOwnerKey = 'T:claude:P2';
  h.ctx.presenceOwnerKeyRef.current = 'T:claude:P2';
  h.ctx.presenceGenerationRef.current += 1;
  const newFlight = h.ctx.refreshPresence();
  await reader.waitFor(2);

  reader.calls[0].resolve({ status: 'inactive', inputReady: false });
  await oldFlight;
  assert.equal(h.ctx.statusRef.current, 'unknown');
  assert.equal(h.ctx.presenceFlightRef.current?.ownerKey, 'T:claude:P2');
  assert.equal(h.ctx.resolving, true);

  reader.calls[1].resolve({ status: 'starting', inputReady: true });
  await newFlight;
  assert.equal(h.ctx.statusRef.current, 'starting');
  assert.equal(h.ctx.resolving, false);
});
