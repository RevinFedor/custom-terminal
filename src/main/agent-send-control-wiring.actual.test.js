'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const declaration = name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
};
const handler = name => {
  const node = ast.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
    && n.expression.expression.getText(ast) === 'ipcMain.handle' && n.expression.arguments[0]?.text === name);
  assert.ok(node, name); return node.getText(ast);
};
const quiet = { log() {}, warn() {}, error() {} };
const input = { operationKey: 'history:T:H', tabId: 'T', handoffId: 'H', surface: 'desktop-history',
  provider: 'codex', sessionId: 'S', requestFingerprint: 'request', promptHash: 'prompt', promptLength: 6 };

function runtimeHarness() {
  let generation = 'G2', revision = 7, coherent = true, processStatus = 'found', reads = 0;
  const sdkSessions = new Map(), terminalCommandState = new Map([['T', { runSeq: 2, isRunning: true }]]);
  const ctx = vm.createContext({ console: quiet, path, srcMainDir: __dirname, require, sdkSessions,
    terminalCommandState, captureAiProcessLookupScope: () => ({ generation }),
    aiProcessLookupScopeCurrent: (_tab, scope) => scope.generation === generation,
    getTerminalInputRevision: () => revision, getTerminalLifecycleGeneration: () => generation,
    readMainPublicRuntimeSnapshot: async () => { reads++; return { coherent, processStatus,
      lifecycleGeneration: generation, terminalRunSeq: 2, inputRevision: revision, inputReady: true }; },
  });
  vm.runInContext(declaration('readMainSendInputSlot'), ctx);
  return { ctx, reads: () => reads, sdkSessions,
    change: patch => { generation = patch.generation ?? generation; revision = patch.revision ?? revision;
      coherent = patch.coherent ?? coherent; processStatus = patch.processStatus ?? processStatus; } };
}

test('actual Main slot reader uses coherent runtime and rechecks owner/input after await', async () => {
  const h = runtimeHarness();
  const result = await h.ctx.readMainSendInputSlot(input);
  assert.equal(result.known, true); assert.equal(result.ownerStable, true);
  assert.equal(result.isCurrent(), true);
  h.change({ revision: 8 }); assert.equal(result.isCurrent(), false);
  const next = await h.ctx.readMainSendInputSlot(input);
  h.change({ generation: 'G3' }); assert.equal(next.isCurrent(), false);
  h.change({ coherent: false }); assert.equal((await h.ctx.readMainSendInputSlot(input)).known, false);
  h.change({ coherent: true, processStatus: 'unknown' }); assert.equal((await h.ctx.readMainSendInputSlot(input)).known, false);
});

test('actual Main slot reader cannot add history/process scans to same-owner runtime events or SDK', async () => {
  const h = runtimeHarness();
  const record = { ...input, inputLease: { version: 1, lifecycleGeneration: 'G2', runSeq: 2 } };
  assert.equal((await h.ctx.readMainSendInputSlot(record)).known, false);
  h.sdkSessions.set('T', {});
  assert.equal((await h.ctx.readMainSendInputSlot(input)).known, false);
  assert.equal(h.reads(), 0);
});

function ipcHarness(t) {
  const db = new Database(':memory:'), store = createAgentSendReceiptStore(db);
  const queue = new AgentSendQueue({ store, ready: () => false });
  const handlers = new Map(), memory = [];
  const web = { cancelQueuedAgentSends: (...args) => queue.cancelWaiting(...args),
    applicationQueueInfo: key => queue.queueInfo(key), projectQueuedSendReceipt: row => queue.projectRecord(row) };
  const ctx = vm.createContext({ console: quiet, path, srcMainDir: __dirname,
    require: id => { assert.equal(id, path.join(__dirname, 'web-server')); return web; },
    agentSendReceiptStore: store, agentSendReceiptStartupReady: Promise.resolve(),
    DESKTOP_HISTORY_SEND_SURFACE: 'desktop-history', imagePresentationFromReceipt: () => null,
    agentSendCancellations: { cancel: (...args) => { memory.push(args); return { cancelled: true }; }, clear: () => true },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) } });
  vm.runInContext(declaration('resolveAgentSendCancellationAttempt') + '\n'
    + ['agent:cancel-send', 'agent:clear-send-cancel', 'agent:list-send-receipts'].map(handler).join('\n'), ctx);
  t.after(() => { queue.dispose(); db.close(); });
  return { db, store, queue, memory, call: (name, args) => handlers.get(name)({}, args) };
}

test('actual cancel IPC persists exact intent; clearing process-local wait cannot undo it', async t => {
  const h = ipcHarness(t), start = h.store.beginAttempt(input);
  assert.equal(h.call('agent:cancel-send', { tabId: 'T', handoffId: 'H', sendAttemptId: 'stale' }).cancelled, false);
  assert.equal(h.memory.length, 0); assert.equal(h.store.isDeliveryCancelled(input.operationKey), false);
  assert.equal(h.call('agent:cancel-send', { tabId: 'T', handoffId: 'H' }).cancelled, true);
  assert.equal(h.memory[0][2].attemptId, start.attemptId);
  h.call('agent:clear-send-cancel', { tabId: 'T', handoffId: 'H' });
  assert.equal(h.store.isDeliveryCancelled(input.operationKey, start.attemptId), true);
  assert.equal(h.store.markAttemptState(input.operationKey, start.attemptId, 'enter-armed').ok, false);
});

test('late explicit attempt cancellation cannot cancel a current waiting item before identity validation', t => {
  const h = ipcHarness(t);
  h.queue.enqueue({ identity: input, request: { tabId: 'T', handoffId: 'H', provider: 'codex', prompt: 'prompt' } });
  assert.equal(h.call('agent:cancel-send', { tabId: 'T', handoffId: 'H', sendAttemptId: 'old-attempt' }).cancelled, false);
  assert.equal(h.queue.item(input.operationKey).state, 'waiting');
  assert.equal(h.store.isDeliveryCancelled(input.operationKey), false);
  assert.equal(h.call('agent:cancel-send', { tabId: 'T', handoffId: 'H' }).cancelled, true);
});

test('actual bounded list IPC preserves control and retired-slot fields through remount', async t => {
  const h = ipcHarness(t);
  h.queue.ready = () => true;
  h.queue.execute = async () => {
    const start = h.store.beginAttempt(input);
    h.store.markAttemptState(input.operationKey, start.attemptId, 'enter-armed');
    h.store.settleAttempt(input.operationKey, start.attemptId, { submitted: true, status: 'delivery-unknown' });
  };
  h.queue.enqueue({ identity: input, request: { tabId: 'T', handoffId: 'H', provider: 'codex', prompt: 'prompt' } });
  await new Promise(resolve => setImmediate(resolve));
  const start = h.store.get(input.operationKey);
  h.queue.cancelDelivery('T', 'H');
  await h.queue.retireObsoleteInputSlot('T');
  const result = await h.call('agent:list-send-receipts', { tabId: 'T', handoffId: 'H' });
  assert.equal(result.records.length, 1);
  assert.ok(result.records[0].deliveryControl.cancelledAt);
  assert.equal(result.records[0].inputSlot.state, 'retired');
  assert.equal(result.records[0].attemptId, start.attemptId);
  assert.equal(result.records[0].state, 'delivery-unknown');
});
