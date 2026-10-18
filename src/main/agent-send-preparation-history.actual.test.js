'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const { createRequire } = require('node:module');
const renderer = path.join(process.env.ACTUAL_SOURCE_DIR || __dirname, '../renderer');
const identity = { tabId: 'T', handoffId: 'H', toolType: 'codex', sendAttemptId: 'A',
  sendOperationKey: 'history:T:H', text: 'frozen', initialStatus: 'sending',
  authoringText: 'original author', authoringImagePaths: [{ assetId: 'original-image', path: '/controlled/A.png' }] };

async function fixture() {
  const filename = path.join(renderer, 'utils/historyPromptHandoffs.ts');
  const imports = {
    './historyPromptPresentation.mjs': await import('../renderer/utils/historyPromptPresentation.mjs'),
    './agentLocalCommand.mjs': await import('../renderer/utils/agentLocalCommand.mjs'),
  };
  const module = { exports: {} }, actualRequire = createRequire(path.join(__dirname, '../renderer/utils/historyPromptHandoffs.ts'));
  const context = vm.createContext({ module, exports: module.exports,
    require: name => imports[name] || actualRequire(name), console: { log() {}, warn() {} } });
  vm.runInContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const api = module.exports, store = new api.HistoryPromptHandoffStore();
  store.begin(identity);
  return { api, store, context };
}

test('actual renderer handoff already hydrated with A stays Preparing during its same accepted send', async () => {
  const h = await fixture(); let release;
  const input = new Promise(resolve => { release = resolve; });
  const pending = h.api.runHistoryPromptHandoff({ ...identity, initialStatus: 'preparing', send: () => input }, h.store);
  const row = h.store.getSnapshot('T')[0];
  assert.equal(row.queueStatus, 'preparing'); assert.equal(row.sendAttemptId, 'A');
  assert.equal(row.authoringText, identity.authoringText);
  assert.equal(row.authoringImagePaths[0].assetId, 'original-image');
  h.store.advanceTransportPhase('T', 'H', 'sending'); assert.equal(h.store.getSnapshot('T')[0].queueStatus, 'sending');
  h.store.advanceTransportPhase('T', 'H', 'confirming');
  h.store.advanceTransportPhase('T', 'H', 'preparing');
  assert.equal(h.store.getSnapshot('T')[0].queueStatus, 'audit-pending', 'late preparation cannot erase possible Enter');
  release({ success: null, submitted: null, deliveryUnknown: true, status: 'delivery-unknown' }); await pending;
  assert.equal(h.store.getSnapshot('T')[0].queueStatus, 'delivery-unknown');
});

test('actual History paste-busy projection accepts only its exact H/O/A preparation and preserves a replacement attempt', async () => {
  const h = await fixture();
  const source = fs.readFileSync(path.join(renderer, 'components/Workspace/HistoryPanel.tsx'), 'utf8');
  const ast = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = n => { if (ts.isVariableDeclaration(n) && n.name.getText(ast) === 'handlePasteBusy') callback = n.initializer.getText(ast); ts.forEachChild(n, visit); };
  visit(ast); assert.ok(callback);
  const handlerContext = vm.createContext({ tabId: 'T', runtime: { logPrefix: 'History' }, pasteBusyRef: { current: false },
    getHistoryPromptHandoffsSnapshot: tab => h.store.getSnapshot(tab),
    historyPromptHandoffAcceptsAuditIdentity: h.api.historyPromptHandoffAcceptsAuditIdentity,
    advanceHistoryPromptHandoffTransportPhase: (...args) => h.store.advanceTransportPhase(...args),
    setPasteActivityStartedAt() {}, setIsPasteBusy() {}, refreshActivityTiming: async () => {}, console: { log() {} } });
  vm.runInContext(ts.transpileModule('globalThis.handle = ' + callback, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, handlerContext);
  handlerContext.handle(null, { tabId: 'T', handoffId: 'H', sendAttemptId: 'A', sendOperationKey: 'history:T:H', busy: true, phase: 'preparing' });
  assert.equal(h.store.getSnapshot('T')[0].queueStatus, 'preparing');
  h.store.begin({ ...identity, sendAttemptId: 'B', initialStatus: 'preparing' });
  handlerContext.handle(null, { tabId: 'T', handoffId: 'H', sendAttemptId: 'A', sendOperationKey: 'history:T:H', busy: true, phase: 'sending' });
  assert.equal(h.store.getSnapshot('T')[0].queueStatus, 'preparing');
  assert.equal(h.store.getSnapshot('T')[0].sendAttemptId, 'B');
});

test('actual cancelled History H cannot be revived by preparation or later transport phases', async () => {
  const h = await fixture();
  h.store.settle('T', 'H', { queueStatus: 'cancelled', reason: 'send-cancelled-before-submit', sendAttemptId: 'A', sendOperationKey: 'history:T:H' });
  for (const phase of ['preparing', 'sending', 'confirming']) h.store.advanceTransportPhase('T', 'H', phase);
  assert.equal(h.store.getSnapshot('T')[0].queueStatus, 'cancelled');
});
